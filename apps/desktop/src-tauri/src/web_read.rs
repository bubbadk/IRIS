//! Bounded public-web GET transport for the permission-gated web tools. No cookies or credentials.
//!
//! Address and URL validation live in [`crate::web_policy`] — the one outbound-web policy shared
//! with browser navigation — so this reader can never be weaker (or stronger) than the browser.
//!
//! Every hop rebuilds its request URL on the canonical host before it resolves, pins and sends, so
//! the key used by `reqwest`'s `resolve_to_addrs` override is byte-identical to the host the
//! transport looks up at connect time. A spelling mismatch (for example `example.com.`) can
//! therefore not make the pin miss and hand the connection to a fresh, unvalidated DNS answer.
use crate::web_policy::{
    canonicalize_url_host, normalize_host, parse_public_url, resolve_public_addresses,
};
use reqwest::dns::Resolve;
use reqwest::{redirect::Policy, Url};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

const BODY_LIMIT: usize = 2 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebReadResult {
    status: u16,
    body: String,
    content_type: String,
}

/// Resolves one hop's canonical host into validated addresses. Production passes
/// [`resolve_public_addresses`], which refuses the whole lookup unless every answer is a public
/// address. Tests inject a deterministic resolver so the pin/transport identity can be observed
/// without real DNS or a real network.
async fn read<F>(
    mut url: Url,
    resolve: F,
    fallback_dns: Option<Arc<dyn Resolve>>,
) -> Result<WebReadResult, String>
where
    F: Fn(&str, u16) -> Result<Vec<SocketAddr>, String> + Send + Sync + Clone + 'static,
{
    for _ in 0..6 {
        // One canonical authority per hop. `canonicalize_url_host` is idempotent, so the URL that
        // arrived from the policy (already canonical) is unchanged; reconstructing it here keeps
        // the invariant local to the code that pins and sends.
        url = canonicalize_url_host(&url)?;
        let host = normalize_host(url.host_str().unwrap_or_default());
        let port = url.port_or_known_default().unwrap();
        // Resolve once, refuse unless every answer is public, then pin those exact addresses to
        // the request so a second lookup cannot rebind the connection. `host` is the pin key and
        // `url` above carries exactly that host, so the pin cannot be missed.
        let lookup_host = host.clone();
        let resolve_hop = resolve.clone();
        let addresses: Vec<SocketAddr> =
            tokio::task::spawn_blocking(move || resolve_hop(&lookup_host, port))
                .await
                .map_err(|_| "The web address lookup failed.".to_string())??;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(&host, &addresses)
            .redirect(Policy::none())
            .timeout(Duration::from_secs(20))
            .user_agent("IRIS-WebReader/0.2");
        // Test-only seam. Production leaves the system resolver in place — which is exactly the
        // fallback a pin miss would silently use. Tests supply a recording resolver so that a
        // miss becomes observable instead of depending on a real second DNS lookup.
        if let Some(fallback) = fallback_dns.clone() {
            builder = builder.dns_resolver(fallback);
        }
        let client = builder
            .build()
            .map_err(|_| "The web reader could not start.")?;
        let mut response = client.get(url.clone()).header("accept", "text/html,application/xhtml+xml,text/plain,application/json;q=0.9")
            .send().await.map_err(|_| "The website could not be reached securely. Check the address and network connection.")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("The website returned a redirect without a valid destination.")?;
            let next = url
                .join(location)
                .map_err(|_| "The website returned an invalid redirect.")?;
            let next = parse_public_url(next.as_str())?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err("The website redirected to an insecure connection.".into());
            }
            url = next;
            continue;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/plain")
            .to_string();
        if response
            .content_length()
            .is_some_and(|length| length > BODY_LIMIT as u64)
        {
            return Err("The webpage exceeds the 2 MiB reading limit.".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The webpage could not be read completely.")?
        {
            if body.len() + chunk.len() > BODY_LIMIT {
                return Err("The webpage exceeds the 2 MiB reading limit.".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(WebReadResult {
            status,
            content_type,
            body: String::from_utf8_lossy(&body).into_owned(),
        });
    }
    Err("The website redirected too many times.".into())
}
#[tauri::command]
pub async fn web_read_public_page(url: String) -> Result<WebReadResult, String> {
    let url = parse_public_url(&url)?;
    tokio::time::timeout(
        Duration::from_secs(20),
        read(url, resolve_public_addresses, None),
    )
    .await
    .map_err(|_| "The web request timed out after 20 seconds.".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_policy::{public_ip, validate_public_addresses, BLOCKED_DESTINATION};
    use reqwest::dns::{Addrs, Name, Resolving};
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::Mutex;
    use std::thread;

    /// A resolver that records every host it is asked about, then answers with one address.
    /// Used as the client's *fallback* resolver: it is only ever consulted if the pin misses.
    #[derive(Clone)]
    struct RecordingResolver {
        calls: Arc<Mutex<Vec<String>>>,
        answer: SocketAddr,
    }

    impl Resolve for RecordingResolver {
        fn resolve(&self, name: Name) -> Resolving {
            self.calls
                .lock()
                .unwrap()
                .push(name.as_str().to_string());
            let answer = self.answer;
            Box::pin(std::future::ready(Ok(
                Box::new(std::iter::once(answer)) as Addrs
            )))
        }
    }

    enum Reply {
        Body(&'static str),
        Redirect(String),
    }

    /// Loopback HTTP origin: records the raw request head, then replies `count` times.
    fn spawn_origin(address: SocketAddr, reply: Reply, count: usize) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let listener = TcpListener::bind(address).expect("bind mock origin");
        thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buffer[..read]).to_string());
                let response = match &reply {
                    Reply::Body(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    Reply::Redirect(location) => format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    ),
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        seen
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn loopback(port: u16, last_octet: u8) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::new(127, 0, 0, last_octet), port))
    }

    /// Case A/B/C/F — every equivalent spelling of one authority is reduced to a single identity:
    /// the resolver is asked only for the canonical host, the pinned address is the one connected,
    /// and the fallback resolver a pin miss would use is never consulted.
    #[test]
    fn canonical_host_governs_the_socket_for_every_equivalent_spelling() {
        tauri::async_runtime::block_on(async {
            let port = free_port();
            let pinned = loopback(port, 1);
            // The decoy is a second origin on its own port rather than a second loopback address:
            // macOS assigns only 127.0.0.1 to the loopback interface, so binding 127.0.0.2 fails
            // there with `AddrNotAvailable`.
            let decoy = loopback(free_port(), 1);
            let pinned_seen = spawn_origin(pinned, Reply::Body("PIN-ORIGIN"), 8);
            let decoy_seen = spawn_origin(decoy, Reply::Body("DECOY-REBIND"), 4);

            let resolved_hosts = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&resolved_hosts);
            let resolve = move |host: &str, port: u16| {
                recorded.lock().unwrap().push(format!("{host}:{port}"));
                Ok(vec![SocketAddr::new(pinned.ip(), port)])
            };
            let fallback_calls = Arc::new(Mutex::new(Vec::new()));
            let fallback = Arc::new(RecordingResolver {
                calls: Arc::clone(&fallback_calls),
                answer: decoy,
            });

            for spelling in [
                format!("http://example.com:{port}/probe"),
                format!("http://example.com.:{port}/probe"),
                format!("http://Example.COM.:{port}/probe"),
            ] {
                let parsed = parse_public_url(&spelling).expect("the policy accepts the spelling");
                let result = read(parsed, resolve.clone(), Some(fallback.clone()))
                    .await
                    .expect("the pinned request succeeds");
                assert_eq!(result.body, "PIN-ORIGIN", "{spelling}");
            }

            assert_eq!(
                *resolved_hosts.lock().unwrap(),
                vec![format!("example.com:{port}"); 3],
                "resolution must be asked for the canonical host only"
            );
            assert!(
                fallback_calls.lock().unwrap().is_empty(),
                "a pin miss would have consulted the fallback resolver"
            );
            let requests = pinned_seen.lock().unwrap().clone();
            assert_eq!(requests.len(), 3);
            for request in requests {
                let lower = request.to_ascii_lowercase();
                assert!(
                    lower.contains(&format!("host: example.com:{port}")),
                    "the transport must send the canonical host: {request:?}"
                );
                assert!(
                    !lower.contains("example.com."),
                    "no non-canonical spelling may reach the transport: {request:?}"
                );
            }
            assert_eq!(decoy_seen.lock().unwrap().len(), 0, "the decoy origin must stay untouched");
        });
    }

    /// Case F — a DNS answer that changes after validation cannot move the connection: the second
    /// answer is never requested, because the connection uses the pinned address.
    #[test]
    fn a_dns_answer_that_changes_after_validation_cannot_rebind_the_connection() {
        tauri::async_runtime::block_on(async {
            let port = free_port();
            let pinned = loopback(port, 1);
            // See the note above: a distinct port keeps this bindable on macOS.
            let decoy = loopback(free_port(), 1);
            let pinned_seen = spawn_origin(pinned, Reply::Body("PIN-ORIGIN"), 2);
            let decoy_seen = spawn_origin(decoy, Reply::Body("DECOY-REBIND"), 2);

            let lookups = Arc::new(Mutex::new(0usize));
            let counted = Arc::clone(&lookups);
            // First answer public/pinned, every later answer the rebinding decoy.
            let resolve = move |_host: &str, port: u16| {
                let mut count = counted.lock().unwrap();
                *count += 1;
                if *count == 1 {
                    Ok(vec![SocketAddr::new(pinned.ip(), port)])
                } else {
                    // The rebound answer is the decoy's own endpoint, which shares 127.0.0.1 but
                    // differs by port, so it stays distinguishable on every platform.
                    Ok(vec![decoy])
                }
            };
            let fallback_calls = Arc::new(Mutex::new(Vec::new()));
            let fallback = Arc::new(RecordingResolver {
                calls: Arc::clone(&fallback_calls),
                answer: decoy,
            });

            let parsed = parse_public_url(&format!("http://example.com.:{port}/probe"))
                .expect("accepted");
            let result = read(parsed, resolve, Some(fallback))
                .await
                .expect("the pinned request succeeds");
            assert_eq!(result.body, "PIN-ORIGIN");
            assert_eq!(*lookups.lock().unwrap(), 1, "exactly one validated lookup");
            assert!(fallback_calls.lock().unwrap().is_empty());
            assert_eq!(pinned_seen.lock().unwrap().len(), 1);
            assert_eq!(decoy_seen.lock().unwrap().len(), 0);
        });
    }

    /// Case D — a redirect to a trailing-dot host is canonicalized and revalidated per hop.
    #[test]
    fn a_redirect_to_a_trailing_dot_host_is_canonicalized_and_revalidated_per_hop() {
        tauri::async_runtime::block_on(async {
            let first_port = free_port();
            let second_port = free_port();
            let first_seen = spawn_origin(
                loopback(first_port, 1),
                Reply::Redirect(format!("http://example.com.:{second_port}/next")),
                2,
            );
            let second_seen = spawn_origin(loopback(second_port, 1), Reply::Body("REDIRECTED"), 2);

            let resolved_hosts = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&resolved_hosts);
            let resolve = move |host: &str, port: u16| {
                recorded.lock().unwrap().push(format!("{host}:{port}"));
                Ok(vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)])
            };
            let fallback_calls = Arc::new(Mutex::new(Vec::new()));
            let fallback = Arc::new(RecordingResolver {
                calls: Arc::clone(&fallback_calls),
                answer: loopback(second_port, 2),
            });

            let parsed = parse_public_url(&format!("http://first.example:{first_port}/start"))
                .expect("accepted");
            let result = read(parsed, resolve, Some(fallback))
                .await
                .expect("the redirect chain succeeds");
            assert_eq!(result.body, "REDIRECTED");
            assert_eq!(
                *resolved_hosts.lock().unwrap(),
                vec![
                    format!("first.example:{first_port}"),
                    format!("example.com:{second_port}"),
                ],
                "every hop resolves its canonical host"
            );
            assert!(fallback_calls.lock().unwrap().is_empty());
            assert_eq!(first_seen.lock().unwrap().len(), 1);
            assert_eq!(second_seen.lock().unwrap().len(), 1);
        });
    }

    /// Case E — a redirect to an ordinary private destination is refused before any connection.
    #[test]
    fn a_redirect_to_a_private_destination_is_refused() {
        tauri::async_runtime::block_on(async {
            let first_port = free_port();
            let private_port = free_port();
            spawn_origin(
                loopback(first_port, 1),
                Reply::Redirect(format!("http://127.0.0.1:{private_port}/next")),
                1,
            );
            let private_seen = spawn_origin(loopback(private_port, 1), Reply::Body("PRIVATE"), 1);
            let resolve = move |_host: &str, port: u16| {
                Ok(vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)])
            };

            let parsed = parse_public_url(&format!("http://first.example:{first_port}/start"))
                .expect("accepted");
            let error = read(parsed, resolve, None)
                .await
                .map(|result| result.status)
                .unwrap_err();
            assert_eq!(error, BLOCKED_DESTINATION);
            assert_eq!(private_seen.lock().unwrap().len(), 0);
        });
    }

    /// Case D/E combined — a redirect to a trailing-dot host whose canonical name answers with a
    /// private address is refused by the same per-hop address validation as any other answer.
    #[test]
    fn a_redirect_to_a_trailing_dot_host_that_resolves_privately_is_refused() {
        tauri::async_runtime::block_on(async {
            let first_port = free_port();
            let second_port = free_port();
            spawn_origin(
                loopback(first_port, 1),
                Reply::Redirect(format!("http://example.com.:{second_port}/next")),
                1,
            );
            let second_seen = spawn_origin(loopback(second_port, 1), Reply::Body("PRIVATE"), 1);
            let resolve = move |_host: &str, port: u16| {
                // The production resolver refuses the whole lookup when any answer is not public.
                validate_public_addresses(vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)])
            };

            let parsed = parse_public_url(&format!("http://first.example:{first_port}/start"))
                .expect("accepted");
            let error = read(parsed, resolve, None)
                .await
                .map(|result| result.status)
                .unwrap_err();
            assert_eq!(error, BLOCKED_DESTINATION);
            assert_eq!(second_seen.lock().unwrap().len(), 0);
        });
    }

    #[test]
    fn delegates_url_and_address_policy_to_the_shared_module() {
        assert_eq!(
            parse_public_url("http://127.0.0.1/").unwrap_err(),
            BLOCKED_DESTINATION
        );
        assert_eq!(
            parse_public_url("http://[::1]/").unwrap_err(),
            BLOCKED_DESTINATION
        );
        assert_eq!(
            parse_public_url("http://localhost/").unwrap_err(),
            BLOCKED_DESTINATION
        );
        assert!(!public_ip("127.0.0.1".parse().unwrap()));
        assert!(public_ip("1.1.1.1".parse().unwrap()));
    }
    #[test]
    fn accepts_only_web_urls_without_credentials() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://name:password@example.com",
            "javascript:alert(1)",
        ] {
            assert!(parse_public_url(url).is_err(), "{url}");
        }
        assert!(parse_public_url("https://example.com/docs").is_ok());
    }
    #[test]
    #[ignore = "Requires live public internet access"]
    fn live_public_page() {
        tauri::async_runtime::block_on(async {
            let result = web_read_public_page("https://example.com".into())
                .await
                .unwrap();
            assert_eq!(result.status, 200);
            assert!(result.body.contains("Example Domain"));
            assert!(web_read_public_page("http://127.0.0.1".into())
                .await
                .is_err());
            assert!(web_read_public_page("http://169.254.169.254/latest/meta-data/".into())
                .await
                .is_err());
        });
    }
}
