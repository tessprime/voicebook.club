//! Telemetry setup; see docs/design/logging.md.
//!
//! - Traces and logs go over OTLP to a collector (the main channel).
//! - A JSON-lines diagnostic channel on stderr is always on: warnings,
//!   errors, lifecycle events and the telemetry pipeline's own failures, so
//!   there's a record even when OTLP isn't working.
//! - A local JSON-lines file mirrors every log event plus per-request access
//!   lines, rotated daily with short retention, for debugging production
//!   when OTLP isn't available.
//! - Metrics are kept in-process and served for Prometheus at `/metrics`.

use std::fmt;

use anyhow::{Context, Result};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use opentelemetry::KeyValue;
use opentelemetry::trace::{TraceContextExt, TracerProvider as _};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::config::Config;

const SERVICE_NAME: &str = "voicebook-backend";

/// What OTLP carries: the application's events at info and above, but never
/// the telemetry machinery's own output (that would loop through the
/// exporter) or HTTP client internals.
const OTLP_FILTER: &str = "info,lifecycle=info,opentelemetry=off,opentelemetry_sdk=off,opentelemetry_otlp=off,\
                           opentelemetry_http=off,hyper=off,hyper_util=off,h2=off,reqwest=off,tower_http=off,access=off";

/// What the local file mirrors: everything OTLP carries, the telemetry
/// pipeline's own messages, and the access lines (target `access`), which
/// OTLP leaves out because request spans already cover them.
const FILE_FILTER: &str = "info,lifecycle=info,access=info,hyper=off,hyper_util=off,h2=off,reqwest=off,tower_http=off";

/// Request-duration histogram buckets, in seconds.
const LATENCY_BUCKETS: &[f64] = &[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

/// Flushes and shuts down OTLP export when dropped at the end of `main`.
pub struct Telemetry {
    tracer_provider: SdkTracerProvider,
    logger_provider: Option<SdkLoggerProvider>,
    /// Flushes the file mirror's background writer when dropped.
    _file_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
    pub metrics: PrometheusHandle,
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        if let Err(err) = self.tracer_provider.shutdown() {
            eprintln!("flushing traces failed: {err}");
        }
        if let Some(provider) = &self.logger_provider {
            if let Err(err) = provider.shutdown() {
                eprintln!("flushing logs failed: {err}");
            }
        }
    }
}

