#!/usr/bin/env bash
#
# bq-analytics — destructive teardown for one project's resources.
# Use with care. Prompts before each deletion.

set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
EVENTS_DATASET="${EVENTS_DATASET:-events}"
LOGS_DATASET="${LOGS_DATASET:-logs}"
POOL_ID="${POOL_ID:-vercel}"
SA_NAME="${SA_NAME:-vercel-bq}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

confirm() { read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[yY]$ ]]; }

echo "About to tear down bq-analytics resources in $GCP_PROJECT_ID."
confirm "Drop datasets $EVENTS_DATASET and $LOGS_DATASET (with all data)?" && {
  bq --project_id="$GCP_PROJECT_ID" rm -r -f --dataset "$EVENTS_DATASET" || true
  bq --project_id="$GCP_PROJECT_ID" rm -r -f --dataset "$LOGS_DATASET" || true
}
confirm "Delete service account $SA_EMAIL?" && {
  gcloud iam service-accounts delete "$SA_EMAIL" --project="$GCP_PROJECT_ID" --quiet || true
}
confirm "Delete WIF pool $POOL_ID (this is reversible — pools can be undeleted within 30 days)?" && {
  gcloud iam workload-identity-pools delete "$POOL_ID" --project="$GCP_PROJECT_ID" --location=global --quiet || true
}

echo "Done. Vercel env vars + log drains were left untouched — remove via dashboard if needed."
