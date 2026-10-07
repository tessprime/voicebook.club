//! Security headers on every response. What each protects against, with an
//! example attack, is in docs/design/security.md ("Security headers"); keep
//! the two in sync.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

#[derive(Clone, Copy, Debug)]
pub struct HeaderPolicy {
    /// The local network (dev/localnet) is plain HTTP on localhost: the
    /// page must be allowed to talk to it.
    pub allow_local_http: bool,
}

/// The Content Security Policy. The frontend loads only its own scripts and
/// styles (no inline code, no eval); it talks to any user's PDS and
/// authorization server over HTTPS, and plays audio from blob: URLs.
fn content_security_policy(policy: HeaderPolicy) -> String {
    let local = if policy.allow_local_http { " http://localhost:* http://127.0.0.1:*" } else { "" };
    [
        "default-src 'self'".to_owned(),
        "script-src 'self'".to_owned(),
        "style-src 'self'".to_owned(),
        "img-src 'self' data:".to_owned(),
        "font-src 'self'".to_owned(),
        format!("connect-src 'self' https:{local}"),
        "media-src 'self' blob:".to_owned(),
        "object-src 'none'".to_owned(),
        "base-uri 'self'".to_owned(),
        "form-action 'self'".to_owned(),
        "frame-ancestors 'none'".to_owned(),
    ]
    .join("; ")
}

pub async fn security_headers(State(policy): State<HeaderPolicy>, req: Request, next: Next) -> Response {
    let api = req.uri().path().starts_with("/api/");
    let https = !is_loopback(req.headers());
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    let mut set = |name: HeaderName, value: &str| {
        headers.insert(name, HeaderValue::from_str(value).expect("header values are ASCII"));
    };
    set(header::CONTENT_SECURITY_POLICY, &content_security_policy(policy));
    set(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(header::REFERRER_POLICY, "same-origin");
    set(
        HeaderName::from_static("permissions-policy"),
        "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    set(HeaderName::from_static("cross-origin-opener-policy"), "same-origin");
    set(HeaderName::from_static("cross-origin-resource-policy"), "same-origin");
    if https {
        // Served over HTTPS by whatever terminates TLS in front of us.
        set(header::STRICT_TRANSPORT_SECURITY, "max-age=31536000");
    }
    if api {
        // Personal data: never stored by browsers or shared caches.
        set(header::CACHE_CONTROL, "no-store");
    }
    response
}

/// Plain-HTTP local development: the same rule as the session cookie's
/// `Secure` flag (see api::secure_cookie).
fn is_loopback(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let hostname = host.rsplit_once(':').map_or(host, |(name, port)| if port.bytes().all(|b| b.is_ascii_digit()) { name } else { host });
    matches!(hostname, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    async fn response(path: &str, host: &str, policy: HeaderPolicy) -> Response {
        let app = Router::new()
            .route("/", get(|| async { "page" }))
            .route("/api/members", get(|| async { "[]" }))
            .layer(axum::middleware::from_fn_with_state(policy, security_headers));
        app.oneshot(Request::builder().uri(path).header(header::HOST, host).body(Body::empty()).unwrap()).await.unwrap()
    }

    const DEPLOYED: HeaderPolicy = HeaderPolicy { allow_local_http: false };

    #[tokio::test]
    async fn deployed_responses_carry_every_header() {
        let r = response("/", "voicebook.club", DEPLOYED).await;
        let h = r.headers();
        let csp = h[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        for directive in ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "connect-src 'self' https:"] {
            assert!(csp.contains(directive), "{directive} in {csp}");
        }
        assert!(!csp.contains("localhost"));
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::REFERRER_POLICY], "same-origin");
        assert!(h["permissions-policy"].to_str().unwrap().contains("microphone=(self)"));
        assert_eq!(h["cross-origin-opener-policy"], "same-origin");
        assert_eq!(h["cross-origin-resource-policy"], "same-origin");
        assert_eq!(h[header::STRICT_TRANSPORT_SECURITY], "max-age=31536000");
        assert!(h.get(header::CACHE_CONTROL).is_none(), "pages keep their own caching");
    }

    #[tokio::test]
    async fn api_responses_are_not_stored() {
        let r = response("/api/members", "voicebook.club", DEPLOYED).await;
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn loopback_gets_no_hsts_and_local_network_is_allowed_in_dev() {
        let r = response("/", "127.0.0.1:8091", HeaderPolicy { allow_local_http: true }).await;
        assert!(r.headers().get(header::STRICT_TRANSPORT_SECURITY).is_none());
        let csp = r.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("connect-src 'self' https: http://localhost:* http://127.0.0.1:*"));
    }
}
