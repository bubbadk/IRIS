//! The single outbound-web destination policy.
//!
//! Every IRIS capability that can reach a model-chosen URL — the public web reader
//! (`web_read.rs`) and browser navigation (`browser.rs` plus its enforcing proxy
//! `browser_proxy.rs`) — resolves, validates and connects through this module. There is one
//! definition of "public destination" so a browser tool can never be weaker than `web.search`
//! or `web.extract`.
//!
//! The policy is deliberately deny-by-default: only ordinary global unicast addresses are
//! reachable, and every address a hostname resolves to must pass, so a host that publishes one
//! public and one private address is refused outright instead of racing which answer a
//! connector happens to pick.
//!
//! # One canonical authority
//!
//! Policy validation, system resolution, DNS pinning and the transport lookup must all refer to
//! the *same* host identity. A syntactic difference (`example.com` vs `example.com.`, host case,
//! an alternative IPv4 spelling, an expanded IPv6 literal) that is normalised for the policy
//! decision but left in the request URL would make the pin key miss and let the connection fall
//! back to a fresh, unvalidated lookup. [`canonicalize_url_host`] is therefore applied at the URL
//! boundary ([`parse_web_url`]) and again per hop by the reader, so the URL handed to the HTTP
//! client always carries exactly the host that was validated and pinned.
use reqwest::Url;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};

/// Longest URL the policy will look at. Longer inputs are refused instead of truncated.
pub const MAX_URL_LENGTH: usize = 2000;

/// Refusal text shared by every surface, so a blocked destination reads the same everywhere.
pub const BLOCKED_DESTINATION: &str =
    "IRIS network policy: private, local or reserved network addresses are not reachable from web or browser tools.";

/// The one definition of an address IRIS web access may connect to.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && b == 0)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Only ordinary global unicast; exclude transition and documentation ranges.
            s[0] & 0xe000 == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

/// Host names are compared and resolved in one canonical form: lower case, no brackets, no
/// trailing root dot. `localhost.` and `LOCALHOST` must not slip past a literal check.
pub fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Rewrites a parsed URL so its host is exactly the canonical form returned by
/// [`normalize_host`]. This is the identity boundary the DNS pin depends on: `reqwest`'s
/// `resolve_to_addrs` stores its key verbatim (lower-cased) and the connect-time lookup is an
/// exact string match, so policy validation, resolution, pinning and the actual transport must
/// all see one spelling. Two spellings of the same authority — `example.com` and `example.com.`,
/// `Example.COM`, the octal/short IPv4 forms the parser accepts, an expanded IPv6 literal — are
/// therefore reduced here, before any of those four steps, instead of being normalised only for
/// the comparison that decides "public or not".
///
/// IPv6 literals are re-bracketed because the URL host parser requires that serialisation; the
/// address itself is re-serialised canonically by the same WHATWG parser that produced it.
pub fn canonicalize_url_host(url: &Url) -> Result<Url, String> {
    let host = normalize_host(url.host_str().unwrap_or_default());
    if host.is_empty() || reserved_host_name(&host) {
        return Err(BLOCKED_DESTINATION.into());
    }
    let serialized = match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(ip)) => format!("[{ip}]"),
        Ok(IpAddr::V4(ip)) => ip.to_string(),
        Err(_) => host,
    };
    let mut canonical = url.clone();
    canonical
        .set_host(Some(&serialized))
        .map_err(|_| "Enter a valid public HTTP or HTTPS address.".to_string())?;
    Ok(canonical)
}

/// Host names that only ever mean "this machine" and must never be resolved at all.
fn reserved_host_name(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "localhost.localdomain" | "ip6-localhost" | "ip6-loopback"
    ) || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
}

/// The structural half of the URL policy: an explicitly allowed scheme, a host, no embedded
/// credentials, bounded length and no reserved host name. Addresses are a separate decision —
/// see [`parse_public_url`] for a literal check and [`resolve_public_addresses`] for the resolved
/// one — because the browser's proxy must make its decision at connect time, after it has a
/// resolved address to pin.
///
/// The returned URL always carries the canonical host ([`canonicalize_url_host`]), so every
/// caller — including the reader's request URL and its pin key — works from one identity.
pub fn parse_web_url(value: &str) -> Result<Url, String> {
    if value.trim().is_empty() || value.chars().count() > MAX_URL_LENGTH {
        return Err("Enter a public HTTP or HTTPS address.".into());
    }
    let url = Url::parse(value.trim()).map_err(|_| "Enter a valid public HTTP or HTTPS address.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "Web tools require a public HTTP or HTTPS address without embedded credentials.".into(),
        );
    }
    canonicalize_url_host(&url)
}

/// The one URL policy: [`parse_web_url`] plus an immediate refusal of a literal private, local or
/// special address, which needs no lookup. `Url` normalises octal, decimal and short IPv4 forms,
/// so `127.1`, `2130706433` and `0x7f000001` all arrive here as `127.0.0.1`.
pub fn parse_public_url(value: &str) -> Result<Url, String> {
    let url = parse_web_url(value)?;
    let host = normalize_host(url.host_str().unwrap_or_default());
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err(BLOCKED_DESTINATION.into());
        }
    }
    Ok(url)
}

/// Refuses every lookup unless all of its answers are public addresses. Shared so the reader and
/// the navigation proxy cannot drift apart on what "public" means.
pub fn validate_public_addresses(
    mut addresses: Vec<SocketAddr>,
) -> Result<Vec<SocketAddr>, String> {
    if addresses.is_empty() {
        return Err("The web address could not be resolved. Check your network connection.".into());
    }
    if addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(BLOCKED_DESTINATION.into());
    }
    // A stable order makes the pinned address deterministic for callers and tests.
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

