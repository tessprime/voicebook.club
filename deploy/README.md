# Deploy: the Voicebook image

Voicebook ships as **one container image**: the Rust backend, which also
serves the built frontend. This directory builds and tests that image and
defines what it expects from whatever runs it. Provisioning a host (a Droplet
with nginx and a firewall, or App Platform) is a separate project; it consumes
the contract below.

```text
deploy/
├── Dockerfile        multi-stage: frontend (Node) → backend (Rust 1.88) → debian-slim runtime
├── build.sh          builds voicebook:<git sha> and voicebook:latest
├── compose.yaml      runs the image locally like a Droplet would, against real Bluesky
├── test-image.sh     builds a test image and runs the Playwright suite against the container
└── test/localnet.json  config for test-image.sh (the local network in dev/localnet)
```

## Building

```bash
deploy/build.sh                         # voicebook:<sha> + voicebook:latest
deploy/build.sh --tag registry.example/voicebook:1.0.0
```

Build from a clean tree for real releases; otherwise the tag ends in `-dirty`.

## The contract

| | |
|---|---|
| **Port 8080** | The site (`/`), the API (`/api/…`) and `/client-metadata.json`. Plain HTTP: TLS is terminated in front of the container. |
| **Port 9100** | `/metrics` for Prometheus. **Never publish or route it publicly.** |
| **Config** | `--environment <name>` picks a built-in file from `/app/environments/` (default `droplet`); `--config <path>` loads a mounted file instead. |
| **`/data`** | The SQLite database. Persistent storage is recommended; if it's lost, members' data comes back as they sign in (see `docs/mvp-local.md` §20). |
| **`/logs`** | The JSON log mirror (`droplet` environment): rotated daily, 3 days kept, by the app itself. |
| **stderr** | JSON lines: warnings, errors and lifecycle events (more in `app-platform`). |
| **Health** | `GET /api/health` returns 200 with Jetstream cursors. |
| **Signals** | SIGTERM shuts down gracefully and flushes logs. |
| **User** | Runs as uid 10001 (`voicebook`), not root. |
| **Instances** | **Exactly one.** SQLite and the Jetstream consumer aren't built to run as several replicas. |
| **Access** | Every API call needs a session from a service-auth token (`docs/design/auth.md`). `serviceDid` names the service tokens are addressed to; it must match the domain (`did:web:<domain>`). `access.allowlist` makes the instance invite-only, `access.admins` names admins; see [Closed beta](#closed-beta-allowlist). |
| **Outbound fetches** | Addresses from other people's DID documents (PDSes, `did:web` hosts) must be HTTPS and resolve only to public IPs, with timeouts and an 8 MB response cap (`backend/src/fetch_guard.rs`). Only `network.allowPrivateAddresses`, set for the local network, turns this off. |
| **Secrets** | None today. See [Secrets](#secrets). |

### Built-in environments

| | `droplet` | `app-platform` |
|---|---|---|
| Behind | nginx on the same host | App Platform's edge |
| Database | `/data` (persistent volume) | `/data` (temporary: reset on each deploy, rebuilt at startup) |
| JSON log mirror | `/logs` | off (it would vanish on redeploy) |
| stderr | `warn,lifecycle=info` | `info`: App Platform's log viewer is the mirror |
| `/metrics` | port 9100, unpublished | port 9100, not routed |

Both talk to the real network (`plc.directory`, `jetstream.us-east.bsky.network`)
and export no OTLP until a telemetry server exists (see
`docs/design/logging.md`). To change anything, mount a file and use
`--config`; the schema is `backend/src/config.rs`.

### OAuth

Deployed, the app is an OAuth client whose ID is the URL of its metadata
document: `https://<your domain>/client-metadata.json`, served by the backend.
The origin comes from `publicUrl` in the config if set, otherwise from each
request's `Host` header. So **whatever is in front must pass the original
`Host` through** (nginx: `proxy_set_header Host $host;`). Served from a
loopback address (127.0.0.1), the frontend uses a loopback client instead and
needs no metadata.

The requested scopes are `atproto repo:club.voicebook.recording blob:audio/*`.

## Closed beta: allowlist

Both container environments are invite-only. `access.allowlist` in the
environment JSON lists the DIDs that may use the instance:

```json
"access": { "allowlist": ["did:plc:oq6rkprwln2i4rtv5gcignb6"] }
```

- **DIDs, not handles**: handles can change. `scripts/invite.py` takes
  handles, verifies them in both directions, and edits the DIDs into the
  container environments: `scripts/invite.py add alice.bsky.social`
  (`--admin` for an admin), `remove`, and `list` (with current handles).
- Only listed accounts are indexed, refreshed or served. Anyone else can sign
  in with Bluesky but sees "Voicebook is invite-only during the beta"; the
  per-account API endpoints answer them with 403 `not_invited`.
- Changes take effect on restart. Members no longer listed are removed from
  the index then (their data stays in their own repositories).
- Leaving `access` out makes the instance open (development).
- On a Droplet, mount your own config (`--config`) and restart to change the
  list. On App Platform, which can't mount files, the list is part of the
  image's built-in `app-platform.json`: change it, rebuild and redeploy.

**Admins** (`access.admins`, DIDs) are always admitted, and may refresh any
account and reindex (`POST /api/admin/reindex`). Both container environments
start with one admin. See `docs/design/auth.md`.

## Hosting notes

### Droplet with Docker

What the hosting project needs to provide:

- **Publish 8080 on loopback only:** `127.0.0.1:8080:8080`. Docker writes its
  own iptables rules, so a port published on all interfaces is reachable from
  the internet *even if ufw blocks it*. Use a DigitalOcean Cloud Firewall too
  (SSH, 80, 443 only); it filters before traffic reaches the Droplet.
- **nginx** terminating TLS and proxying to `127.0.0.1:8080`:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_set_header Host $host;               # OAuth metadata, DID document, Secure cookies
      proxy_set_header X-Request-Id $request_id; # ties nginx's log to the backend's
  }
  ```

  and `$request_id` appended to the access log format. Don't add security
  headers in nginx: the backend already sends them, HSTS included (see
  `docs/design/security.md`), and duplicates can conflict. nginx's logs keep
  client IPs, stay on the host and rotate after 7 days (see
  `docs/design/logging.md`).
- **Volumes** for `/data` and `/logs`, e.g. on Block Storage so they survive
  rebuilding the Droplet. Put `/logs` at `/var/log/voicebook` on the host to
  keep it beside nginx's logs.
- **Docker's log driver capped** (`max-size`, `max-file`) or set to journald;
  the default keeps stderr forever.
- `restart: unless-stopped`; Docker itself is the supervisor.

`compose.yaml` here is a local stand-in for that setup.

### App Platform

`deploy/app-platform/deploy.sh` deploys the current commit: it checks the tree
is clean, runs `scripts/audit.sh`, builds and pushes
`registry.digitalocean.com/<registry>/voicebook:<commit>` (skipped if that tag
is already there), deploys it with the spec in `deploy/app-platform/app.yaml`
(creating the app the first time), and waits for `/api/health`. `--dry-run`
shows the plan without changing anything. It assumes `doctl auth init` and
`doctl registry login`; a token scoped to Apps and Container Registry is
enough.

```bash
scripts/invite.py add alice.bsky.social    # an invite is part of the image's config…
git commit -am "Invite alice"              # …so commit it…
deploy/app-platform/deploy.sh              # …and deploy
```

The spec, roughly:

```yaml
services:
  - name: web
    image:
      registry_type: DOCR
      repository: voicebook
      tag: <git sha>
    run_command: /app/voicebook-backend --environment app-platform
    http_port: 8080
    instance_count: 1
    health_check:
      http_path: /api/health
```

- App Platform terminates TLS and sends plain HTTP to `http_port`.
- The filesystem is temporary, so the database resets on every deploy. While
  the instance is invite-only that costs nothing: at startup the backend
  re-reads every listed account (allowlist and admins) from their PDSes and
  rebuilds the index within seconds.
- **Custom domain:** Networking → Domains → Add domain. Either point the
  domain's nameservers at DigitalOcean, or create a CNAME at your DNS provider
  to the `…ondigitalocean.app` target it shows. A root domain
  (`voicebook.club`) can't be a plain CNAME: use your provider's CNAME
  flattening, or the A records App Platform offers. TLS certificates are
  automatic. DNSSEC isn't supported; CAA records must allow `letsencrypt.org`
  and `pki.goog`.

## Security

Before deploying, run `scripts/audit.sh --image`, and check the open items in
[`docs/design/security.md`](../docs/design/security.md).

## Secrets

There are none yet. When the first one arrives (e.g. a telemetry API key),
it follows these rules:

- **Never** in the image, the repository or the JSON config. The config may
  name a secret (e.g. `"otlpAuth": {"secret": "OTLP_TOKEN"}`), never hold it.
- The backend reads secret `NAME` from the environment variable `NAME`, or
  from the file named by `NAME_FILE` (the usual Docker convention).
  - **App Platform:** environment variables of type *secret*, stored
    encrypted.
  - **Droplet:** Compose `secrets:`, mounted at `/run/secrets/<name>`
    (`NAME_FILE=/run/secrets/<name>`), from a root-owned `0600` file outside
    the repository. Files stay out of `docker inspect`.
- In code, a `Secret` type prints `[redacted]`, so a value can't reach the
  logs. Startup fails fast if a required secret is missing, and logs which
  ones were loaded, by name only.
- Rotation: replace the value and restart the container. No rebuild.

## Testing the image

```bash
deploy/test-image.sh
```

Builds `voicebook:test` with the frontend in development mode, runs it
against the local network (`dev/localnet`, which must be up and seeded) on
port 8091, and runs the Playwright suite against the container. Uses host
networking, since the local network's DID documents name `localhost:2583`.

To try the production image with your real account:

```bash
deploy/build.sh
docker compose -f deploy/compose.yaml up     # http://127.0.0.1:8090
```
