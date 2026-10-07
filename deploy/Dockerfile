# The Voicebook image: the backend, serving the built frontend.
# Build from the repository root with deploy/build.sh (see deploy/README.md).

ARG RUST_VERSION=1.88
ARG NODE_VERSION=24

# --- frontend: static files -------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# production: real Bluesky. development: the local network in dev/localnet
# (only for testing the image; see deploy/test-image.sh).
ARG FRONTEND_MODE=production
RUN npx tsc -b && npx vite build --mode "${FRONTEND_MODE}"

# --- backend: one static-ish binary ------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS backend
WORKDIR /src/backend
# Dependencies first, in their own layer, so source changes rebuild quickly.
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY backend/ ./
RUN touch src/main.rs && cargo build --release --locked

# --- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim
# CA certificates for TLS to plc.directory, Jetstream and PDSes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --home-dir /app voicebook \
    && mkdir -p /data /logs \
    && chown voicebook /data /logs
WORKDIR /app
COPY --from=backend /src/backend/target/release/voicebook-backend ./voicebook-backend
COPY backend/environments ./environments
COPY --from=frontend /src/frontend/dist ./frontend
USER voicebook
# /data: SQLite database. /logs: the JSON log mirror (droplet environment).
VOLUME ["/data", "/logs"]
# 8080: the site and API. 9100: /metrics, not meant to be published.
EXPOSE 8080 9100
ENTRYPOINT ["/app/voicebook-backend"]
CMD ["--environment", "droplet"]
