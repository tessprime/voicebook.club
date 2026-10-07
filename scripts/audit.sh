#!/usr/bin/env bash
# Checks dependencies for known vulnerabilities. Run before each release.
#
#   scripts/audit.sh            # Rust and npm dependencies
#   scripts/audit.sh --image    # also scan the voicebook:latest image (needs trivy)
#
# Exits non-zero if anything is found. Ignored advisories, with reasons, are in
# backend/.cargo/audit.toml. Dependabot (.github/dependabot.yml) does the same
# continuously on GitHub.
set -uo pipefail
cd "$(dirname "$0")/.."

scan_image=false
[[ ${1:-} == --image ]] && scan_image=true
failed=()

section() { printf '\n== %s\n' "$*"; }

section "Rust (backend): cargo audit"
if command -v cargo-audit >/dev/null; then
  (cd backend && cargo audit) || failed+=(rust)
else
  echo "cargo-audit not installed: cargo install cargo-audit --locked" >&2
  failed+=(rust-not-checked)
fi

section "npm (frontend): npm audit"
if command -v npm >/dev/null; then
  (cd frontend && npm audit --audit-level=low) || failed+=(npm)
else
  echo "npm not found (see the README's Frontend section for nvm)" >&2
  failed+=(npm-not-checked)
fi

if $scan_image; then
  section "Container image: trivy (voicebook:latest)"
  if command -v trivy >/dev/null; then
    trivy image --exit-code 1 --ignore-unfixed --severity HIGH,CRITICAL voicebook:latest || failed+=(image)
  else
    echo "trivy not installed: https://trivy.dev/latest/getting-started/installation/" >&2
    failed+=(image-not-checked)
  fi
fi

section "Summary"
if ((${#failed[@]})); then
  echo "problems: ${failed[*]}"
  exit 1
fi
echo "no known vulnerabilities"
