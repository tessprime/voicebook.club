#!/usr/bin/env bash
# Posts a club.voicebook.recording (with a generated test tone) as a seeded
# account. Usage: ./record.sh <account> <work> [chapter] [seconds] [createdAt]
set -euo pipefail
cd "$(dirname "$0")"

name=$1 work=$2 chapter=${3:-} seconds=${4:-3}
created_at=${5:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
pds=$(jq -r .pdsUrl localnet.json)
handle=$(jq -r ".accounts.$name.handle" localnet.json)
password=$(jq -r ".accounts.$name.password" localnet.json)

read -r did jwt < <(curl -sf -X POST "$pds/xrpc/com.atproto.server.createSession" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"$handle\",\"password\":\"$password\"}" | jq -r '"\(.did) \(.accessJwt)"')

audio=$(mktemp --suffix=.ogg)
trap 'rm -f "$audio"' EXIT
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=330:duration=$seconds" -c:a libopus "$audio"
blob=$(curl -sf -X POST "$pds/xrpc/com.atproto.repo.uploadBlob" \
  -H "authorization: Bearer $jwt" -H 'content-type: audio/ogg' --data-binary @"$audio" | jq -c .blob)

record=$(jq -nc --argjson audio "$blob" --arg work "$work" --arg chapter "$chapter" \
  --arg createdAt "$created_at" --argjson ms "$((seconds * 1000))" \
  '{"$type": "club.voicebook.recording", createdAt: $createdAt, work: $work, durationMs: $ms, audio: $audio}
   + (if $chapter == "" then {} else {chapter: $chapter} end)')
curl -sf -X POST "$pds/xrpc/com.atproto.repo.createRecord" \
  -H "authorization: Bearer $jwt" -H 'content-type: application/json' \
  -d "$(jq -nc --arg repo "$did" --argjson record "$record" \
        '{repo: $repo, collection: "club.voicebook.recording", record: $record}')" | jq -r .uri
