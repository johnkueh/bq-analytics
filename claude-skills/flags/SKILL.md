---
name: bq-analytics-flags
description: Manage feature flags in a bq-analytics project — flip on/off, change rollout %, manage allowlists, materialize cohorts from BigQuery, and evaluate flag impact. Backed by Vercel Edge Config; exposures auto-track to events.raw.
---

# Managing bq-analytics feature flags

Flags live in a single Vercel Edge Config item under the key `flags`. The
SDK reads at runtime via `edgeConfigSource()`; you mutate via the
`bq-flags` CLI shipped in this package. Propagation is sub-second.

```json
{
  "new-checkout":   { "on": true, "rollout": 0.5 },
  "ai-suggestions": { "on": true, "users": ["u_john", "u_beta1"] },
  "kill-old-flow":  { "on": false }
}
```

## Step 0 — Setup (one-time per repo)

If `.env.local` does not contain `EDGE_CONFIG=`:

```bash
./scripts/setup-edge-config.sh
```

This creates an Edge Config store, mints a read token, sets `EDGE_CONFIG`
on Vercel Production, and pulls it into `.env.local`. Idempotent.

After install, you also have the `bq-flags` CLI on PATH (via
`./scripts/bq-flags` from the repo, or `pnpm exec bq-flags` once
installed as a dependency).

## Common operations — use the CLI

```bash
bq-flags list                                        # current state
bq-flags get new-checkout                            # one flag's JSON
bq-flags raw                                         # full flags object

bq-flags on  new-checkout --rollout 25%              # create / turn on
bq-flags on  new-checkout --rollout 50% --users u_a,u_b
bq-flags rollout new-checkout 100%                   # ramp to everyone
bq-flags off new-checkout                            # kill switch

bq-flags allow    ai-suggestions u_alice u_bob       # add to allowlist
bq-flags disallow ai-suggestions u_alice             # remove
bq-flags delete   ai-suggestions                     # remove flag entirely
```

`--rollout` accepts `0..1`, `0..100`, or `N%`. Allowlists are deduped.
All mutations are read-modify-write under the hood; safe to interleave.

## Materializing a cohort from BigQuery

When the user asks "turn on `ai-suggestions` for all Pro users who imported
3+ videos":

1. Translate to BigQuery against `events.users` / `events.raw`. Always
   return a deduped `user_id[]`:

   ```sql
   SELECT user_id FROM `proj.events.users` u
   JOIN (
     SELECT user_id, COUNT(*) c FROM `proj.events.raw`
     WHERE event_name = 'import.completed'
     GROUP BY 1 HAVING c >= 3
   ) i USING (user_id)
   WHERE JSON_VALUE(u.traits, '$.plan') = 'pro'
   ```

2. Run via the `bq-analytics-query` skill or `bq query --format=csv`,
   capture the user IDs, then pipe into `bq-flags allow`:

   ```bash
   USERS=$(bq query --nouse_legacy_sql --format=csv --quiet "<query>" \
     | tail -n +2 | tr '\n' ' ')

   # Restrict to allowlist only:
   bq-flags on ai-suggestions --rollout 0
   bq-flags allow ai-suggestions $USERS
   ```

   `--rollout 0` means "nobody by default"; `allow` adds the cohort.

Static lists go stale. Re-run on cadence (cron / `/loop` / weekly).

## Evaluating impact

The SDK auto-emits `$flag_called` exposure events to `events.raw`. The CLI
runs the standard analysis:

```bash
bq-flags eval new-checkout                                  # coverage only
bq-flags eval new-checkout --outcome subscription.started   # adds lift
bq-flags eval new-checkout --outcome subscription.started --days 30
```

This prints `(variant, users, exposures)` coverage and (with `--outcome`)
`(variant_on, users, conversions, rate_pct)` for first-exposure ITT lift.

Compute `lift = (on_rate - off_rate) / off_rate`. Flag borderline results
to the user before adding sequential / chi-square stats.

If `bq-flags eval` complains about `GCP_PROJECT_ID`, pass it:

```bash
bq-flags eval new-checkout --project my-gcp-project --dataset events
```

## Where flags evaluate

| Runtime | Pattern | Source |
|---|---|---|
| Next.js / Hono / Node server | direct read from Edge Config | `edgeConfigSource()` |
| Node CLI | direct read | `edgeConfigSource({ connectionString: process.env.EDGE_CONFIG })` |
| Browser (Next.js client) | fetch from `/api/flags` route | `httpSource({ url: '/api/flags' })` |
| React Native / Expo | fetch from your API server | `httpSource({ url: \`\${API_URL}/api/flags\`, headers: ... })` |

Server code consumes Edge Config directly (no HTTP). Browser/RN MUST go
through your own `/api/flags` route — never expose the EDGE_CONFIG token
to clients. The route is one line:

```ts
// src/app/api/flags/route.ts
export { createFlagsRoute as GET } from "bq-analytics/next";
```

Pass `resolveUser` to authenticate, or `filter` to strip `users[]`
allowlists before they hit the wire.

## Removing the Edge Config (full teardown)

Skip unless the user explicitly asks. Destructive.

```bash
EC_ID=$(grep '^EDGE_CONFIG=' .env.local | sed -E 's|.*/(ecfg_[^?]+)\?.*|\1|')
vercel edge-config remove "$EC_ID"
vercel env rm EDGE_CONFIG production
```

## Notes

- 512 KB total store cap, 8 KB per-item — don't put more than ~20k user
  IDs in a single allowlist. Past that, materialise in a separate flag
  per cohort or move to attribute-based gating in code.
- Exposure event name is `$flag_called` unless overridden. Match in SQL.
- Edge Config writes propagate in <1s globally. Reads take 8–15ms warm.
