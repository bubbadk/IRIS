//! The trusted navigation boundary for the automated browser.
//!
//! Chromium performs its own DNS lookups and follows redirects inside its network stack, and the
//! ChromeDriver CDP bridge is command-only (no event stream), so a per-request interception hook
//! does not exist: `Network.setBlockedURLs` issued through `goog/cdp/execute` was measured to have
//! no effect on WebDriver-initiated navigations. A hostname preflight in `browser.rs` would
//! therefore leave a real TOCTOU window between validation and the connection Chromium actually
//! opens, and would not see redirect targets or subresource requests at all.
//!
//! So the browser is launched with `--proxy-server` pointed at this loopback proxy and with the
//! implicit loopback bypass removed. Every HTTP request and every TLS tunnel the browser makes is
//! then resolved, validated and *pinned* here through [`crate::web_policy`]:
//!
//! * a host name is resolved once, every answer must be public, and the socket is opened to one of
//!   those validated addresses — never re-resolved after validation, so DNS rebinding has no window;
//! * each redirect hop arrives as its own proxy request and is validated on its own;
//! * a request that fails the policy is answered with an explicit refusal and no upstream socket is
//!   ever opened, so no packet reaches the forbidden network.
//!
//! The proxy never terminates TLS, so the browser keeps its own certificate validation.
use crate::web_policy::{parse_web_url, validate_public_addresses, BLOCKED_DESTINATION};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
#[cfg(test)]
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const HEAD_LIMIT: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(120);

/// Deterministic test hooks for the proxy's own suite.
///
/// In a release build this type has **no fields at all**: a trusted host or a fake resolver cannot
/// be configured, so [`NavigationProxy::start`] is unconditionally strict. The fields exist only in
/// test compilations, which is also the only place [`NavigationProxy::start_for_tests`] exists.
#[derive(Clone, Default)]
pub struct ProxyOverrides {
    #[cfg(test)]
    trusted_hosts: Vec<String>,
    #[cfg(test)]
    resolver: Option<Arc<dyn Fn(&str, u16) -> Vec<SocketAddr> + Send + Sync>>,
}

impl ProxyOverrides {
    #[cfg(test)]
    /// Trusts exactly these host names (used to drive the proxy against a loopback origin) and
    /// resolves every other host through `resolver` instead of real DNS.
    pub fn with_trusted_hosts(
        trusted_hosts: Vec<String>,
        resolver: Option<Arc<dyn Fn(&str, u16) -> Vec<SocketAddr> + Send + Sync>>,
    ) -> Self {
        Self {
            trusted_hosts,
            resolver,
        }
    }

    /// Always false in a release build: the trusted-host field does not exist there.
    pub fn trusts(&self, host: &str) -> bool {
        #[cfg(test)]
        {
            self.trusted_hosts
                .iter()
                .any(|trusted| trusted.eq_ignore_ascii_case(host))
        }
        #[cfg(not(test))]
        {
            let _ = host;
            false
        }
    }
}

/// Owns the loopback listener and its worker thread for exactly as long as a browser session.
pub struct NavigationProxy {
    port: u16,
    stop: Arc<AtomicBool>,
    _overrides: ProxyOverrides,
    worker: Option<JoinHandle<()>>,
}

impl NavigationProxy {
    /// Starts the strict proxy used by every production browser session.
    pub fn start() -> Result<Self, String> {
        Self::start_with(ProxyOverrides::default())
    }

    #[cfg(test)]
    pub fn start_for_tests(overrides: ProxyOverrides) -> Result<Self, String> {
        Self::start_with(overrides)
    }

