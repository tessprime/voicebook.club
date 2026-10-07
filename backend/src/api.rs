//! JSON API over the index. Callers authenticate with a session cookie
//! obtained from a service-auth token (see auth.rs and docs/design/auth.md);
//! only `/api/health` and the session endpoints are open.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Extension, MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use metrics_exporter_prometheus::PrometheusHandle;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};
use tower_http::trace::TraceLayer;
use tracing::error;

use crate::access::Access;
use crate::atproto;
use crate::auth::{self, ServiceAuth};
use crate::indexer::Indexer;
use crate::jetstream;
use crate::telemetry;
use crate::web;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub indexer: Indexer,
    pub access: Access,
    pub metrics: PrometheusHandle,
    pub public_url: Option<String>,
    pub service_did: String,
    pub auth: Arc<ServiceAuth>,
}

/// The authenticated caller, set by `require_session`.
#[derive(Clone, Debug)]
pub struct Caller {
    pub did: String,
    pub admin: bool,
}

/// Requests that change something must carry this header. Other sites can't
/// add custom headers to cross-site requests without CORS approval (which
/// this API never gives), so it's a CSRF guard on top of SameSite cookies.
const CSRF_HEADER: &str = "x-voicebook-csrf";

pub struct RouterOptions {
    /// Serve `/metrics` on this router (otherwise it has its own listener).
    pub metrics: bool,
    /// Serve the built frontend from this directory.
    pub frontend_dir: Option<std::path::PathBuf>,
}

pub fn router(state: AppState, options: RouterOptions) -> Router {
    // Everything here needs a session (require_session sets the Caller).
    let protected = Router::new()
        .route("/api/members", get(members))
        .route("/api/members/{did}/refresh", post(refresh_member))
        .route("/api/users/{did}/recordings", get(recordings))
        .route("/api/users/{did}/calendar", get(calendar))
        .route("/api/users/{did}/friends/activity", get(friends_activity))
        .route("/api/admin/reindex", post(reindex))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_session));
    let router = Router::new()
        .route("/api/session", get(get_session).post(create_session).delete(delete_session))
        .merge(protected)
        // Layers wrap only the routes above: each API request gets a trace
        // span, a latency measurement and an x-trace-id response header.
        .layer(middleware::from_fn(request_telemetry))
        .layer(TraceLayer::new_for_http().make_span_with(request_span).on_request(()).on_response(()).on_failure(()))
        // Polled frequently; kept out of traces and request metrics.
        .route("/api/health", get(health))
        .route("/client-metadata.json", get(web::client_metadata))
        .route("/.well-known/did.json", get(web::did_document));
    let router = if options.metrics { router.route("/metrics", get(metrics)) } else { router };
    let router = match options.frontend_dir {
        Some(dir) => router.fallback(move |req: Request| async move { web::frontend(&dir, req).await }),
        None => router,
    };
    router.with_state(state)
}

/// `/metrics` alone, for a separate, non-public listener.
pub fn metrics_router(state: AppState) -> Router {
    Router::new().route("/metrics", get(metrics)).with_state(state)
}

/// The server span for a request, with OpenTelemetry's HTTP attribute names.
fn request_span(req: &Request) -> tracing::Span {
    let method = req.method();
    let route = req.extensions().get::<MatchedPath>().map_or("unmatched", |p| p.as_str());
    tracing::info_span!(
        "request",
        otel.name = format!("{method} {route}"),
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        http.request.method = %method,
        http.route = route,
        url.path = req.uri().path(),
        "http.request.header.x-request-id" = request_id(req),
        http.response.status_code = tracing::field::Empty,
        enduser.id = tracing::field::Empty,
    )
}

