//! Guards outbound fetches of URLs that come from other people's data (PDS
//! endpoints in DID documents, `did:web` hosts) against server-side request
//! forgery: anyone can publish a DID document naming an internal address,
//! such as a cloud metadata service or something on the private network.
//!
//! The rules, unless private addresses are allowed (local development):
//! - HTTPS only;
//! - every address a host resolves to must be public. The check happens in
//!   the HTTP client's DNS resolver, so the connection goes to an address that
//!   was checked (no DNS-rebinding gap); IP-literal URLs and redirects are
//!   checked up front;
//! - timeouts and a response-size cap, so a hostile server can't hang the
//!   backend or exhaust its memory.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect;

/// The largest response body accepted from an untrusted server.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Copy, Debug)]
pub struct FetchPolicy {
    /// Allow plain HTTP and private/loopback addresses (local development,
    /// where the PDS is on localhost).
    pub allow_private: bool,
}

/// An HTTP client that enforces `policy` on every connection and redirect.
pub fn client(policy: FetchPolicy) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        // Never via a proxy from the environment (HTTPS_PROXY etc., which
        // reqwest honors by default): the proxy would resolve hostnames, so
        // the public-only resolver below would never run.
        .no_proxy()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if let Err(err) = check_url(attempt.url(), policy) {
                attempt.error(err.to_string())
            } else {
                attempt.follow()
            }
        }));
    if !policy.allow_private {
        builder = builder.dns_resolver(Arc::new(PublicOnlyResolver));
    }
    Ok(builder.build()?)
}

/// Checks a URL before fetching it: scheme, and the host if it's an IP
/// literal (hostnames are checked as they resolve).
pub fn check_url(url: &Url, policy: FetchPolicy) -> Result<()> {
    match url.scheme() {
        "https" => {}
        "http" if policy.allow_private => {}
        scheme => bail!("refusing {scheme}: URL {url}"),
    }
    if policy.allow_private {
        return Ok(());
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) if !is_public(IpAddr::V4(ip)) => bail!("refusing non-public address {ip}"),
        Some(url::Host::Ipv6(ip)) if !is_public(IpAddr::V6(ip)) => bail!("refusing non-public address {ip}"),
        Some(url::Host::Domain(host)) if host == "localhost" || host.ends_with(".localhost") => bail!("refusing {host}"),
        None => bail!("URL has no host: {url}"),
        _ => Ok(()),
    }
}

/// Resolves names normally, then drops every non-public address; a name with
/// only non-public addresses fails to resolve.
struct PublicOnlyResolver;

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public: Vec<SocketAddr> = addrs.iter().copied().filter(|a| is_public(a.ip())).collect();
            if public.is_empty() {
                return Err(format!("{host} resolves only to non-public addresses").into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// Whether an address is on the public internet: not loopback, private,
/// link-local, shared (CGNAT), multicast, reserved or documentation space,
/// including IPv6 forms that embed such an IPv4 address.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0 // "this network"
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 88 && c == 99) // 6to4 relay anycast
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || a >= 240) // reserved
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let segments = ip.segments();
    // 6to4 (2002::/16) embeds an IPv4 address in the next 32 bits.
    if segments[0] == 0x2002 {
        return is_public_v4(Ipv4Addr::new((segments[1] >> 8) as u8, segments[1] as u8, (segments[2] >> 8) as u8, segments[2] as u8));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00 // unique local (fc00::/7)
        || (segments[0] & 0xffc0) == 0xfe80 // link-local (fe80::/10)
        || (segments[0] & 0xffc0) == 0xfec0 // site-local, deprecated (fec0::/10)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
        || (segments[0] == 0x2001 && segments[1] == 0) // Teredo
        || (segments[0] == 0x64 && segments[1] == 0xff9b) // NAT64 (64:ff9b::/32, incl. local-use 64:ff9b:1::/48)
        || segments[..6].iter().all(|&s| s == 0)) // IPv4-compatible (deprecated)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STRICT: FetchPolicy = FetchPolicy { allow_private: false };
    const DEV: FetchPolicy = FetchPolicy { allow_private: true };

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn classifies_addresses() {
        for public in ["8.8.8.8", "1.1.1.1", "104.16.0.1", "2606:4700::1111", "2001:4860:4860::8888"] {
            assert!(is_public(ip(public)), "{public} should be public");
        }
        for internal in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
            "255.255.255.255", "224.0.0.1", "240.0.0.1", "192.0.2.1", "198.18.0.1", "::1", "::", "fc00::1",
            "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
            "2002:7f00:0001::1", "2002:a9fe:a9fe::1", "64:ff9b::a9fe:a9fe", "2001:0:4136:e378::1", "fec0::1", "64:ff9b:1::a00:1",
        ] {
            assert!(!is_public(ip(internal)), "{internal} should not be public");
        }
    }

    #[test]
    fn checks_urls() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(check_url(&url("https://porcini.us-east.host.bsky.network"), STRICT).is_ok());
        assert!(check_url(&url("http://pds.example.com"), STRICT).is_err(), "plain HTTP");
        assert!(check_url(&url("https://169.254.169.254/latest"), STRICT).is_err());
        assert!(check_url(&url("https://[::ffff:10.0.0.1]/"), STRICT).is_err());
        assert!(check_url(&url("https://localhost:2583"), STRICT).is_err());
        assert!(check_url(&url("file:///etc/passwd"), STRICT).is_err());
        assert!(check_url(&url("http://localhost:2583"), DEV).is_ok());
        assert!(check_url(&url("file:///etc/passwd"), DEV).is_err());
    }

    #[tokio::test]
    async fn resolver_rejects_names_with_only_private_addresses() {
        let name: Name = "localhost".parse().unwrap();
        assert!(PublicOnlyResolver.resolve(name).await.is_err());
    }

    #[tokio::test]
    async fn strict_client_refuses_private_hosts_before_connecting() {
        let client = client(STRICT).unwrap();
        // Resolves to 127.0.0.1: rejected by the resolver, never connected.
        let err = client.get("https://localhost:1/").send().await.unwrap_err();
        assert!(format!("{err:?}").contains("non-public"), "{err:?}");
    }
}
