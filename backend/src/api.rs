//! Read-only JSON API over the index. Everything it serves is public ATProto
//! data, so no endpoint requires authentication.

use std::time::Instant;

use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode};
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
}

pub struct RouterOptions {
    /// Serve `/metrics` on this router (otherwise it has its own listener).
    pub metrics: bool,
    /// Serve the built frontend from this directory.
    pub frontend_dir: Option<std::path::PathBuf>,
    /// Serve development-only endpoints (`POST /api/dev/reindex`).
    pub dev_endpoints: bool,
}

pub fn router(state: AppState, options: RouterOptions) -> Router {
    let router = Router::new()
        .route("/api/members", get(members))
        .route("/api/members/{did}/refresh", post(refresh_member))
        .route("/api/users/{did}/recordings", get(recordings))
        .route("/api/users/{did}/calendar", get(calendar))
        .route("/api/users/{did}/friends/activity", get(friends_activity))
        .route("/api/access/{did}", get(access))
        // Layers wrap only the routes above: each API request gets a trace
        // span, a latency measurement and an x-trace-id response header.
        .layer(middleware::from_fn(request_telemetry))
        .layer(TraceLayer::new_for_http().make_span_with(request_span).on_request(()).on_response(()).on_failure(()))
        // Polled frequently; kept out of traces and request metrics.
        .route("/api/health", get(health))
        .route("/client-metadata.json", get(web::client_metadata));
    let router = if options.metrics { router.route("/metrics", get(metrics)) } else { router };
    let router = if options.dev_endpoints { router.route("/api/dev/reindex", post(reindex)) } else { router };
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
    /// The account isn't on this instance's allowlist (closed beta).
    NotInvited,
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
            Self::NotInvited => (StatusCode::FORBIDDEN, Json(json!({ "error": "not_invited" }))).into_response(),
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
async fn refresh_member(State(state): State<AppState>, Path(did): Path<String>) -> Result<Json<serde_json::Value>, Response> {
    if !(did.starts_with("did:plc:") || did.starts_with("did:web:")) || did.len() > 256 {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "expected a did:plc or did:web DID" }))).into_response());
    }
    state.require_access(&did).map_err(IntoResponse::into_response)?;
    let member = state.indexer.refresh_member(&did).await.map_err(|err| ApiError::from(err).into_response())?;
    Ok(Json(json!({ "member": member })))
}

/// Whether an account may use this instance; the frontend asks right after
/// sign-in. `inviteOnly` tells it whether to explain the closed beta.
async fn access(State(state): State<AppState>, Path(did): Path<String>) -> Json<serde_json::Value> {
    let allowed = state.access.allows(&did);
    if !allowed {
        tracing::info!(did, "sign-in by an account not on the allowlist");
    }
    Json(json!({ "allowed": allowed, "inviteOnly": state.access.invite_only() }))
}

async fn reindex(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    let members = state.indexer.reindex_all().await?;
    Ok(Json(json!({ "reindexedMembers": members })))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;

    fn with_request_id(id: &str) -> Request {
        Request::builder().header("x-request-id", id).body(Body::empty()).unwrap()
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
