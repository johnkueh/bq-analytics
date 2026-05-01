#!/usr/bin/env bash
#
# bq-analytics — provision the `release` key in a Vercel Edge Config.
#
# Reuses the existing bq-analytics flags Edge Config store by default
# (same store, different keys), so you don't need a separate one. Pass
# a custom slug to use / create a different store.
#
#   1. ensures the project is `vercel link`ed
#   2. picks the Edge Config store: existing `bq-analytics-flags`
#      (default), an existing one with the requested slug, or creates
#      a new one if neither exists
#   3. seeds the `release` key with the no-op default
#   4. mints a read token + sets EDGE_CONFIG on Production (if not already)
#   5. `vercel env pull .env.local --environment production`
#
# Re-runnable. Each step skips if already done.
#
# Usage:
#   ./scripts/setup-release.sh                       # default slug
#   ./scripts/setup-release.sh my-store              # custom slug
#   EDGE_CONFIG_SLUG=my-store ./scripts/setup-release.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${EDGE_CONFIG_SLUG:-${1:-bq-analytics-flags}}"
KEY="${EDGE_CONFIG_RELEASE_KEY:-release}"

DEFAULT_RELEASE='{"gate":{"minIosBuild":0,"minAndroidBuild":0,"hardBlock":false},"whatsNew":null}'

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }
}
require vercel
require jq

echo "→ Edge Config setup (release)"
echo "  slug:  $SLUG"
echo "  key:   $KEY"
echo "  cwd:   $REPO_ROOT"
echo

# Step 1 — ensure linked
if [ ! -f "$REPO_ROOT/.vercel/project.json" ]; then
  echo "→ vercel link..."
  (cd "$REPO_ROOT" && vercel link --yes)
fi
echo "  project linked"

# Step 2 — find or create Edge Config store
EC_ID="$(vercel edge-config list --format json 2>/dev/null \
  | jq -r --arg s "$SLUG" '.[] | select(.slug==$s) | .id' || true)"

if [ -n "$EC_ID" ]; then
  echo "→ reusing Edge Config: $EC_ID"
else
  echo "→ creating Edge Config..."
  EC_ID="$(vercel edge-config add "$SLUG" --items "{\"$KEY\":$DEFAULT_RELEASE}" --format json \
    | jq -r .id)"
  echo "  created: $EC_ID"
fi

# Step 3 — make sure the release key exists with the no-op default
EXISTING_KEYS="$(vercel edge-config items "$EC_ID" --format json 2>/dev/null | jq -r 'keys[]?' || true)"
if ! echo "$EXISTING_KEYS" | grep -qx "$KEY"; then
  echo "→ initializing key '$KEY' = no-op default"
  vercel edge-config update "$EC_ID" \
    --patch "{\"items\":[{\"operation\":\"upsert\",\"key\":\"$KEY\",\"value\":$DEFAULT_RELEASE}]}" >/dev/null
fi

# Step 4 — push EDGE_CONFIG env var to Production (if not already set
# from a previous flags setup)
HAS_PROD_ENV="$(vercel env ls 2>/dev/null \
  | awk '/^ +EDGE_CONFIG / && /Production/ {print "yes"}' | head -1)"

if [ -n "$HAS_PROD_ENV" ]; then
  echo "→ EDGE_CONFIG already set on Production — skipping"
else
  echo "→ minting read token + setting EDGE_CONFIG on Production"
  TOKEN_JSON="$(vercel edge-config tokens "$EC_ID" --add "bq-analytics-release" --format json)"
  TOKEN="$(echo "$TOKEN_JSON" | jq -r '.token // .[0].token // empty')"
  if [ -z "$TOKEN" ]; then
    echo "couldn't extract token from response:" >&2
    echo "$TOKEN_JSON" >&2
    exit 1
  fi
  CONN="https://edge-config.vercel.com/${EC_ID}?token=${TOKEN}"
  vercel env add EDGE_CONFIG production --value "$CONN" --force --yes >/dev/null
  echo "  EDGE_CONFIG set on Production"
fi

# Step 5 — pull env locally
echo "→ vercel env pull --environment production"
(cd "$REPO_ROOT" && vercel env pull .env.local --environment production --yes >/dev/null)
echo "  wrote .env.local"

echo
echo "✔ Edge Config ready for release-config."
echo "  slug:  $SLUG"
echo "  key:   $KEY"
echo
echo "  show state:    bq-release show --slug $SLUG"
echo "  set notes:     echo '[{\"title\":\"...\",\"body\":\"...\"}]' | bq-release notes v1.0 --slug $SLUG"
echo "  set hard gate: bq-release gate hard 42 --message '...' --slug $SLUG"
echo
echo "Note: EDGE_CONFIG is only set on Production. To propagate to Preview +"
echo "Development environments, use the Vercel dashboard."
