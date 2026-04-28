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
  echo "→ DRY: would bump $CURRENT ($BUMP), tag, and push"
  npm pack --dry-run 2>&1 | tail -10
  exit 0
fi

echo "→ bump $BUMP"
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "  -> $NEW_VERSION"

echo "→ commit + tag"
git add package.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo "→ push (triggers CI publish)"
git push --follow-tags

echo
echo "Tagged v${NEW_VERSION} and pushed."
echo "CI is publishing now — watch it at:"
echo "  https://github.com/johnkueh/bq-analytics/actions"
echo "Verify the published version with:"
echo "  npm view bq-analytics version"
