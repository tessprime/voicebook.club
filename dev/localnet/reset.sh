#!/usr/bin/env bash
# Destroys the local network's state: containers, volumes, .env and
# localnet.json. Run ./init.sh, docker compose up and ./seed.sh afterwards.
set -euo pipefail
cd "$(dirname "$0")"

read -r -p "Delete all local network data (accounts, DIDs, blobs)? [y/N] " answer
[[ "$answer" == [yY] ]] || exit 1

docker compose down --volumes
rm -f .env localnet.json
echo "reset complete"