/// Runs inside the request span: records the response status on it, the
/// latency histogram, and returns the trace ID so a reported error can be
/// found.
async fn request_telemetry(req: Request, next: Next) -> Response {
    let request_id = request_id(&req).map(str::to_owned);
    let method = req.method().to_string();
    let route = req.extensions().get::<MatchedPath>().map_or_else(|| "unmatched".to_owned(), |p| p.as_str().to_owned());
    let start = Instant::now();
    let mut response = next.run(req).await;
    let status = response.status();
    let elapsed = start.elapsed();
    // The local file's record of the request (see docs/design/logging.md);
    // OTLP leaves it out, since the request span carries the same.
    tracing::info!(
        target: "access",
        method = %method,
        route = %route,
        status = status.as_u16(),
        duration_ms = elapsed.as_secs_f64() * 1000.0,
        request_id = request_id.as_deref(),
        "request"
    );
    let span = tracing::Span::current();
    span.record("http.response.status_code", i64::from(status.as_u16()));
    if status.is_server_error() {
        span.record("otel.status_code", "ERROR");
    }
    metrics::histogram!(
        "http_server_request_duration_seconds",
        "method" => method,
        "route" => route,
        "status" => status.as_u16().to_string(),
    )
    .record(elapsed.as_secs_f64());
    if let Some(value) = telemetry::current_trace_id().and_then(|id| HeaderValue::from_str(&id).ok()) {
        response.headers_mut().insert("x-trace-id", value);
    }
    response
}

/// nginx's `$request_id`, which it also writes to its access log: ties an
/// nginx line to this request. Only ID-shaped values are kept, so a client
/// reaching the backend directly can't put arbitrary text in the logs.
fn request_id(req: &Request) -> Option<&str> {
    let id = req.headers().get("x-request-id")?.to_str().ok()?;
    let valid = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(id)
}

async fn metrics(State(state): State<AppState>) -> String {
    state.metrics.render()
}

pub enum ApiError {
    Internal(anyhow::Error),
    /// No valid session: sign in to this service (POST /api/session).
    NotSignedIn,
    /// The account isn't on this instance's allowlist (closed beta).
    NotInvited,
    /// Signed in, but not allowed to do this (e.g. admin-only).
    Forbidden,
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Internal(err) => {
                error!(error = %format!("{err:#}"), "request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal error" }))).into_response()
            }
            Self::NotSignedIn => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "not_signed_in" }))).into_response(),
            Self::NotInvited => (StatusCode::FORBIDDEN, Json(json!({ "error": "not_invited" }))).into_response(),
            Self::Forbidden => (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response(),
        }
    }
}

