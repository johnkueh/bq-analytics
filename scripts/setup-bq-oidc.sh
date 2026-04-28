#!/usr/bin/env bash
#
# bq-analytics — one-shot setup
#
#   1. enables BigQuery + STS + IAM Credentials APIs
#   2. creates BQ datasets + tables
#   3. provisions Vercel OIDC → GCP Workload Identity Federation
#   4. creates a service account with bigquery.dataEditor + jobUser
#   5. pushes the 7 env vars to all 3 Vercel environments via REST
#      (bypasses the CLI's `git_branch_required` quirk on preview)
#   6. registers a Vercel Log Drain pointed at /api/internal/log-drain
#
# Re-runnable. Each step skips if already done.
#
# IMPORTANT: the log drain creation (step 6) requires the route URL to
# be live. On a brand-new project that hasn't been deployed yet, run with
# `--skip-drain` first, deploy, then re-run with `--drain-only`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: setup-bq-oidc.sh [--gcp PROJECT_ID] [--team SLUG] [--project NAME]
                       [--domain DOMAIN] [--events-dataset NAME] [--logs-dataset NAME]
                       [--skip-vercel] [--skip-drain] [--drain-only]

Required:
  --gcp / GCP_PROJECT_ID         e.g. my-app-prod
  --team / TEAM_SLUG             Vercel team slug (omit with --skip-vercel)
  --project / PROJECT_NAME       Vercel project name (omit with --skip-vercel)
  --domain / PROJECT_DOMAIN      e.g. www.example.com (only for drain step)

Modes:
  default        run all 6 steps
  --skip-vercel  steps 1-2 only (BQ datasets + DDL); useful for non-Vercel hosts
  --skip-drain   steps 1-5 (everything except Log Drain)
  --drain-only   step 6 only — re-run after first deploy makes the URL live

Optional (defaults):
  EVENTS_DATASET   events
  LOGS_DATASET     logs
  POOL_ID          vercel
  PROVIDER_ID      vercel
  SA_NAME          vercel-bq

Env vars used:
  VERCEL_TOKEN     team-scope token from vercel.com/account/tokens (required
                   unless --skip-vercel)
USAGE
  exit 1
}

# ---- parse args ----
SKIP_VERCEL=0
SKIP_DRAIN=0
DRAIN_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gcp) GCP_PROJECT_ID="$2"; shift 2 ;;
    --team) TEAM_SLUG="$2"; shift 2 ;;
    --project) PROJECT_NAME="$2"; shift 2 ;;
    --domain) PROJECT_DOMAIN="$2"; shift 2 ;;
    --events-dataset) EVENTS_DATASET="$2"; shift 2 ;;
    --logs-dataset) LOGS_DATASET="$2"; shift 2 ;;
    --skip-vercel) SKIP_VERCEL=1; shift ;;
    --skip-drain) SKIP_DRAIN=1; shift ;;
    --drain-only) DRAIN_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown flag: $1"; usage ;;
  esac
done

GCP_PROJECT_ID="${GCP_PROJECT_ID:?--gcp or GCP_PROJECT_ID required}"
EVENTS_DATASET="${EVENTS_DATASET:-events}"
LOGS_DATASET="${LOGS_DATASET:-logs}"
POOL_ID="${POOL_ID:-vercel}"
PROVIDER_ID="${PROVIDER_ID:-vercel}"
SA_NAME="${SA_NAME:-vercel-bq}"

