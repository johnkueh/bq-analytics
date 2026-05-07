#!/usr/bin/env bash
#
# Release helper — bumps version, commits, tags, pushes.
#
# Publishing happens in CI via .github/workflows/release.yml using npm's
# Trusted Publisher (OIDC) — no NPM_TOKEN secret needed. Pushing a v* tag
# triggers the workflow.
#
# Usage:
#   pnpm release              # patch bump (0.1.0 -> 0.1.1)
#   pnpm release minor        # 0.1.0 -> 0.2.0
#   pnpm release major        # 0.1.0 -> 1.0.0
#   DRY=1 pnpm release        # show what would happen, no changes
#
# Pre-flight: clean working tree, on main, all tests pass.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"
DRY="${DRY:-0}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty — commit or stash first." >&2
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Not on main (on '$BRANCH'). Switch to main first." >&2
  exit 1
fi

git pull --ff-only

echo "→ build + test"
pnpm build >/dev/null
pnpm test >/dev/null
echo "  ok"

if [[ "$DRY" == "1" ]]; then
  CURRENT=$(jq -r .version package.json)
  PLUGIN_CURRENT=$(jq -r .version .claude-plugin/plugin.json)
  echo "→ DRY: would bump $CURRENT ($BUMP), tag, and push"
  echo "       plugin.json currently $PLUGIN_CURRENT — would match new version"
  npm pack --dry-run 2>&1 | tail -10
  exit 0
fi

echo "→ bump $BUMP"
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "  -> $NEW_VERSION"

# Keep the Claude Code plugin manifest in lockstep with the SDK version, so
# /plugin install pins the same release as `pnpm add bq-analytics`.
PLUGIN_JSON=".claude-plugin/plugin.json"
TMP=$(mktemp)
jq --arg v "$NEW_VERSION" '.version = $v' "$PLUGIN_JSON" > "$TMP" && mv "$TMP" "$PLUGIN_JSON"

echo "→ commit + tag"
git add package.json "$PLUGIN_JSON"
git commit -m "release: v${NEW_VERSION}"
# Annotated tag — required for `git push --follow-tags`. Lightweight tags
# wouldn't be pushed and the CI workflow wouldn't fire.
git tag -a "v${NEW_VERSION}" -m "release v${NEW_VERSION}"

echo "→ push (triggers CI publish)"
git push --follow-tags
# Belt-and-suspenders: explicitly push the tag in case --follow-tags missed it.
git push origin "v${NEW_VERSION}" 2>/dev/null || true

echo
echo "Tagged v${NEW_VERSION} and pushed."
echo "CI is publishing now — watch it at:"
echo "  https://github.com/johnkueh/bq-analytics/actions"
echo "Verify the published version with:"
echo "  npm view bq-analytics version"
