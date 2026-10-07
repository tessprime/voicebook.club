# Logging, tracing and metrics

How the backend (and nginx in front of it) report what they're doing, and
why. The backend's code lives in `backend/src/telemetry.rs`; settings are in
`backend/environments/*.json`.

## Goals

The telemetry exists to answer three kinds of question:

1. **Latency:** where does the time go?
2. **Application statistics:** how much traffic, how many members, how far
   behind is Jetstream? Charted and alerted on in Prometheus/Grafana.
3. **Individual requests:** what exactly happened in *this* request, for the
   weirder issues?

## Principles

**Three signals, each for one kind of question.**

| Signal | Answers | Where |
|---|---|---|
| Metrics | Is something wrong? How much? | Prometheus scrapes `/metrics` |
| Traces | Where did the time go? What happened in this request? | OTLP → Tempo |
| Logs | What happened, and why? | OTLP → Loki; mirrored to a local file; diagnostics on stderr; nginx's access log |

Counting and timing belong in metrics, not logs. Per-request detail belongs in
traces, not metrics.

**Structured, not prose.** The message is a fixed phrase; everything that
varies goes in fields:

```rust
warn!(did, collection, error = %err, "backfill failed");      // yes
warn!("backfill of {did} failed: {err}");                     // no
```

Fixed messages can be searched and grouped, and fields become OpenTelemetry
attributes.

**Levels mean something.**

