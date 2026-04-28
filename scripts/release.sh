#!/usr/bin/env bash
#
# Release helper — bumps version, builds, publishes to npm, tags, pushes.
#
# Auth path:
#   1. Granular Access Token in ~/.npmrc with bypass-2FA enabled
#      //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx
#      → npm publish runs without OTP prompt
#   2. Or, in CI via GitHub Actions trusted publisher (no token in repo).
#      See .github/workflows/release.yml
#
# Usage:
#   pnpm release              # patch bump (0.1.0 -> 0.1.1)
#   pnpm release minor        # 0.1.0 -> 0.2.0
#   pnpm release major        # 0.1.0 -> 1.0.0
#   DRY=1 pnpm release        # show what would happen
#
# Pre-flight: clean working tree, on main branch, all tests pass.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"
DRY="${DRY:-0}"

# Pre-flight
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
  echo "→ DRY: would bump $BUMP and publish"
  npm pack --dry-run 2>&1 | tail -10
  exit 0
fi

echo "→ bump $BUMP"
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "  -> $NEW_VERSION"

echo "→ publish to npm"
npm publish --access public

echo "→ commit + tag + push"
git add package.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push --follow-tags

echo
echo "Released bq-analytics@${NEW_VERSION}"
echo "https://www.npmjs.com/package/bq-analytics"
