#!/usr/bin/env bash
# Seeds the local network with test accounts and follows, then writes
# localnet.json describing them. Safe to re-run: existing accounts are kept and
# follows are only created once.
set -euo pipefail
cd "$(dirname "$0")"

PLC=http://localhost:2582
PDS=http://localhost:2583
PASSWORD=password

ACCOUNTS=(alice bob carol dave)

# actor:subject. dave stands in for a Bluesky user who never uses Voicebook.
FOLLOWS=(alice:bob alice:carol alice:dave bob:alice carol:bob)

declare -A did jwt

session() { # handle -> "did jwt", or nothing if the account doesn't exist
  curl -sf -X POST "$PDS/xrpc/com.atproto.server.createSession" \
    -H 'content-type: application/json' \
    -d "{\"identifier\":\"$1\",\"password\":\"$PASSWORD\"}" | jq -r '"\(.did) \(.accessJwt)"'
}

for name in "${ACCOUNTS[@]}"; do
  handle="$name.test"
  if out=$(session "$handle"); then
    echo "exists   $handle"
  else
    out=$(curl -sf -X POST "$PDS/xrpc/com.atproto.server.createAccount" \
      -H 'content-type: application/json' \
      -d "{\"handle\":\"$handle\",\"email\":\"$name@example.test\",\"password\":\"$PASSWORD\"}" \
      | jq -r '"\(.did) \(.accessJwt)"')
    echo "created  $handle"
  fi
  read -r did[$name] jwt[$name] <<<"$out"
done

for pair in "${FOLLOWS[@]}"; do
  actor=${pair%%:*} subject=${pair##*:}
  existing=$(curl -sf "$PDS/xrpc/com.atproto.repo.listRecords?repo=${did[$actor]}&collection=app.bsky.graph.follow&limit=100" \
    | jq -r --arg s "${did[$subject]}" '[.records[] | select(.value.subject == $s)] | length')
  if [[ "$existing" != 0 ]]; then
    echo "exists   $actor -> $subject"
    continue
  fi
  record=$(jq -nc --arg s "${did[$subject]}" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{"$type": "app.bsky.graph.follow", subject: $s, createdAt: $now}')
  curl -sf -X POST "$PDS/xrpc/com.atproto.repo.createRecord" \
    -H "authorization: Bearer ${jwt[$actor]}" -H 'content-type: application/json' \
    -d "$(jq -nc --arg repo "${did[$actor]}" --argjson record "$record" \
          '{repo: $repo, collection: "app.bsky.graph.follow", record: $record}')" >/dev/null
  echo "created  $actor -> $subject"
done

{
  printf '{"plcUrl":"%s","pdsUrl":"%s","jetstreamUrl":"ws://localhost:6008","accounts":{' "$PLC" "$PDS"
  sep=
  for name in "${ACCOUNTS[@]}"; do
    printf '%s"%s":{"handle":"%s.test","did":"%s","password":"%s"}' "$sep" "$name" "$name" "${did[$name]}" "$PASSWORD"
    sep=,
  done
  printf '},"follows":%s}' "$(printf '%s\n' "${FOLLOWS[@]}" | jq -R 'split(":")' | jq -sc .)"
} | jq . > localnet.json
echo "wrote localnet.json"
