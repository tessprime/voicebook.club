#!/usr/bin/env bash
# Builds the Voicebook image from the repository root.
#
#   deploy/build.sh                     # voicebook:<git sha>, plus voicebook:latest
#   deploy/build.sh --mode development  # frontend built for dev/localnet (image tests)
#   deploy/build.sh --tag registry.example/voicebook:1.2.3
set -euo pipefail
cd "$(dirname "$0")/.."

mode=production
tag=
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode) mode=$2; shift 2 ;;
    --tag) tag=$2; shift 2 ;;
    *) echo "usage: deploy/build.sh [--mode production|development] [--tag name]" >&2; exit 2 ;;
  esac
done

version=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- . ':!logs' 2>/dev/null || version="$version-dirty"
if [[ -z $tag ]]; then
  tag="voicebook:$version"
  [[ $mode == production ]] || tag="$tag-$mode"
fi
extra_tags=()
[[ $mode == production ]] && extra_tags=(-t voicebook:latest)

# Host networking: some environments (e.g. WSL) time out on the default build
# network during npm/cargo downloads. Harmless elsewhere.
docker build --network host \
  -f deploy/Dockerfile \
  --build-arg FRONTEND_MODE="$mode" \
  --label org.opencontainers.image.revision="$version" \
  -t "$tag" "${extra_tags[@]}" \
  .
echo "built $tag"