    fn start_with(overrides: ProxyOverrides) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("Could not start the IRIS browser network policy: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not read the browser policy port: {error}"))?
            .port();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_overrides = overrides.clone();
        let worker = std::thread::Builder::new()
            .name("iris-navigation-policy".to_string())
            .spawn(move || {
                for incoming in listener.incoming() {
                    if worker_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = incoming else { continue };
                    let connection_overrides = worker_overrides.clone();
                    let _ = std::thread::Builder::new()
                        .name("iris-navigation-policy-connection".to_string())
                        .spawn(move || serve_connection(stream, &connection_overrides));
                }
            })
            .map_err(|error| format!("Could not start the IRIS browser network policy: {error}"))?;
        Ok(Self {
            port,
            stop,
            _overrides: overrides,
            worker: Some(worker),
        })
    }

    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether this session's policy was explicitly relaxed for a test harness. Always false in a
    /// release build, so the production gates stay strict.
    pub fn trusts_host(&self, host: &str) -> bool {
        self._overrides.trusts(host)
    }

    /// The Chrome flags that make this process the browser's only route to the network.
    pub fn chrome_args(&self) -> Vec<String> {
        vec![
            format!("--proxy-server=http://127.0.0.1:{}", self.port),
            // Chrome bypasses proxies for loopback by default; that implicit bypass would let the
            // browser reach local services directly. `<-loopback>` removes it.
            "--proxy-bypass-list=<-loopback>".to_string(),
            // No speculative DNS outside the proxy, and no stray direct connections.
            "--dns-prefetch-disable".to_string(),
        ]
    }
}

impl Drop for NavigationProxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock `accept` so the worker notices the stop flag and exits.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn read_head(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while head.len() < HEAD_LIMIT {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            break;
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return Ok(head);
        }
    }
    if head.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "empty request",
        ));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "oversized request head",
    ))
}

/// A parsed proxy request: either a TLS tunnel target or an absolute-form plain-HTTP request.
#[derive(Debug, PartialEq, Eq)]
enum ProxyRequest {
    Tunnel { host: String, port: u16 },
    Plain { authority: String, path: String },
}

fn parse_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    if authority.is_empty() {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            Some((host.to_string(), port.parse().ok()?))
        }
        _ => Some((authority.to_string(), default_port)),
    }
}

fn parse_proxy_request(head: &[u8]) -> Result<ProxyRequest, String> {
    let text = String::from_utf8_lossy(head);
    let request_line = text.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return Err("Malformed proxy request.".into());
    }
    if method == "CONNECT" {
        let (host, port) = parse_authority(&target, 443)
            .ok_or_else(|| "Malformed proxy tunnel target.".to_string())?;
        return Ok(ProxyRequest::Tunnel { host, port });
    }
    // A non-tunnel request through a proxy must use absolute form. Anything else (origin-form,
    // authority-form, `*`) carries no validated destination and is refused.
    if !target.starts_with("http://") {
        return Err("Proxy requests must use an absolute public http:// address.".into());
    }
    let url = parse_web_url(&target)?;
    let host = url
        .host_str()
        .ok_or_else(|| "Proxy request has no host.".to_string())?;
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    Ok(ProxyRequest::Plain { authority, path })
}

fn response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nX-IRIS-Network-Policy: blocked\r\n\r\n{body}",
        body.len()
    )
}

fn policy_refusal() -> String {
    response("403 Forbidden", BLOCKED_DESTINATION)
}

fn resolve_overrides(host: &str, port: u16, overrides: &ProxyOverrides) -> Option<Vec<SocketAddr>> {
    #[cfg(test)]
    {
        overrides
            .resolver
            .as_ref()
            .map(|resolver| resolver(host, port))
    }
    #[cfg(not(test))]
    {
        let _ = (host, port, overrides);
        None
    }
}

/// Resolves, validates and connects to a pinned address. Never re-resolves after validation.
fn connect_pinned(
    host: &str,
    port: u16,
    overrides: &ProxyOverrides,
) -> Result<TcpStream, String> {
    #[cfg(test)]
    if overrides.trusts(host) {
        let addresses = resolve_overrides(host, port, overrides).unwrap_or_else(|| {
            host.parse::<IpAddr>()
                .map(|ip| vec![SocketAddr::new(ip, port)])
                .unwrap_or_default()
        });
        return connect_first(&addresses);
    }
    if let Some(addresses) = resolve_overrides(host, port, overrides) {
        // Deterministic fake DNS for the proxy's own tests: still fully policy-checked.
        return connect_first(&validate_public_addresses(addresses)?);
    }
    connect_first(&crate::web_policy::resolve_public_addresses(host, port)?)
}

