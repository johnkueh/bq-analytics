# bq-analytics — Claude notes

## Releases publish on tag push, NOT on branch push

`.github/workflows/release.yml` is gated on `tags: ["v*"]`. Pushing a
commit to `main` does **not** publish to npm. CI only runs when a
`v*` tag is pushed.

To ship a fix to npm:

```sh
pnpm release           # patch (0.x.0 -> 0.x.1)
pnpm release minor     # 0.x.0 -> 0.(x+1).0
pnpm release major     # 1.0.0 -> 2.0.0
```

`scripts/release.sh` checks the working tree is clean, bumps the
version in `package.json`, commits as `release: vX.Y.Z`, creates an
annotated `vX.Y.Z` tag, and `git push --follow-tags`. The tag push is
what triggers the workflow → `npm publish` (OIDC trusted publisher,
no token needed).

If you push a fix to `main` without running `pnpm release`, it sits
on `main` unreleased. There is no auto-tagger.

Verify after release:

```sh
npm view bq-analytics version
gh -R johnkueh/bq-analytics run list --limit 3
```
