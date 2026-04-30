#!/usr/bin/env bash
#
# bq-analytics — provision a Vercel Edge Config for feature flags.
#
#   1. ensures the project is `vercel link`ed
#   2. creates an Edge Config (or reuses one with the same slug)
#   3. initializes the `flags` key as an empty object
#   4. mints a read token and constructs a connection string
#   5. sets EDGE_CONFIG on Production via `vercel env add`
#      (preview + development require VERCEL_TOKEN — see end of script)
#   6. `vercel env pull .env.local --environment production`
#
# Re-runnable. Each step skips if already done.
#
# Usage:
#   ./scripts/setup-edge-config.sh                       # default slug
#   ./scripts/setup-edge-config.sh my-flags-store        # custom slug
#   EDGE_CONFIG_SLUG=my-flags ./scripts/setup-edge-config.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${EDGE_CONFIG_SLUG:-${1:-bq-analytics-flags}}"
KEY="${EDGE_CONFIG_KEY:-flags}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }
}
require vercel
require jq

echo "→ Edge Config setup"
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

# Step 2 — create or reuse Edge Config
EC_ID="$(vercel edge-config list --format json 2>/dev/null \
  | jq -r --arg s "$SLUG" '.[] | select(.slug==$s) | .id' || true)"

if [ -n "$EC_ID" ]; then
  echo "→ reusing Edge Config: $EC_ID"
else
  echo "→ creating Edge Config..."
  EC_ID="$(vercel edge-config add "$SLUG" --items "{\"$KEY\":{}}" --format json \
    | jq -r .id)"
  echo "  created: $EC_ID"
fi

# Step 3 — make sure the flags key exists (no-op if already)
EXISTING_KEYS="$(vercel edge-config items "$EC_ID" --format json 2>/dev/null | jq -r 'keys[]?' || true)"
if ! echo "$EXISTING_KEYS" | grep -qx "$KEY"; then
  echo "→ initializing key '$KEY' = {}"
  vercel edge-config update "$EC_ID" \
    --patch "{\"items\":[{\"operation\":\"upsert\",\"key\":\"$KEY\",\"value\":{}}]}" >/dev/null
fi

# Step 4 — push EDGE_CONFIG env var to Production
HAS_PROD_ENV="$(vercel env ls 2>/dev/null \
  | awk '/^ +EDGE_CONFIG / && /Production/ {print "yes"}' | head -1)"

if [ -n "$HAS_PROD_ENV" ]; then
  echo "→ EDGE_CONFIG already set on Production — skipping"
else
  echo "→ minting read token + setting EDGE_CONFIG on Production"
  TOKEN_JSON="$(vercel edge-config tokens "$EC_ID" --add "bq-analytics-flags" --format json)"
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
echo "✔ Edge Config ready."
echo "  list flags:    vercel edge-config items $EC_ID"
echo "  edit flags:    vercel edge-config update $EC_ID --patch '{\"items\":[...]}'"
echo "  in code:       import { edgeConfigSource } from 'bq-analytics/edge-config'"
echo
echo "Note: EDGE_CONFIG is only set on Production. To propagate to Preview +"
echo "Development environments, use the Vercel dashboard, or set VERCEL_TOKEN"
echo "and use the REST helper in setup-bq-oidc.sh as a template."