impl AppState {
    /// Per-account endpoints serve only accounts this instance admits.
    fn require_access(&self, did: &str) -> Result<(), ApiError> {
        if self.access.allows(did) { Ok(()) } else { Err(ApiError::NotInvited) }
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

async fn health(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    let mut cursors = serde_json::Map::new();
    for subscription in [jetstream::RECORDINGS, jetstream::FOLLOWS] {
        cursors.insert(subscription.name.into(), json!(state.indexer.cursor(&subscription.cursor_key()).await?));
    }
    Ok(Json(json!({ "ok": true, "jetstreamCursors": cursors })))
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Member {
    did: String,
    handle: Option<String>,
    active: bool,
    recording_count: i64,
    last_practice_at: Option<String>,
}

async fn members(State(state): State<AppState>) -> ApiResult<Vec<Member>> {
    let rows = sqlx::query_as(
        "SELECT m.did, m.handle, m.active, count(r.uri) AS recording_count, max(r.created_at) AS last_practice_at
         FROM members m LEFT JOIN recordings r ON r.did = m.did
         GROUP BY m.did ORDER BY m.handle",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(FromRow)]
struct RecordingRow {
    uri: String,
    did: String,
    handle: Option<String>,
    pds_url: Option<String>,
    created_at: String,
    work: String,
    chapter: Option<String>,
    duration_ms: Option<i64>,
    notes: Option<String>,
    blob_cid: String,
    mime_type: Option<String>,
    size_bytes: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recording {
    uri: String,
    did: String,
    handle: Option<String>,
    created_at: String,
    work: String,
    chapter: Option<String>,
    duration_ms: Option<i64>,
    notes: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<i64>,
    /// Served directly by the author's PDS; the backend never proxies audio.
    audio_url: Option<String>,
}

impl From<RecordingRow> for Recording {
    fn from(row: RecordingRow) -> Self {
        let audio_url = row.pds_url.as_deref().map(|pds| atproto::blob_url(pds, &row.did, &row.blob_cid));
        Self {
            uri: row.uri,
            did: row.did,
            handle: row.handle,
            created_at: row.created_at,
            work: row.work,
            chapter: row.chapter,
            duration_ms: row.duration_ms,
            notes: row.notes,
            mime_type: row.mime_type,
            size_bytes: row.size_bytes,
            audio_url,
        }
    }
}

const RECORDING_COLUMNS: &str = "SELECT r.uri, r.did, m.handle, m.pds_url, r.created_at, r.work, r.chapter, r.duration_ms,
            r.notes, r.blob_cid, r.mime_type, r.size_bytes
     FROM recordings r JOIN members m ON m.did = r.did";

#[derive(Deserialize)]
struct Page {
    limit: Option<i64>,
    /// Only recordings created strictly before this RFC 3339 UTC timestamp.
    before: Option<String>,
}

impl Page {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
}

async fn recordings(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Vec<Recording>> {
    state.require_access(&did)?;
    let rows: Vec<RecordingRow> = sqlx::query_as(&format!(
        "{RECORDING_COLUMNS} WHERE r.did = ? AND (? IS NULL OR r.created_at < ?) ORDER BY r.created_at DESC LIMIT ?"
    ))
    .bind(&did)
    .bind(&page.before)
    .bind(&page.before)
    .bind(page.limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Recording::from).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarQuery {
    /// YYYY-MM, in the viewer's local time.
    month: String,
    /// The viewer's UTC offset in minutes (e.g. -420 for UTC-7), so practice
    /// days match their local calendar.
    #[serde(default)]
    tz_offset_minutes: i64,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct PracticeDay {
    date: String,
    recording_count: i64,
    duration_ms: Option<i64>,
}

async fn calendar(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(query): Query<CalendarQuery>,
) -> Result<Json<Vec<PracticeDay>>, Response> {
    state.require_access(&did).map_err(IntoResponse::into_response)?;
    let valid_month = query.month.len() == 7
        && query.month.as_bytes()[4] == b'-'
        && query.month.chars().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit());
    if !valid_month || query.tz_offset_minutes.abs() > 14 * 60 {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "expected month=YYYY-MM and |tzOffsetMinutes| <= 840" }))).into_response());
    }
    let shift = format!("{:+} minutes", query.tz_offset_minutes);
    let days = sqlx::query_as(
        "SELECT date(created_at, ?1) AS date, count(*) AS recording_count, sum(duration_ms) AS duration_ms
         FROM recordings
         WHERE did = ?2 AND strftime('%Y-%m', created_at, ?1) = ?3
         GROUP BY 1 ORDER BY 1",
    )
    .bind(&shift)
    .bind(&did)
    .bind(&query.month)
    .fetch_all(&state.db)
    .await
    .map_err(|err| ApiError::from(err).into_response())?;
    Ok(Json(days))
}

async fn friends_activity(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Vec<Recording>> {
    state.require_access(&did)?;
    let follows = state.indexer.follows_of(&did).await?;
    if follows.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let mut query: QueryBuilder<Sqlite> = QueryBuilder::new(RECORDING_COLUMNS);
    query.push(" WHERE m.active = 1 AND r.did IN (");
    let mut dids = query.separated(", ");
    for followed in &follows {
        dids.push_bind(followed);
    }
    query.push(")");
    if let Some(before) = &page.before {
        query.push(" AND r.created_at < ").push_bind(before);
    }
    query.push(" ORDER BY r.created_at DESC LIMIT ").push_bind(page.limit());
    let rows: Vec<RecordingRow> = query.build_query_as().fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().map(Recording::from).collect()))
}

/// Asks the backend to re-read an account's repo now, e.g. right after it
/// signs in or saves a recording, instead of waiting for Jetstream. Only
/// public data is read, so no authentication is needed.
async fn refresh_member(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(did): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    if !(did.starts_with("did:plc:") || did.starts_with("did:web:")) || did.len() > 256 {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "expected a did:plc or did:web DID" }))).into_response());
    }
    // Your own account, or anyone's if you're an admin.
    if caller.did != did && !caller.admin {
        return Err(ApiError::Forbidden.into_response());
    }
    state.require_access(&did).map_err(IntoResponse::into_response)?;
    let member = state.indexer.refresh_member(&did).await.map_err(|err| ApiError::from(err).into_response())?;
    Ok(Json(json!({ "member": member })))
}

