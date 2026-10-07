//! What the backend serves besides the API, in deployed environments: the
//! built frontend and the OAuth client metadata document.

use std::path::Path;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::api::AppState;

/// The OAuth scopes Voicebook requests: writing its own records and
/// uploading audio. The frontend's loopback client (local development)
/// requests the same; keep `frontend/src/auth.ts` in sync.
pub const OAUTH_SCOPE: &str = "atproto repo:club.voicebook.recording blob:audio/*";

/// The OAuth client metadata for a public browser client. Its URL *is* the
/// client ID, so the document names itself. See
/// <https://atproto.com/specs/oauth#client-id-metadata-document>.
pub async fn client_metadata(State(state): State<AppState>, req: Request) -> Response {
    let Some(origin) = state.public_url.clone().or_else(|| origin_from_host(&req)) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "missing or invalid Host header" }))).into_response();
    };
    Json(client_metadata_document(&origin)).into_response()
}

fn client_metadata_document(origin: &str) -> Value {
    let origin = origin.trim_end_matches('/');
    json!({
        "client_id": format!("{origin}/client-metadata.json"),
        "client_name": "Voicebook",
        "client_uri": origin,
        "redirect_uris": [format!("{origin}/")],
        "scope": OAUTH_SCOPE,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "web",
        "dpop_bound_access_tokens": true,
    })
}

/// `https://<Host>`: the site is served over HTTPS by whatever terminates
/// TLS in front of the container (nginx, App Platform).
fn origin_from_host(req: &Request) -> Option<String> {
    let host = req.headers().get(header::HOST)?.to_str().ok()?;
    let valid = !host.is_empty() && host.len() <= 253 && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b));
    valid.then(|| format!("https://{host}"))
}

/// Serves the built frontend. Unknown paths get `index.html` (it's a
/// single-page app), except under `/api/` and `/metrics` (which lives on its
/// own port when deployed), which stay 404s.
pub async fn frontend(dir: &Path, req: Request) -> Response {
    if req.uri().path().starts_with("/api/") || req.uri().path() == "/metrics" {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    let hashed_asset = req.uri().path().starts_with("/assets/");
    let service = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
    let mut response = match service.oneshot(req).await {
        Ok(response) => response.into_response(),
        Err(err) => match err {},
    };
    // Vite's assets have content hashes in their names, so they never change;
    // index.html must always be revalidated to pick up new deploys.
    let cache = if hashed_asset { "public, max-age=31536000, immutable" } else { "no-cache" };
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;

    #[test]
    fn metadata_names_itself_and_redirects_to_the_origin() {
        let doc = client_metadata_document("https://voicebook.club/");
        assert_eq!(doc["client_id"], "https://voicebook.club/client-metadata.json");
        assert_eq!(doc["redirect_uris"][0], "https://voicebook.club/");
        assert_eq!(doc["token_endpoint_auth_method"], "none");
        assert_eq!(doc["scope"], OAUTH_SCOPE);
    }

    #[test]
    fn origin_comes_from_a_well_formed_host() {
        let req = |host: &str| Request::builder().header(header::HOST, host).body(Body::empty()).unwrap();
        assert_eq!(origin_from_host(&req("voicebook.club")), Some("https://voicebook.club".into()));
        assert_eq!(origin_from_host(&req("app-x1.ondigitalocean.app")), Some("https://app-x1.ondigitalocean.app".into()));
        assert_eq!(origin_from_host(&req("evil.com/path")), None);
        assert_eq!(origin_from_host(&Request::builder().body(Body::empty()).unwrap()), None);
    }
}
