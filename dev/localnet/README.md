# Local ATmosphere

A local PLC directory, PDS and Jetstream for Voicebook development, run with
Docker Compose. All three are unmodified upstream software:

| Port | Service | Source |
|---|---|---|
| 2580 | postgres | `postgres:18-alpine` (PLC's database) |
| 2582 | plc | [`did-method-plc`](https://github.com/did-method-plc/did-method-plc), built from a pinned commit (its published image is private) |
| 2583 | pds | `ghcr.io/bluesky-social/pds` (official) |
| 6008 | jetstream | `ghcr.io/bluesky-social/jetstream` (official), reading the PDS firehose |
| 3000 | observability | `grafana/otel-lgtm`: Grafana, Tempo, Loki, Prometheus and an OpenTelemetry Collector (OTLP on 4317/4318). Prometheus scrapes the backend's `/metrics` on :8080 (`observability/prometheus.yaml`). See [`docs/design/logging.md`](../../docs/design/logging.md). |

Grafana listens on 127.0.0.1 only, since anonymous users are admins in this
image. Everything uses host networking, so `localhost` means the same thing to the
containers, the backend and the browser. DID documents name the PDS as
`http://localhost:2583`, and every consumer has to be able to reach it there.

## Usage

Requires Docker with the Compose plugin (`sudo apt install docker-compose-v2`
on Ubuntu), plus `curl`, `jq`, `openssl` and `xxd`. `spike.sh` also needs
`ffmpeg`.

```bash
cd dev/localnet
./init.sh                 # first time only: generates .env with fresh secrets
docker compose up -d      # first run builds the PLC image (a few minutes)
./seed.sh                 # creates test accounts and follows; safe to re-run
./spike.sh                # exercises every ATProto call the MVP needs
```

Stop with `docker compose down`. State persists in Docker volumes, so accounts
and DIDs survive restarts. To start over, run `./reset.sh`, which deletes the
volumes and `.env` together.

Seeded accounts (password `password`): `alice.test`, `bob.test`,
`carol.test`, `dave.test`. Follows: alice → bob, carol, dave; bob → alice;
carol → bob. dave stands in for a Bluesky user who doesn't use Voicebook.
`seed.sh` writes the current DIDs and URLs to `localnet.json`.

## Keys

`init.sh` writes `.env` (mode 600, gitignored):

- `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX`: the PDS signs PLC operations
  with it. It must stay paired with the volumes: with a new key, the PDS can no
  longer update the DIDs it already created. `reset.sh` deletes both together.
- `PDS_JWT_SECRET`, `PDS_DPOP_SECRET`, `PDS_ADMIN_PASSWORD`: PDS-only.
- `POSTGRES_PASSWORD`: shared by postgres and plc.

The PLC itself holds no keys: every operation carries its own signature.
Account signing keys are generated per account by the PDS and kept in its
volume.

## Useful queries

```bash
curl -s localhost:2582/export | jq -c .                        # every PLC operation
curl -s localhost:2582/did:plc:...                             # a DID document
curl -s localhost:2583/xrpc/com.atproto.sync.listRepos | jq    # accounts on the PDS
websocat 'ws://localhost:6008/subscribe?wantedCollections=club.voicebook.recording'
```

## Workarounds

- **Building the PLC image:** `docker compose up` builds it on first run, which
  needs buildx 0.17 or newer (`sudo apt install docker-buildx` upgrades
  Ubuntu's 0.12). Without that, build it directly:

  ```bash
  docker build --network host -t voicebook-localnet/plc:9c8ea2f \
    -f packages/server/Dockerfile \
    https://github.com/did-method-plc/did-method-plc.git#9c8ea2fe23b89a5c1011246cbb4957dad9dbf7db
  ```

  Host networking matters under WSL: on the default build network pnpm's
  parallel downloads time out.
- **Jetstream data volume:** the image runs as uid 65532, so its volume is
  mounted at `/home/nonroot` to inherit that ownership.
- **Jetstream backfill:** on first start Jetstream walks the relay's
  `listHosts`, which a PDS doesn't implement. `JETSTREAM_BACKFILL_REPOS` names
  a placeholder repo to skip that walk. Accounts created afterwards arrive
  through the live stream, which is all the backend needs.