pub fn init(config: &Config) -> Result<Telemetry> {
    let stderr_filter = std::env::var("VOICEBOOK_STDERR").unwrap_or_else(|_| config.telemetry.stderr.clone());
    let stderr = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .event_format(JsonLines)
        .with_filter(EnvFilter::try_new(&stderr_filter).with_context(|| format!("stderr filter {stderr_filter:?}"))?);

    let (file, file_guard) = match &config.telemetry.file {
        Some(file) => {
            let appender = tracing_appender::rolling::Builder::new()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix(format!("backend-{}", config.environment))
                .filename_suffix("jsonl")
                .max_log_files(file.retention_days.max(1))
                .build(&file.directory)
                .with_context(|| format!("log directory {}", file.directory.display()))?;
            // Written on a background thread; blocks rather than drop lines.
            let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default().lossy(false).finish(appender);
            let layer = tracing_subscriber::fmt::layer()
                .with_writer(writer)
                .event_format(JsonLines)
                .with_filter(EnvFilter::new(FILE_FILTER));
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };

    let resource = Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attributes([
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new("deployment.environment.name", config.environment.clone()),
        ])
        .build();
    // The tracer always runs, so every request and event has a trace ID for
    // correlating log lines and the x-trace-id header, even with no
    // collector. Spans are exported only when an OTLP endpoint is set.
    let mut tracer_builder = SdkTracerProvider::builder().with_resource(resource.clone());
    let mut logger_provider = None;
    if let Some(endpoint) = &config.telemetry.otlp_endpoint {
        let base = endpoint.trim_end_matches('/');
        let spans = SpanExporter::builder().with_http().with_endpoint(format!("{base}/v1/traces")).build()?;
        let logs = LogExporter::builder().with_http().with_endpoint(format!("{base}/v1/logs")).build()?;
        tracer_builder = tracer_builder.with_batch_exporter(spans);
        logger_provider = Some(SdkLoggerProvider::builder().with_resource(resource).with_batch_exporter(logs).build());
    }
    let tracer_provider = tracer_builder.build();
    let traces = tracing_opentelemetry::layer()
        .with_tracer(tracer_provider.tracer(SERVICE_NAME))
        .with_filter(EnvFilter::new(OTLP_FILTER));
    let logs = logger_provider.as_ref().map(|p| OpenTelemetryTracingBridge::new(p).with_filter(EnvFilter::new(OTLP_FILTER)));

    tracing_subscriber::registry().with(stderr).with(file).with(traces).with(logs).try_init()?;

    let metrics = PrometheusBuilder::new()
        .set_buckets_for_metric(Matcher::Suffix("duration_seconds".into()), LATENCY_BUCKETS)?
        .install_recorder()?;
    describe_metrics();

    Ok(Telemetry { tracer_provider, logger_provider, _file_guard: file_guard, metrics })
}

fn describe_metrics() {
    use metrics::{Unit, describe_counter, describe_gauge, describe_histogram};
    describe_histogram!("http_server_request_duration_seconds", Unit::Seconds, "API request latency, by method, route and status");
    describe_histogram!("atproto_request_duration_seconds", Unit::Seconds, "Outbound PLC/PDS request latency, by operation and outcome");
    describe_histogram!("member_refresh_duration_seconds", Unit::Seconds, "Time to re-read a member's repo");
    describe_counter!("jetstream_events_total", "Jetstream events received, by subscription and outcome (applied or skipped)");
    describe_counter!("jetstream_reconnects_total", "Jetstream reconnects, by subscription and reason");
    describe_gauge!("jetstream_connected", "1 while a subscription is connected");
    describe_gauge!("jetstream_lag_seconds", "Age of the newest event received, by subscription");
    describe_gauge!("index_members", "Known Voicebook members");
    describe_gauge!("index_recordings", "Indexed recordings");
    describe_gauge!("index_follows", "Indexed follows of members");
}

/// The current span's OpenTelemetry trace ID, if it's being traced.
pub fn current_trace_id() -> Option<String> {
    let context = tracing::Span::current().context();
    let span = context.span();
    let span_context = span.span_context();
    span_context.is_valid().then(|| span_context.trace_id().to_string())
}

/// One JSON object per line with flattened fields:
/// `{"timestamp","level","target","message","trace_id","span_id",...fields}`.
/// Key names follow the OpenTelemetry log model so the stderr channel and
/// OTLP describe an event in the same terms.
struct JsonLines;

impl<S, N> FormatEvent<S, N> for JsonLines
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, _ctx: &FmtContext<'_, S, N>, mut writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        let meta = event.metadata();
        let mut line = Map::new();
        line.insert(
            "timestamp".into(),
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true).into(),
        );
        line.insert("level".into(), meta.level().as_str().into());
        line.insert("target".into(), meta.target().into());
        let context = tracing::Span::current().context();
        let span = context.span();
        let span_context = span.span_context();
        if span_context.is_valid() {
            line.insert("trace_id".into(), span_context.trace_id().to_string().into());
            line.insert("span_id".into(), span_context.span_id().to_string().into());
        }
        event.record(&mut FieldVisitor(&mut line));
        let json = serde_json::to_string(&line).map_err(|_| fmt::Error)?;
        writeln!(writer, "{json}")
    }
}

struct FieldVisitor<'a>(&'a mut Map<String, Value>);

impl Visit for FieldVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0.insert(field.name().into(), format!("{value:?}").into());
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }
}