async fn reindex(State(state): State<AppState>, Extension(caller): Extension<Caller>) -> ApiResult<serde_json::Value> {
    if !caller.admin {
        return Err(ApiError::Forbidden);
    }
    let members = state.indexer.reindex_all().await?;
    Ok(Json(json!({ "reindexedMembers": members })))
}

// --- sessions -----------------------------------------------------------------

/// Admits requests with a valid session from an admitted account, and sets
/// the `Caller`. Requests that change something must also carry the CSRF
/// header.
async fn require_session(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) && !req.headers().contains_key(CSRF_HEADER) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "missing CSRF header" }))).into_response();
    }
    let Some(token) = session_cookie(req.headers()) else {
        return ApiError::NotSignedIn.into_response();
    };
    let did = match auth::session_did(&state.db, token).await {
        Ok(Some(did)) => did,
        Ok(None) => return ApiError::NotSignedIn.into_response(),
        Err(err) => return ApiError::from(err).into_response(),
    };
    // Checked on every request, so a withdrawn invite takes effect at once.
    if !state.access.allows(&did) {
        return ApiError::NotInvited.into_response();
    }
    tracing::Span::current().record("enduser.id", did.as_str());
    let admin = state.access.is_admin(&did);
    req.extensions_mut().insert(Caller { did, admin });
    next.run(req).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    /// The signed-in DID, if any.
    did: Option<String>,
    admin: bool,
    /// What a service-auth token must name to create a session.
    audience: String,
    lxm: &'static str,
}

impl SessionInfo {
    fn new(state: &AppState, did: Option<String>) -> Self {
        let admin = did.as_deref().is_some_and(|did| state.access.is_admin(did));
        Self { did, admin, audience: state.auth.audience().to_owned(), lxm: auth::SESSION_LXM }
    }
}

/// Who's signed in (if anyone), and how to sign in.
async fn get_session(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<SessionInfo> {
    let did = match session_cookie(&headers) {
        Some(token) => auth::session_did(&state.db, token).await?.filter(|did| state.access.allows(did)),
        None => None,
    };
    Ok(Json(SessionInfo::new(&state, did)))
}

/// Exchanges a service-auth token (`Authorization: Bearer …`) for a session
/// cookie.
async fn create_session(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    let Some(token) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
    else {
        return Err(ApiError::NotSignedIn);
    };
    let did = match state.auth.verify(token, |did| state.access.allows(did)).await {
        Ok(auth::Verdict::Verified(did)) => did,
        Ok(auth::Verdict::Busy) => {
            tracing::warn!("sign-in resolution budget spent; refusing until the next minute");
            let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "too_many_sign_ins" }))).into_response();
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
            return Ok(response);
        }
        Ok(auth::Verdict::NotAdmitted { unverified_did }) => {
            // Unverified: the signature isn't checked for accounts that aren't
            // admitted, so this is only what the token claimed.
            tracing::info!(unverified_did, "sign-in attempt for an account not on the allowlist");
            return Err(ApiError::NotInvited);
        }
        Err(err) => {
            tracing::warn!(error = %format!("{err:#}"), "service-auth token rejected");
            return Err(ApiError::NotSignedIn);
        }
    };
    let session = auth::create_session(&state.db, &did).await?;
    tracing::info!(did, "session created");
    let cookie = session_cookie_header(&session, auth::SESSION_DAYS * 24 * 3600, secure_cookie(req.headers()));
    let mut response = Json(SessionInfo::new(&state, Some(did))).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

