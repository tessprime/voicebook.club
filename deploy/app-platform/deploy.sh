#!/usr/bin/env bash
# Builds the image for the current commit, pushes it to DigitalOcean's
# container registry, and deploys it to App Platform.
#
#   deploy/app-platform/deploy.sh               # deploy HEAD
#   deploy/app-platform/deploy.sh --dry-run     # show what would happen
#   deploy/app-platform/deploy.sh --skip-audit  # skip the dependency audit
#
# Assumes `doctl auth init` and `doctl registry login` have been done.
# The image is tagged with the commit, so the working tree must be clean:
# otherwise the deployed code wouldn't match any commit.
set -euo pipefail
cd "$(dirname "$0")/../.."

spec=deploy/app-platform/app.yaml
dry_run=false
audit=true
for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=true ;;
    --skip-audit) audit=false ;;
    *) echo "usage: $0 [--dry-run] [--skip-audit]" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

step "Preflight"
for tool in doctl docker git curl; do
  command -v "$tool" >/dev/null || fail "$tool not found"
done
# Checks what this script needs (apps), not account access: scoped tokens may
# lack account:read.
doctl apps list --no-header >/dev/null 2>&1 \
  || fail "doctl can't list apps: not authenticated (doctl auth init), or the token lacks App Platform scopes"
if [[ -n $(git status --porcelain) ]]; then
  $dry_run || fail "uncommitted changes; commit them first (the image is tagged with the commit)"
  echo "warning: uncommitted changes (a real deploy would stop here)"
fi
registry=$(doctl registry get --format Name --no-header) || fail "no container registry (doctl registry create …)"
app_name=$(sed -n 's/^name:[[:space:]]*//p' "$spec" | head -1)
repository=$(sed -n 's/^[[:space:]]*repository:[[:space:]]*//p' "$spec" | head -1)
tag=$(git rev-parse --short HEAD)
image="registry.digitalocean.com/$registry/$repository:$tag"
app_id=$(doctl apps list --format ID,Spec.Name --no-header | awk -v name="$app_name" '$2 == name { print $1 }')
echo "commit:   $(git log -1 --format='%h %s')"
echo "image:    $image"
echo "app:      $app_name (${app_id:-not created yet})"

if $audit; then
  step "Dependency audit"
  scripts/audit.sh || fail "the audit found problems (or rerun with --skip-audit)"
fi

step "Image"
# list-tags prints a table whatever --format says; match the first column.
if doctl registry repository list-tags "$repository" 2>/dev/null | awk -v tag="$tag" '$1 == tag { found = 1 } END { exit !found }'; then
  echo "$image is already in the registry; not rebuilding"
elif $dry_run; then
  echo "would build and push $image"
else
  deploy/build.sh --tag "$image"
  docker push "$image"
fi

step "Deploy"
deploy_spec=$(mktemp --suffix=.yaml)
trap 'rm -f "$deploy_spec"' EXIT
sed -E "s/^([[:space:]]*tag:).*/\1 $tag/" "$spec" > "$deploy_spec"
if $dry_run; then
  if [[ -n $app_id ]]; then echo "would update app $app_id with:"; else echo "would create the app with:"; fi
  cat "$deploy_spec"
  exit 0
fi
if [[ -n $app_id ]]; then
  doctl apps update "$app_id" --spec "$deploy_spec" --wait --format ID,DefaultIngress
else
  doctl apps create --spec "$deploy_spec" --wait --format ID,DefaultIngress
  app_id=$(doctl apps list --format ID,Spec.Name --no-header | awk -v name="$app_name" '$2 == name { print $1 }')
fi

step "Health"
url=$(doctl apps get "$app_id" --format DefaultIngress --no-header)
for _ in $(seq 1 30); do
  if health=$(curl -sf --max-time 10 "$url/api/health"); then
    echo "$url/api/health: $health"
    echo
    echo "deployed $tag. Logs: doctl apps logs $app_id --type run --follow | scripts/logview"
    exit 0
  fi
  sleep 5
done
fail "$url/api/health didn't answer; see doctl apps logs $app_id --type run"