GCP_PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Vercel REST helpers (bypass `vercel env` CLI which rejects preview without
# --git-branch and which gets confused in monorepos)
# ---------------------------------------------------------------------------

resolve_vercel_ids() {
  : "${VERCEL_TOKEN:?Set VERCEL_TOKEN to a team-scope token from vercel.com/account/tokens}"
  : "${TEAM_SLUG:?--team or TEAM_SLUG required}"
  : "${PROJECT_NAME:?--project or PROJECT_NAME required}"

  VERCEL_TEAM_ID=$(curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v2/teams?slug=${TEAM_SLUG}" | jq -r '.id // empty')
  [[ -z "$VERCEL_TEAM_ID" ]] && { red "Could not resolve Vercel team for slug ${TEAM_SLUG}"; exit 1; }

  VERCEL_PROJECT_ID=$(curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/${PROJECT_NAME}?teamId=${VERCEL_TEAM_ID}" | jq -r '.id // empty')
  [[ -z "$VERCEL_PROJECT_ID" ]] && { red "Could not resolve Vercel project ${PROJECT_NAME}"; exit 1; }
}

push_env_rest() {
  local key="$1"; local value="$2"
  # Find existing env var(s) with this key — Vercel returns one per environment
  # but you can update via DELETE+POST.
  local ids
  ids=$(curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env?teamId=${VERCEL_TEAM_ID}" \
    | jq -r ".envs[]? | select(.key == \"${key}\") | .id" || true)
  for id in $ids; do
    curl -sf -X DELETE -H "Authorization: Bearer $VERCEL_TOKEN" \
      "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env/${id}?teamId=${VERCEL_TEAM_ID}" >/dev/null || true
  done

  local payload
  payload=$(jq -n --arg k "$key" --arg v "$value" \
    '{key:$k, value:$v, target:["production","preview","development"], type:"encrypted"}')

  local resp http_code
  resp=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?teamId=${VERCEL_TEAM_ID}" \
    -d "$payload")
  http_code=$(printf '%s\n' "$resp" | tail -1)
  if [[ "$http_code" != 2* ]]; then
    red "  failed to set ${key} (HTTP ${http_code}):"
    printf '%s\n' "$resp" | head -n -1 | head -200
    exit 1
  fi
  green "  set ${key}"
}

# ===========================================================================
# Drain-only mode: skip ahead
# ===========================================================================

if [[ $DRAIN_ONLY -eq 1 ]]; then
  PROJECT_DOMAIN="${PROJECT_DOMAIN:?--domain or PROJECT_DOMAIN required for drain step}"
  resolve_vercel_ids
  goto_drain=1
fi

# ===========================================================================
[[ ${goto_drain:-0} -eq 0 ]] && {
blue "[1/6] Enable required Google APIs"
# ===========================================================================

gcloud services enable \
  bigquery.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="$GCP_PROJECT_ID" >/dev/null
green "  enabled bigquery, iam, iamcredentials, sts"

# ===========================================================================
blue "[2/6] BigQuery datasets + tables"
# ===========================================================================

if ! bq --project_id="$GCP_PROJECT_ID" show --dataset "${EVENTS_DATASET}" >/dev/null 2>&1; then
  bq --project_id="$GCP_PROJECT_ID" mk --location=US --dataset "${EVENTS_DATASET}"
  green "  created dataset ${EVENTS_DATASET}"
else
  green "  dataset ${EVENTS_DATASET} exists"
fi

if ! bq --project_id="$GCP_PROJECT_ID" show --dataset "${LOGS_DATASET}" >/dev/null 2>&1; then
  bq --project_id="$GCP_PROJECT_ID" mk --location=US --dataset "${LOGS_DATASET}"
  green "  created dataset ${LOGS_DATASET}"
else
  green "  dataset ${LOGS_DATASET} exists"
fi

TMPSQL="$(mktemp)"
sed -e "s/@@EVENTS_DATASET@@/${EVENTS_DATASET}/g" \
    -e "s/@@LOGS_DATASET@@/${LOGS_DATASET}/g" \
    "${REPO_ROOT}/sql/tables.sql" > "$TMPSQL"

bq --project_id="$GCP_PROJECT_ID" query --use_legacy_sql=false --quiet < "$TMPSQL" >/dev/null
green "  tables + views applied"
rm -f "$TMPSQL"

if [[ $SKIP_VERCEL -eq 1 ]]; then
  green "Done (skipped Vercel + WIF setup as requested)"
  exit 0
fi

TEAM_SLUG="${TEAM_SLUG:?--team or TEAM_SLUG required}"
PROJECT_NAME="${PROJECT_NAME:?--project or PROJECT_NAME required}"

# ===========================================================================
blue "[3/6] Workload Identity Federation pool + provider"
# ===========================================================================

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
      --project="$GCP_PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$GCP_PROJECT_ID" --location=global --display-name="Vercel" >/dev/null
  green "  created pool ${POOL_ID}"
else
  green "  pool ${POOL_ID} exists"
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
      --project="$GCP_PROJECT_ID" --location=global \
      --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$GCP_PROJECT_ID" --location=global \
    --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://oidc.vercel.com/${TEAM_SLUG}" \
    --allowed-audiences="https://vercel.com/${TEAM_SLUG}" \
    --attribute-mapping="google.subject=assertion.sub,attribute.aud=assertion.aud,attribute.owner=assertion.owner,attribute.project=assertion.project,attribute.environment=assertion.environment" \
    --attribute-condition="assertion.owner=='${TEAM_SLUG}' && assertion.project=='${PROJECT_NAME}'" >/dev/null
  green "  created OIDC provider ${PROVIDER_ID}"
else
  green "  provider ${PROVIDER_ID} exists"
fi

# ===========================================================================
blue "[4/6] Service account + IAM"
# ===========================================================================

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --project="$GCP_PROJECT_ID" \
    --display-name="bq-analytics writer" >/dev/null
  green "  created service account ${SA_NAME}"
else
  green "  service account ${SA_NAME} exists"
fi

# Project-level dataEditor + jobUser. Dataset-scoped bindings via `bq` were
# unreliable in testing — `bq add-iam-policy-binding` requires allowlisting,
# and `bq update --source` normalised the role to legacy WRITER which didn't
# grant streaming-insert permission in some environments. Project-level
# bindings via gcloud reliably grant the required permissions.
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.dataEditor" --condition=None >/dev/null
green "  granted bigquery.dataEditor (project-level — needed for tables.updateData)"

# jobUser is needed for anyone running `bq query` with this SA (CI scripts,
# scheduled exports, etc). Streaming insertAll alone doesn't need it; we
# include it because it's the same SA most teams use for the analyst path.
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.jobUser" --condition=None >/dev/null
green "  granted bigquery.jobUser"

for env in production preview development; do
  gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --project="$GCP_PROJECT_ID" \
    --role=roles/iam.workloadIdentityUser \
    --member="principal://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/owner:${TEAM_SLUG}:project:${PROJECT_NAME}:environment:${env}" \
    --condition=None >/dev/null
done
green "  bound Vercel principals (production, preview, development)"

# ===========================================================================
blue "[5/6] Push env vars to Vercel (via REST)"
# ===========================================================================

resolve_vercel_ids

push_env_rest GCP_PROJECT_ID                     "$GCP_PROJECT_ID"
push_env_rest GCP_PROJECT_NUMBER                 "$GCP_PROJECT_NUMBER"
push_env_rest GCP_SERVICE_ACCOUNT_EMAIL          "$SA_EMAIL"
push_env_rest GCP_WORKLOAD_IDENTITY_POOL_ID      "$POOL_ID"
push_env_rest GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID "$PROVIDER_ID"
push_env_rest BQ_EVENTS_DATASET                  "$EVENTS_DATASET"
push_env_rest BQ_LOGS_DATASET                    "$LOGS_DATASET"

# Team-level x-vercel-verify token. Vercel's modern drain validator probes
# the URL with a GET (no headers) and requires the response to carry
# `x-vercel-verify: <team-token>`. Pushing it now lets the route handler
# return it unconditionally via createLogDrainRoute({ vercelVerifyToken }).
VERCEL_VERIFY_TOKEN_VAL=$(curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/teams/${VERCEL_TEAM_ID}" \
  | jq -r '.x_vercel_verify // empty' 2>/dev/null || true)
if [[ -n "$VERCEL_VERIFY_TOKEN_VAL" ]]; then
  push_env_rest VERCEL_VERIFY_TOKEN              "$VERCEL_VERIFY_TOKEN_VAL"
else
  yellow "  could not auto-fetch VERCEL_VERIFY_TOKEN from team API."
  yellow "  Drain creation may fail validation; if so, get the token from the"
  yellow "  422 response body and run:"
  yellow "    echo '<token>' | vercel env add VERCEL_VERIFY_TOKEN production"
fi

}  # end of "not drain-only" block

# ===========================================================================
blue "[6/6] Vercel Log Drain"
# ===========================================================================

if [[ $SKIP_DRAIN -eq 1 ]]; then
  yellow "  skipped (--skip-drain)"
  green "Done."
  yellow "  → After your first deploy, re-run: $0 --drain-only --gcp $GCP_PROJECT_ID --team $TEAM_SLUG --project $PROJECT_NAME --domain <YOUR_DOMAIN>"
  exit 0
fi

PROJECT_DOMAIN="${PROJECT_DOMAIN:?--domain or PROJECT_DOMAIN required for drain setup}"

# Re-resolve in case --drain-only entered without going through step 5
[[ -z "${VERCEL_PROJECT_ID:-}" ]] && resolve_vercel_ids

# Reuse existing secret if drain already exists; otherwise generate
EXISTING=$(curl -sH "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v1/log-drains?teamId=${VERCEL_TEAM_ID}&projectId=${VERCEL_PROJECT_ID}" \
  | jq -r '.[]? | select(.name == "bq-analytics") | .id' || true)
if [[ -n "$EXISTING" ]]; then
  curl -sX DELETE -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v1/log-drains/${EXISTING}?teamId=${VERCEL_TEAM_ID}" >/dev/null
  green "  removed existing drain ${EXISTING}"
fi

LOG_DRAIN_SECRET=$(openssl rand -hex 32)
push_env_rest LOG_DRAIN_SECRET "$LOG_DRAIN_SECRET"

DRAIN_BODY=$(cat <<JSON
{
  "name": "bq-analytics",
  "url": "https://${PROJECT_DOMAIN}/api/internal/log-drain",
  "deliveryFormat": "ndjson",
  "sources": ["lambda", "edge", "static", "external"],
  "environments": ["production"],
  "projectIds": ["${VERCEL_PROJECT_ID}"],
  "headers": { "x-drain-secret": "${LOG_DRAIN_SECRET}" },
  "samplingRate": 1
}
JSON
)

DRAIN_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" \
  "https://api.vercel.com/v1/log-drains?teamId=${VERCEL_TEAM_ID}" \
  -d "$DRAIN_BODY")
DRAIN_HTTP=$(printf '%s\n' "$DRAIN_RESP" | tail -1)
DRAIN_BODY_RESP=$(printf '%s\n' "$DRAIN_RESP" | head -n -1)

if [[ "$DRAIN_HTTP" == 2* ]]; then
  DRAIN_ID=$(printf '%s' "$DRAIN_BODY_RESP" | jq -r '.id // empty')
  green "  created log drain ${DRAIN_ID} → https://${PROJECT_DOMAIN}/api/internal/log-drain"
else
  red "  log drain creation failed (HTTP ${DRAIN_HTTP}):"
  printf '%s\n' "$DRAIN_BODY_RESP" | jq . 2>/dev/null || printf '%s\n' "$DRAIN_BODY_RESP"
  echo

  # Try to extract verify token from the error response (40-char hex blob)
  TOK=$(printf '%s' "$DRAIN_BODY_RESP" | grep -oE '[a-f0-9]{40}' | head -1)
  if [[ -n "$TOK" ]]; then
    yellow "  Detected expected x-vercel-verify token in error response: $TOK"
    yellow "  Pushing as VERCEL_VERIFY_TOKEN..."
    push_env_rest VERCEL_VERIFY_TOKEN "$TOK"
    yellow ""
    yellow "  Now:"
    yellow "    1. Make sure src/app/api/internal/log-drain/route.ts passes the token:"
    yellow "         createLogDrainRoute({"
    yellow "           ...,"
    yellow "           vercelVerifyToken: process.env.VERCEL_VERIFY_TOKEN,"
    yellow "         });"
    yellow "    2. git push to redeploy with the new env var"
    yellow "    3. Re-run with --drain-only:"
    yellow "         $0 --drain-only --gcp $GCP_PROJECT_ID --team $TEAM_SLUG --project $PROJECT_NAME --domain $PROJECT_DOMAIN"
  else
    yellow "  Vercel validates drain URLs by GET-probing them and requiring the"
    yellow "  response to carry x-vercel-verify: <team-token>. Likely causes:"
    yellow "    - The route URL isn't deployed yet — deploy first, then re-run --drain-only"
    yellow "    - Or VERCEL_VERIFY_TOKEN env var wasn't pushed (check above)"
    yellow ""
    yellow "  Confirm POST + GET are both exported from your log-drain/route.ts."
  fi
  exit 1
fi

green "Done."
echo
echo "Next steps:"
echo "  1. Add the route handlers to your Next.js app (see install skill / README)"
echo "  2. Redeploy your Vercel project so the new env vars take effect"
echo "  3. To test locally with real BQ:  vercel env pull .env.local"