fn connect_first(addresses: &[SocketAddr]) -> Result<TcpStream, String> {
    let mut last: Option<std::io::Error> = None;
    for address in addresses {
        match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(format!(
        "The web address could not be reached: {}",
        last.map(|error| error.to_string())
            .unwrap_or_else(|| "no usable address".to_string())
    ))
}

fn serve_connection(mut client: TcpStream, overrides: &ProxyOverrides) {
    let _ = client.set_read_timeout(Some(IO_TIMEOUT));
    let _ = client.set_write_timeout(Some(IO_TIMEOUT));
    let Ok(head) = read_head(&mut client) else {
        return;
    };
    let request = match parse_proxy_request(&head) {
        Ok(request) => request,
        Err(reason) => {
            let _ = client.write_all(response("403 Forbidden", &reason).as_bytes());
            return;
        }
    };
    let head_text = String::from_utf8_lossy(&head).to_string();
    match request {
        ProxyRequest::Tunnel { host, port } => {
            let Ok(upstream) = connect_pinned(&host, port, overrides) else {
                let _ = client.write_all(policy_refusal().as_bytes());
                return;
            };
            if client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .is_err()
            {
                return;
            }
            pipe(client, upstream);
        }
        ProxyRequest::Plain { authority, path } => {
            let host = parse_authority(&authority, 80)
                .map(|(host, _)| host)
                .unwrap_or_default();
            let port = parse_authority(&authority, 80)
                .map(|(_, port)| port)
                .unwrap_or(80);
            let Ok(mut upstream) = connect_pinned(&host, port, overrides) else {
                let _ = client.write_all(policy_refusal().as_bytes());
                return;
            };
            // Rebuild the request in origin form for the upstream server, pinning the connection to
            // the validated address. `Connection: close` binds one validated destination to one
            // client connection, so a later request can never be forwarded to this upstream.
            let forwarded = rewrite_plain_head(&head_text, &path, &authority);
            if upstream.write_all(forwarded.as_bytes()).is_err() {
                return;
            }
            let _ = upstream.set_read_timeout(Some(IO_TIMEOUT));
            let _ = upstream.set_write_timeout(Some(IO_TIMEOUT));
            pipe(client, upstream);
        }
    }
}

fn rewrite_plain_head(head: &str, path: &str, authority: &str) -> String {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or("GET")
        .to_string();
    let mut out = format!("{method} {path} HTTP/1.1\r\n");
    let mut has_host = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, _)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("proxy-connection") {
            continue;
        }
        if name.trim().eq_ignore_ascii_case("host") {
            has_host = true;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    if !has_host {
        out.push_str(&format!("Host: {authority}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

/// Copies bytes both ways until either side closes, then tears both sockets down.
fn pipe(client: TcpStream, upstream: TcpStream) {
    let (Ok(mut client_read), Ok(mut client_write)) = (client.try_clone(), client.try_clone())
    else {
        return;
    };
    let (Ok(mut upstream_read), Ok(mut upstream_write)) =
        (upstream.try_clone(), upstream.try_clone())
    else {
        return;
    };
    let forward = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream_read, &mut client_write);
    let _ = client_write.shutdown(Shutdown::Write);
    let _ = forward.join();
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_policy::public_ip;
    use std::net::Ipv4Addr;

    fn fake_resolver(
        resolver: impl Fn(&str, u16) -> Vec<SocketAddr> + Send + Sync + 'static,
    ) -> Arc<dyn Fn(&str, u16) -> Vec<SocketAddr> + Send + Sync> {
        Arc::new(resolver)
    }

    #[test]
    fn release_overrides_cannot_trust_a_host() {
        // The strict entry point always uses the empty override set.
        let strict = ProxyOverrides::default();
        assert!(!strict.trusts("127.0.0.1"));
        assert!(!strict.trusts("localhost"));
    }

    #[test]
    fn parses_tunnel_and_absolute_form_targets() {
        assert_eq!(
            parse_proxy_request(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n").unwrap(),
            ProxyRequest::Tunnel {
                host: "example.com".into(),
                port: 443
            }
        );
        assert_eq!(
            parse_proxy_request(b"CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n").unwrap(),
            ProxyRequest::Tunnel {
                host: "2606:4700::1111".into(),
                port: 443
            }
        );
        assert_eq!(
            parse_proxy_request(b"GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .unwrap(),
            ProxyRequest::Plain {
                authority: "example.com".into(),
                path: "/a?b=1".into()
            }
        );
    }

    #[test]
    fn refuses_targets_that_carry_no_structurally_valid_destination() {
        for head in [
            &b"GET /origin-form HTTP/1.1\r\nHost: example.com\r\n\r\n"[..],
            &b"GET ftp://example.com/ HTTP/1.1\r\n\r\n"[..],
            &b"GET http://user:pass@example.com/ HTTP/1.1\r\n\r\n"[..],
            &b"GET http://localhost/ HTTP/1.1\r\n\r\n"[..],
            &b"GET http://localhost:8080/ HTTP/1.1\r\n\r\n"[..],
            &b"GET http://nas.local/ HTTP/1.1\r\n\r\n"[..],
            &b"GET data:text/html,hi HTTP/1.1\r\n\r\n"[..],
            &b"GET file:///etc/passwd HTTP/1.1\r\n\r\n"[..],
        ] {
            assert!(parse_proxy_request(head).is_err(), "{head:?}");
        }
    }

    #[test]
    fn refuses_the_whole_literal_destination_matrix() {
        // Every one of these is refused by the address policy before an upstream socket exists.
        let proxy = NavigationProxy::start().unwrap();
        for target in [
            "http://127.0.0.1/",
            "http://127.1.2.3/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://10.0.0.5/",
            "http://172.16.4.4/",
            "http://172.31.255.254/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://192.0.0.5/",
            "http://198.18.0.1/",
            "http://224.0.0.1/",
        ] {
            let response = send_raw(
                proxy.port(),
                &format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n"),
            );
            assert!(response.contains("403"), "{target} => {response}");
            let authority = target.trim_start_matches("http://").trim_end_matches('/');
            let tunnel = send_raw(
                proxy.port(),
                &format!("CONNECT {authority}:443 HTTP/1.1\r\n\r\n"),
            );
            assert!(tunnel.contains("403"), "CONNECT {authority} => {tunnel}");
        }
    }

    #[test]
    fn rewrites_absolute_form_requests_and_drops_proxy_headers() {
        let head = "GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n";
        let rewritten = rewrite_plain_head(head, "/x", "example.com");
        assert!(rewritten.starts_with("GET /x HTTP/1.1\r\n"));
        assert!(!rewritten.to_ascii_lowercase().contains("proxy-connection"));
        assert!(rewritten.contains("Host: example.com\r\n"));
        assert!(rewritten.ends_with("Connection: close\r\n\r\n"));
    }

    fn send_raw(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }

    #[test]
    fn refuses_loopback_tunnels_without_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = listener.local_addr().unwrap();
        let proxy = NavigationProxy::start().unwrap();
        let response = send_raw(
            proxy.port(),
            &format!("CONNECT 127.0.0.1:{} HTTP/1.1\r\n\r\n", target.port()),
        );
        assert!(response.contains("403"), "{response}");
        assert!(response.contains("network policy"), "{response}");
        // No upstream connection was attempted: the accept queue stays empty.
        listener.set_nonblocking(true).unwrap();
        assert!(listener.accept().is_err());
    }

    #[test]
    fn refuses_private_plain_requests_without_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = NavigationProxy::start().unwrap();
        let response = send_raw(
            proxy.port(),
            &format!("GET http://10.11.12.13:{port}/ HTTP/1.1\r\nHost: 10.11.12.13\r\n\r\n"),
        );
        assert!(response.contains("403"), "{response}");
        listener.set_nonblocking(true).unwrap();
        assert!(listener.accept().is_err());
    }

    #[test]
    fn refuses_metadata_service_and_special_ranges_without_connecting() {
        let proxy = NavigationProxy::start().unwrap();
        for target in [
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.10.10/",
            "http://192.0.0.5/",
            "http://198.18.0.1/",
            "http://224.0.0.1/",
            "http://0.0.0.0/",
        ] {
            let response = send_raw(
                proxy.port(),
                &format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n"),
            );
            assert!(response.contains("403"), "{target} => {response}");
        }
    }

    #[test]
    fn rejects_a_hostname_that_resolves_to_a_private_address() {
        // Attack C: the DNS answer is a private address. The proxy validates the resolved address
        // and refuses before opening any socket.
        let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
            Vec::new(),
            Some(fake_resolver(|_host: &str, port: u16| {
                vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))]
            })),
        ))
        .unwrap();
        let response = send_raw(
            proxy.port(),
            "GET http://rebind.example/ HTTP/1.1\r\nHost: rebind.example\r\n\r\n",
        );
        assert!(response.contains("403"), "{response}");
        let tunnel = send_raw(proxy.port(), "CONNECT rebind.example:443 HTTP/1.1\r\n\r\n");
        assert!(tunnel.contains("403"), "{tunnel}");
        assert!(!public_ip(Ipv4Addr::LOCALHOST.into()));
    }

    #[test]
    fn rejects_a_host_with_one_public_and_one_private_answer() {
        let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
            Vec::new(),
            Some(fake_resolver(|_host: &str, port: u16| {
                vec![
                    SocketAddr::from((Ipv4Addr::new(93, 184, 216, 34), port)),
                    SocketAddr::from((Ipv4Addr::new(10, 0, 0, 7), port)),
                ]
            })),
        ))
        .unwrap();
        let response = send_raw(
            proxy.port(),
            "GET http://mixed.example/ HTTP/1.1\r\nHost: mixed.example\r\n\r\n",
        );
        assert!(response.contains("403"), "{response}");
    }

    #[test]
    fn validates_each_redirect_hop_independently() {
        // public origin -> private redirect: hop one is answered by the local test origin, and hop
        // two is refused because it resolves to the metadata address. That address is never
        // contacted; the refusal is produced from the policy alone.
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = origin.accept() {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let response = "HTTP/1.1 302 Found\r\nLocation: http://metadata.example/latest/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
            vec!["127.0.0.1".into()],
            Some(fake_resolver(|host: &str, port: u16| {
                if host == "metadata.example" {
                    vec![SocketAddr::from((
                        Ipv4Addr::new(169, 254, 169, 254),
                        port,
                    ))]
                } else {
                    vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))]
                }
            })),
        ))
        .unwrap();
        let first = send_raw(
            proxy.port(),
            &format!("GET http://127.0.0.1:{origin_port}/start HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
        );
        assert!(first.contains("302"), "{first}");
        assert!(first.contains("metadata.example"), "{first}");
        server.join().unwrap();
        let second = send_raw(
            proxy.port(),
            "GET http://metadata.example/latest/ HTTP/1.1\r\nHost: metadata.example\r\n\r\n",
        );
        assert!(second.contains("403"), "{second}");
    }

    #[test]
    fn forwards_an_allowed_plain_request_and_keeps_the_connection_bound() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = origin.accept() {
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = "hello from the allowed origin";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                return request;
            }
            String::new()
        });
        let proxy = NavigationProxy::start_for_tests(ProxyOverrides::with_trusted_hosts(
            vec!["127.0.0.1".into()],
            None,
        ))
        .unwrap();
        let response = send_raw(
            proxy.port(),
            &format!("GET http://127.0.0.1:{origin_port}/allowed HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Connection: keep-alive\r\n\r\n"),
        );
        assert!(response.contains("hello from the allowed origin"), "{response}");
        let forwarded = server.join().unwrap();
        assert!(forwarded.starts_with("GET /allowed HTTP/1.1\r\n"), "{forwarded}");
        assert!(forwarded.contains("Connection: close"), "{forwarded}");
    }

    #[test]
    #[ignore = "Requires live public internet access"]
    fn live_forwards_public_https_and_blocks_loopback() {
        let proxy = NavigationProxy::start().unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut buffer = [0u8; 128];
        let read = stream.read(&mut buffer).unwrap();
        let response = String::from_utf8_lossy(&buffer[..read]).to_string();
        assert!(response.contains("200 Connection Established"), "{response}");
    }
}
