#!/usr/bin/env bash
#
# bq-analytics — copy skill files into the johnkueh/claude-skills marketplace
# repo and bump its plugin.json version.
#
# Usage:
#   ./scripts/sync-skills.sh                       # default destination ~/Projects/claude-skills
#   MARKETPLACE_DIR=/path/to/repo ./scripts/sync-skills.sh
#
# Re-runnable. Stops if the marketplace dir doesn't exist.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKETPLACE_DIR="${MARKETPLACE_DIR:-${HOME}/Projects/claude-skills}"

if [[ ! -d "${MARKETPLACE_DIR}/.claude-plugin" ]]; then
  echo "marketplace not found at ${MARKETPLACE_DIR}" >&2
  exit 1
fi

PLUGIN_JSON="${MARKETPLACE_DIR}/.claude-plugin/plugin.json"
MARKETPLACE_JSON="${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"

# Copy skill files + ensure each is registered in marketplace.json
for skill in install query flags release; do
  src="${REPO_ROOT}/claude-skills/${skill}/SKILL.md"
  dest_dir="${MARKETPLACE_DIR}/skills/bq-analytics-${skill}"
  mkdir -p "$dest_dir"
  cp "$src" "${dest_dir}/SKILL.md"
  echo "synced bq-analytics-${skill}"

  # Append to plugins[0].skills if missing
  ref="./skills/bq-analytics-${skill}"
  has=$(jq --arg r "$ref" '.plugins[0].skills | index($r)' "$MARKETPLACE_JSON")
  if [[ "$has" == "null" ]]; then
    jq --arg r "$ref" '.plugins[0].skills += [$r]' "$MARKETPLACE_JSON" > "${MARKETPLACE_JSON}.tmp"
    mv "${MARKETPLACE_JSON}.tmp" "$MARKETPLACE_JSON"
    echo "  registered ${ref} in marketplace.json"
  fi
done

# Bump patch version (e.g. 1.3.0 -> 1.3.1)
current=$(jq -r .version "$PLUGIN_JSON")
IFS='.' read -r major minor patch <<<"$current"
new_version="${major}.${minor}.$((patch + 1))"
jq --arg v "$new_version" '.version = $v' "$PLUGIN_JSON" > "${PLUGIN_JSON}.tmp"
mv "${PLUGIN_JSON}.tmp" "$PLUGIN_JSON"
echo "bumped version: ${current} -> ${new_version}"

echo
echo "Next steps:"
echo "  cd ${MARKETPLACE_DIR}"
echo "  git diff   # review"
echo "  git add -A && git commit -m \"bq-analytics skills sync ${new_version}\" && git push"
