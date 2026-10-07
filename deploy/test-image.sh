#!/usr/bin/env bash
# Tests the image end to end: builds it with the frontend in development mode,
# runs it against the local network (dev/localnet, which must be up and
# seeded), and runs the Playwright suite against the container.
set -euo pipefail
cd "$(dirname "$0")/.."

deploy/build.sh --mode development --tag voicebook:test
docker rm -f voicebook-test >/dev/null 2>&1 || true
# Host networking: the local network's DID documents name localhost:2583.
docker run -d --name voicebook-test --network host \
  -v "$PWD/deploy/test/localnet.json:/etc/voicebook/config.json:ro" \
  --tmpfs /data:uid=10001 --tmpfs /logs:uid=10001 \
  voicebook:test --config /etc/voicebook/config.json >/dev/null
trap 'docker rm -f voicebook-test >/dev/null' EXIT

for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8091/api/health >/dev/null && break
  sleep 1
done
curl -sf http://127.0.0.1:8091/api/health >/dev/null || { docker logs voicebook-test; exit 1; }

cd frontend
E2E_BASE_URL=http://127.0.0.1:8091 npx playwright test
