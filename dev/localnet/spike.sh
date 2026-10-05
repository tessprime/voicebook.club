#!/usr/bin/env bash
# Exercises every ATProto operation the Voicebook MVP needs against the local
# network, using raw XRPC calls. Requires a running localnet (npm start).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
state="$here/localnet.json"
[[ -f "$state" ]] || { echo "localnet.json missing; start the localnet first" >&2; exit 1; }

plc=$(jq -r .plcUrl "$state")
handle=$(jq -r .accounts.alice.handle "$state")
password=$(jq -r .accounts.alice.password "$state")

step() { printf '\n== %s\n' "$*"; }

step "resolve handle $handle -> DID (via PDS)"
pds_guess=$(jq -r .pdsUrl "$state")
did=$(curl -sf "$pds_guess/xrpc/com.atproto.identity.resolveHandle?handle=$handle" | jq -r .did)
echo "$did"

step "resolve DID -> PDS endpoint (via PLC)"
pds=$(curl -sf "$plc/$did" | jq -r '.service[] | select(.id == "#atproto_pds") | .serviceEndpoint')
echo "$pds"

step "OAuth metadata advertised by the PDS"
auth_server=$(curl -sf "$pds/.well-known/oauth-protected-resource" | jq -r '.authorization_servers[0]')
echo "authorization server: $auth_server"
curl -sf "$auth_server/.well-known/oauth-authorization-server" \
  | jq '{issuer, authorization_endpoint, token_endpoint, pushed_authorization_request_endpoint, dpop_signing_alg_values_supported, client_id_metadata_document_supported}'

step "password session (stand-in for OAuth)"
jwt=$(curl -sf -X POST "$pds/xrpc/com.atproto.server.createSession" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"$handle\",\"password\":\"$password\"}" | jq -r .accessJwt)
echo "got access token (${#jwt} chars)"

step "generate a 3s test tone and upload it as a blob"
audio="$(mktemp --suffix=.ogg)"
trap 'rm -f "$audio"' EXIT
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=3" -c:a libopus "$audio"
blob=$(curl -sf -X POST "$pds/xrpc/com.atproto.repo.uploadBlob" \
  -H "authorization: Bearer $jwt" -H 'content-type: audio/ogg' \
  --data-binary @"$audio" | jq -c .blob)
echo "$blob"
blob_cid=$(jq -r '.ref["$link"]' <<<"$blob")

step "create club.voicebook.recording record"
record=$(jq -nc --argjson audio "$blob" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
  "$type": "club.voicebook.recording",
  createdAt: $now,
  work: "Pride and Prejudice",
  chapter: "3",
  durationMs: 3000,
  audio: $audio
}')
created=$(curl -sf -X POST "$pds/xrpc/com.atproto.repo.createRecord" \
  -H "authorization: Bearer $jwt" -H 'content-type: application/json' \
  -d "$(jq -nc --arg repo "$did" --argjson record "$record" \
        '{repo: $repo, collection: "club.voicebook.recording", record: $record}')")
echo "$created" | jq -c .

step "list recordings (unauthenticated, as the indexer would)"
curl -sf "$pds/xrpc/com.atproto.repo.listRecords?repo=$did&collection=club.voicebook.recording" \
  | jq -c '.records[] | {uri, work: .value.work, chapter: .value.chapter, createdAt: .value.createdAt}'

step "fetch the blob back (unauthenticated) and compare"
fetched="$(mktemp)"
curl -sf "$pds/xrpc/com.atproto.sync.getBlob?did=$did&cid=$blob_cid" -o "$fetched"
if cmp -s "$audio" "$fetched"; then echo "blob matches ($(stat -c %s "$fetched") bytes)"; else echo "BLOB MISMATCH" >&2; exit 1; fi
rm -f "$fetched"

step "list alice's follows from her repo (no AppView needed)"
curl -sf "$pds/xrpc/com.atproto.repo.listRecords?repo=$did&collection=app.bsky.graph.follow" \
  | jq -r '.records[].value.subject'

printf '\nall steps passed\n'