- **ERROR:** a person needs to act (the database is failing, the service
  can't start).
- **WARN:** something degraded or unexpected was handled: a PDS unreachable,
  an invalid record skipped, a Jetstream reconnect or `CursorTooOld`. A steady
  WARN rate is a signal.
- **INFO:** low-volume lifecycle and state changes (startup, subscribed, new
  member).
- **DEBUG:** per-request and per-event detail; off by default.

**A volume budget.** Nothing that happens per Jetstream event is logged at
INFO, and events that don't affect the index are never logged or traced, only
counted. Most of the network's follows, identity and account events are of
that kind.

**Privacy by default.**

- Fine to log: DIDs, AT URIs, collections, routes, status codes. They're
  public and they're our identifiers. The DID is the key; handles are mutable
  display data.
- Never logged: tokens, `Authorization` headers, passwords, OAuth state, and
  record contents, especially the free-text `notes`. They're public in the
  repo, but logs get copied and kept elsewhere.
- Client IP addresses are logged **by nginx only**, in its access log on the
  server, for security and abuse investigation. That log stays on the server
  (it isn't shipped anywhere) and is kept for 7 days. The backend never sees
  or logs IPs: behind nginx every request arrives from 127.0.0.1.

**Everything can be correlated.** Every API request and every applied
Jetstream event gets a trace ID, whether or not traces are exported. Log
records carry its `trace_id` and `span_id`. API responses return it in an
`x-trace-id` header, and the frontend shows it in error messages
("ref 92bb730b…"), so a report leads straight to the request.

nginx ties in through its request ID: it generates `$request_id` for every
request, writes it in its access log, and passes it to the backend as
`X-Request-Id`. The backend records it on the request span
(`http.request.header.x-request-id`) and on the access line (`request_id`).
So an nginx line leads to the backend's records for the same request, and
back.

**Log errors once, where they're handled.** Don't log and re-throw at each
layer. Log the whole cause chain (`{:#}`) with identifying fields.

**One format, one pipeline, every environment.** Development and production
produce the same backend records in the same format through the same
pipeline. Environments differ only in *where* output goes (the OTLP endpoint,
if any) and *how much* is kept or sampled. nginx is a separate process and
keeps its own standard format.

## Channels

### OTLP: the main channel, when there's a collector

Traces and logs are pushed over OTLP/HTTP to the collector named by
`telemetry.otlpEndpoint` (e.g. `http://localhost:4318`). The exporter batches
and is flushed on shutdown (Ctrl-C or SIGTERM). Without an endpoint nothing is
exported, but trace IDs are still generated for correlation.

Excluded from OTLP: the OpenTelemetry SDK's own output and HTTP-client
internals (`hyper`, `h2`, `reqwest`). Sent over OTLP, a failing exporter would
end up reporting its failures to itself.

Every record carries the resource attributes `service.name=voicebook-backend`,
`service.version` and `deployment.environment.name` (the environment file's
name).

### stderr: the diagnostic channel

Always on, in every environment, so there's a record even when OTLP isn't
working. It carries only:

- WARN and ERROR events;
- lifecycle events (target `lifecycle`): starting (with the configuration),
  listening, subscribed to Jetstream, shutting down, stopped;
- the telemetry pipeline's own failures (OpenTelemetry SDK warnings);
- anything before the exporter starts, which is when startup errors happen.

Panics also print to stderr. The filter is `telemetry.stderr`, in `RUST_LOG`
syntax (default `warn,lifecycle=info`). `VOICEBOOK_STDERR` widens it for a
session, e.g. to watch every event scroll by:

```bash
VOICEBOOK_STDERR=info cargo run 2>&1 | ../scripts/logview
```

### Local file: everything, mirrored

Every log event at INFO and above, plus one **access line per API request**,
is also written to a JSON-lines file on the machine running the backend,
rotated daily and kept for a few days. It's for debugging production when the
OTLP pipeline is down or behind: everything that happened recently is on local
disk.

- Configured by `telemetry.file` (`directory`, `retentionDays`, default 3).
  Files are named `backend-<environment>.<UTC date>.jsonl`; the oldest are
  deleted beyond the retention count.
- Access lines (target `access`) record method, route, status, duration and
  nginx's `request_id`, with the trace ID. They go only to the file: in OTLP,
  the request span already carries the same information.
- The file writer runs on a background thread and blocks rather than drop
  lines, and is flushed on shutdown.

```bash
tail -f logs/backend-local-bluesky.*.jsonl | scripts/logview
scripts/logview logs/backend-local-bluesky.2026-10-07.jsonl --trace be91cb9b…
```

### Format

One JSON object per line, the same in every output. The fixed keys come first and follow the
OpenTelemetry log model; event fields are flattened beside them:

```json
{"timestamp":"2026-10-07T01:03:35.643534Z","level":"INFO","target":"lifecycle","message":"subscribed to jetstream","subscription":"follows","url":"ws://localhost:6008/…"}
{"timestamp":"…","level":"WARN","target":"voicebook_backend::indexer","trace_id":"5b8efff798038103d269b633813fc60c","span_id":"eee19b7ec3c1b174","message":"backfill failed","did":"did:plc:…","collection":"app.bsky.graph.follow","error":"…"}
```

`trace_id` and `span_id` appear when the event happens inside a traced span.
Nothing is multi-line.

To read it, use `scripts/logview`, which prints
`HH:MM:SS.mmm LEVEL target: message key=value …` and can filter by level or
trace ID.

### nginx

nginx keeps its standard access and error logs, plus one addition to the
access format: `$request_id`, for correlation with the backend.

- Access log: the standard `combined` format (client IP, request line,
  status, size, referrer, user agent) followed by the request ID.
- Location: `/var/log/nginx/`, rotated daily by logrotate and kept 7 days.
- Not shipped anywhere for now: it stays on the server.

To go from an nginx line to the backend:

```bash
grep <request_id> /var/log/voicebook/backend-droplet.*.jsonl | scripts/logview
```

### Metrics: Prometheus

The backend keeps metrics in-process and serves them at `GET /metrics` in
Prometheus's text format. Prometheus pulls them, so they keep working when the
OTLP pipeline is down. `/metrics` is only reachable on the server itself;
nginx doesn't expose it.

| Metric | Type | Labels |
|---|---|---|
| `http_server_request_duration_seconds` | histogram | method, route, status |
| `atproto_request_duration_seconds` | histogram | operation (`resolve_did`, `list_records`), outcome |
| `member_refresh_duration_seconds` | histogram | |
| `jetstream_events_total` | counter | subscription, outcome (`applied`, `skipped`) |
| `jetstream_reconnects_total` | counter | subscription, reason (`closed`, `error`, `cursor_too_old`) |
| `jetstream_connected` | gauge | subscription |
| `jetstream_lag_seconds` | gauge | subscription: age of the newest event received |
| `index_members`, `index_recordings`, `index_follows` | gauge | |

Routes are the matched route templates (`/api/users/{did}/recordings`), never
raw paths, so DIDs don't multiply label values.

## Traces

- **API requests:** a server span per request, named `METHOD route`, with
  OpenTelemetry's HTTP attributes (`http.request.method`, `http.route`,
  `url.path`, `http.response.status_code`) and nginx's request ID
  (`http.request.header.x-request-id`); 5xx responses mark it as an error. `/api/health` and `/metrics` aren't traced: they're polled
  constantly and say nothing.
- **Outbound calls:** a client span per HTTP request to the PLC or a PDS
  (`resolve_did`, `list_records`, with `server.address` and status), under
  spans for the operation (`resolve`, `list_records`, `fetch_snapshot`,
  `refresh_member`).
- **Jetstream:** each event that changes the index is its own trace,
  `index <kind> <collection>`. Skipped events get no span.

In OTLP, the server span *is* the access record; access lines exist only in
the local file (see above). Failed requests also produce an ERROR log, which
reaches stderr.

Sampling: everything is kept for now. Once there's real traffic, sample
normal requests and always keep errors and slow requests.

## Local setup

`dev/localnet` runs `grafana/otel-lgtm`: an OpenTelemetry Collector, Tempo,
Loki, Prometheus and Grafana in one container, with data in a Docker volume.

| Port | |
|---|---|
| 3000 | Grafana (bound to 127.0.0.1; anonymous users are admins) |
| 4317 / 4318 | OTLP gRPC / HTTP in |
| 9090 | Prometheus (scrapes the backend's `/metrics` on :8080 every 5 s) |
| 3100, 3200 | Loki, Tempo |

In Grafana (http://localhost:3000):

- **Requests:** Explore → Tempo, e.g.
  `{resource.service.name="voicebook-backend" && span.http.route="/api/members/{did}/refresh"}`,
  or the Traces Drilldown app. Click a trace for its span tree and logs.
- **Logs:** Explore → Loki, `{service_name="voicebook-backend"}`, with live
  tail.
- **Metrics:** Explore → Prometheus, e.g.
  `histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[5m])))`.
- **One request:** search Tempo for the ID from an `x-trace-id` header or an
  error message's "ref".

## Production

**Until a telemetry server is chosen, production logs locally.** Nothing is
pushed or scraped; everything stays on the server:

| Output | Where | Retention |
|---|---|---|
| Backend JSON mirror (every event, access lines) | the container's `/logs` volume, e.g. `/var/log/voicebook/backend-droplet.<date>.jsonl` on the host | 3 days, rotated by the backend |
| Backend stderr (warnings, errors, lifecycle) | Docker's log driver (`docker logs`), capped | e.g. 3 × 10 MB |
| nginx access and error logs | `/var/log/nginx/` | 7 days, logrotate |
| Metrics | port 9100 of the container (never published) | in memory only |

The container environments (`droplet.json`, `app-platform.json`) have no `otlpEndpoint`, so OTLP export is off; trace IDs are
still generated, so all of the above can be correlated.

**Adding a telemetry server later** means setting `otlpEndpoint` and running
an agent on the server (e.g. Grafana Alloy or an OpenTelemetry Collector).
The agent tails nginx's logs and the container's output, scrapes `/metrics` (port 9100), and pushes
everything out, so the firewall only needs outbound connections. The choices
for where it goes:

- **Self-hosted** Grafana, Tempo, Loki and Prometheus. Tempo and Loki can
  store to object storage, e.g. Backblaze B2. No credentials leave the box,
  but it has to be maintained.
- **Managed**, e.g. Grafana Cloud or Honeycomb. Less to run, but it adds one
  deployed secret (an API key) and the vendor's limits.

Retention starting points: logs 14 days, traces 7 days, metrics 90 days.
They're configured in the storage backends (e.g. Tempo's compactor), not in
the app.

## Not yet

- Frontend telemetry. For now the browser shows the trace ID in error
  messages; reporting browser-side failures can come later.
- Trace context propagation: reading `traceparent` from incoming requests and
  sending it on outbound ones. One use: nginx could send its `$request_id` as
  the trace ID, so nginx's log and the backend's traces share one ID. For now
  the request ID is a separate field.
- Trace sampling, and rate limiting `/refresh`.