/// Resolves a host name and refuses the whole lookup unless *every* answer is a public address.
/// Blocking; call it from a worker thread or through the async helper.
pub fn resolve_public_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let host = normalize_host(host);
    if host.is_empty() || reserved_host_name(&host) {
        return Err(BLOCKED_DESTINATION.into());
    }
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "The web address could not be resolved. Check your network connection.")?
        .collect::<Vec<SocketAddr>>();
    validate_public_addresses(addresses)
}

/// Async wrapper so a navigation preflight never blocks the command runtime.
pub async fn resolve_public_addresses_async(
    host: String,
    port: u16,
) -> Result<Vec<SocketAddr>, String> {
    tokio::task::spawn_blocking(move || resolve_public_addresses(&host, port))
        .await
        .map_err(|_| "The web address lookup failed.".to_string())?
}

/// Validates a URL and pins it by resolving every address the host publishes.
pub async fn preflight_public_url(value: &str) -> Result<Url, String> {
    let url = parse_public_url(value)?;
    let host = normalize_host(url.host_str().unwrap_or_default());
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Enter a public HTTP or HTTPS address.".to_string())?;
    resolve_public_addresses_async(host, port).await?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_local_reserved_and_mapped_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn accepts_only_web_urls_without_credentials() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://name:password@example.com",
            "javascript:alert(1)",
            "data:text/html,hello",
            "blob:https://example.com/1234",
            "chrome://settings",
            "",
        ] {
            assert!(parse_public_url(url).is_err(), "{url}");
        }
        assert!(parse_public_url("https://example.com/docs").is_ok());
        assert!(parse_public_url("http://example.com:8080/x?y=1").is_ok());
    }

    #[test]
    fn refuses_reserved_host_names_without_resolving_them() {
        for host in [
            "http://localhost/",
            "http://LOCALHOST:8080/",
            "http://localhost./",
            "http://app.localhost/",
            "http://nas.local/",
            "http://router.internal/",
            "http://printer.home.arpa/",
        ] {
            let error = parse_public_url(host).unwrap_err();
            assert_eq!(error, BLOCKED_DESTINATION, "{host}");
        }
    }

    #[test]
    fn normalizes_hosts_before_comparison() {
        assert_eq!(normalize_host("  [::1] "), "::1");
        assert_eq!(normalize_host("Example.COM."), "example.com");
    }

    /// The structural boundary hands out one identity per authority, whatever spelling arrived.
    /// The request URL the reader sends is built from this result, so pin key and transport host
    /// are the same string by construction.
    #[test]
    fn every_host_spelling_is_reduced_to_one_canonical_identity() {
        for (input, expected) in [
            ("http://example.com./docs", "example.com"),
            ("http://Example.COM/docs", "example.com"),
            ("http://Example.COM.:8080/docs?x=1", "example.com"),
            ("http://example.com/docs", "example.com"),
            ("http://127.1/", "127.0.0.1"),
            ("http://2130706433/", "127.0.0.1"),
            ("http://0x7f.0.0.1/", "127.0.0.1"),
            ("http://0177.0.0.1/", "127.0.0.1"),
            ("http://[0:0:0:0:0:0:0:1]/", "[::1]"),
            ("http://[2606:4700:4700:0:0:0:0:1111]/", "[2606:4700:4700::1111]"),
        ] {
            let canonical = parse_web_url(input).expect(input);
            assert_eq!(
                canonical.host_str().unwrap_or_default(),
                expected,
                "{input}"
            );
            // The pin key the reader computes from this URL.
            assert_eq!(normalize_host(canonical.host_str().unwrap()), normalize_host(expected));
            // The rest of the URL survives the rewrite.
            if input.contains(":8080") {
                assert_eq!(canonical.port(), Some(8080), "{input}");
            }
            if input.contains("?x=1") {
                assert_eq!(canonical.query(), Some("x=1"), "{input}");
            }
            // Canonicalisation is idempotent, so the per-hop rewrite in the reader is a no-op on
            // an already-canonical URL.
            let again = canonicalize_url_host(&canonical).expect("idempotent");
            assert_eq!(again.as_str(), canonical.as_str(), "{input}");
        }
    }

    /// A canonical host must not become reserved or empty through canonicalisation, and no
    /// reserved spelling may survive the boundary.
    #[test]
    fn canonicalisation_fails_closed_for_empty_and_reserved_authorities() {
        for input in [
            "http://localhost./",
            "http://LOCALHOST./",
            "http://app.localhost./",
            "http://nas.local./",
            "http://router.internal./",
            "http://printer.home.arpa./",
            "http://ip6-localhost/",
        ] {
            let error = parse_public_url(input).unwrap_err();
            assert_eq!(error, BLOCKED_DESTINATION, "{input}");
        }
    }

    /// IPv6 privacy forms stay blocked by the literal check even after bracket/case rewriting.
    #[test]
    fn ipv6_private_and_reserved_forms_stay_blocked() {
        for input in [
            "http://[::1]/",
            "http://[0:0:0:0:0:0:0:1]/",
            "http://[::ffff:7f00:1]/",
            "http://[fc00::1]/",
            "http://[FE80::1]/",
            "http://[2001:db8::1]/",
            "http://[2002:7f00:1::]/",
            "http://[ff02::1]/",
            "http://[::]/",
        ] {
            let error = parse_public_url(input).unwrap_err();
            assert_eq!(error, BLOCKED_DESTINATION, "{input}");
        }
    }
}