/// Signs out of this service (the browser also signs out of its PDS).
async fn delete_session(State(state): State<AppState>, req: Request) -> Result<Response, ApiError> {
    if !req.headers().contains_key(CSRF_HEADER) {
        return Ok((StatusCode::FORBIDDEN, Json(json!({ "error": "missing CSRF header" }))).into_response());
    }
    if let Some(token) = session_cookie(req.headers()) {
        auth::delete_session(&state.db, token).await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(header::SET_COOKIE, session_cookie_header("", 0, secure_cookie(req.headers())));
    Ok(response)
}

/// The session token from the request's cookies. Over HTTPS only the
/// `__Host-` cookie counts: a plain-named one could have been set by another
/// subdomain.
fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    let name = session_cookie_name(secure_cookie(headers));
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
        .filter(|token| !token.is_empty())
}

fn session_cookie_name(secure: bool) -> &'static str {
    if secure { auth::SESSION_COOKIE } else { auth::SESSION_COOKIE_LOOPBACK }
}

fn session_cookie_header(token: &str, max_age_secs: i64, secure: bool) -> HeaderValue {
    let name = session_cookie_name(secure);
    let secure = if secure { "; Secure" } else { "" };
    let value = format!("{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_secs}{secure}");
    HeaderValue::from_str(&value).expect("cookie is ASCII")
}

/// `Secure` (and the `__Host-` name) everywhere except plain-HTTP loopback
/// (local development), where browsers wouldn't accept it. Deployed, TLS ends
/// in front of the container, so the request itself always looks like plain
/// HTTP; the `Host` decides.
fn secure_cookie(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let hostname = host.rsplit_once(':').map_or(host, |(name, port)| if port.bytes().all(|b| b.is_ascii_digit()) { name } else { host });
    !matches!(hostname, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;

    fn with_request_id(id: &str) -> Request {
        Request::builder().header("x-request-id", id).body(Body::empty()).unwrap()
    }

    fn cookie_headers(host: &str, cookie: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        headers
    }

    #[test]
    fn https_reads_only_the_host_prefixed_cookie() {
        // A plain-named cookie tossed from another subdomain is ignored.
        let tossed = cookie_headers("voicebook.club", "vb_session=attacker; __Host-vb_session=mine");
        assert_eq!(session_cookie(&tossed), Some("mine"));
        assert_eq!(session_cookie(&cookie_headers("voicebook.club", "vb_session=attacker")), None);
        // Local development over plain HTTP uses the plain name.
        assert_eq!(session_cookie(&cookie_headers("127.0.0.1:5173", "vb_session=dev")), Some("dev"));
        assert_eq!(session_cookie(&cookie_headers("127.0.0.1:5173", "__Host-vb_session=x")), None);
        // Names that merely start with ours don't count.
        assert_eq!(session_cookie(&cookie_headers("127.0.0.1", "vb_session_old=x")), None);
    }

    #[test]
    fn cookie_attributes_follow_the_host() {
        let https = session_cookie_header("t", 60, true);
        assert_eq!(https, "__Host-vb_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure");
        let local = session_cookie_header("t", 60, false);
        assert_eq!(local, "vb_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=60");
    }

    #[test]
    fn request_id_accepts_only_id_shaped_values() {
        let nginx = "4c7f21b9e0d3a5f86b2e9c1d0a7f3e58";
        assert_eq!(request_id(&with_request_id(nginx)), Some(nginx));
        assert_eq!(request_id(&with_request_id("abc-123_DEF")), Some("abc-123_DEF"));
        assert_eq!(request_id(&with_request_id("has spaces")), None);
        assert_eq!(request_id(&with_request_id(&"a".repeat(65))), None);
        assert_eq!(request_id(&with_request_id("")), None);
        assert_eq!(request_id(&Request::builder().body(Body::empty()).unwrap()), None);
    }
}
