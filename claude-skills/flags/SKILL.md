---
name: bq-analytics-flags
description: Add feature flags to a project that already has (or is adding) bq-analytics, then operate them — flip on/off, change rollout %, manage allowlists, materialize cohorts from BigQuery, and evaluate flag impact. Backed by Vercel Edge Config; exposures auto-track to events.raw. Use when the user wants flags, says "add flags", or asks how to ramp / kill / experiment with a feature.
---

# bq-analytics feature flags

Flags live in a single Vercel Edge Config item under the key `flags`. The
SDK reads at runtime via `edgeConfigSource()`; you mutate via the
`bq-flags` CLI shipped in the package. Propagation is sub-second.

```json
{
  "new-checkout":   { "on": true, "rollout": 0.5 },
  "ai-suggestions": { "on": true, "users": ["u_john", "u_beta1"] },
  "kill-old-flow":  { "on": false }
}
```

## Detect current state

Before doing anything, figure out which path you're on:

| Signal | What it means | Where to start |
|---|---|---|
| `bq-analytics` in `package.json` deps **and** `EDGE_CONFIG=` in `.env.local` | fully wired | jump to **Operate** |
| `bq-analytics` in deps, no `EDGE_CONFIG=` | events wired, flags not yet | **Step 1** below |
| neither | greenfield | run `/bq-analytics-install` first; it handles flags as Phase 3 |

```bash
grep -E '"bq-analytics"' package.json && echo "sdk present"
grep -E '^EDGE_CONFIG=' .env.local 2>/dev/null && echo "edge config provisioned"
```

## Step 1 — Add the flag dependency

```bash
pnpm add bq-analytics @vercel/edge-config
# or: npm i / yarn add
```

`@vercel/edge-config` is an optional peer of `bq-analytics`. Only needed
when using `edgeConfigSource()` server-side; browser/RN clients use
`httpSource()` and don't need it.

## Step 2 — Provision Edge Config

```bash
./node_modules/bq-analytics/scripts/setup-edge-config.sh
```

What it does (idempotent — safe to re-run):

1. `vercel link` if not already linked
2. Creates an Edge Config store named `bq-analytics-flags` (or reuses one
   with that slug)
3. Initializes the `flags` key as `{}`
4. Mints a read token, pushes `EDGE_CONFIG` env var to **Vercel Production**
5. `vercel env pull .env.local --environment production` so local dev
   can read it

Note: only Production is set automatically (CLI quirk on preview/dev
envs). For full env propagation, set `VERCEL_TOKEN` first, or replicate
via the Vercel dashboard.

After this, `bq-flags` is available via `pnpm exec bq-flags` (or
`./node_modules/.bin/bq-flags`).

## Step 3 — Wire the SDK

Pick the surfaces relevant to the project. Skip any that don't apply.

### Server (Next.js / Hono / Node on Vercel)

Drop a singleton next to your existing analytics one:

```ts
// src/lib/flags.ts
import { Flags } from "bq-analytics";
import { edgeConfigSource } from "bq-analytics/edge-config";
import { analytics } from "./analytics";

declare global { var __bqf: Flags | undefined; }
export function flags() {
  return globalThis.__bqf ??= new Flags({
    source: edgeConfigSource(),
    analytics: analytics(),       // emits "$flag_called" exposures
    refreshIntervalMs: 60_000,    // pull updates every 60s
  });
}
```

Use anywhere on the server:

```ts
import { flags } from "@/lib/flags";
await flags().ready();
if (flags().isOn("new-checkout", userId)) { /* new flow */ }
```

### Browser / Expo / RN — never expose the Edge Config token

Drop a `/api/flags` route on the server first (one line):

```ts
// src/app/api/flags/route.ts (Next.js App Router)
import { createFlagsRoute } from "bq-analytics/next";
export const GET = createFlagsRoute({
  resolveUser: async (req) => /* same auth as /api/track */ null,
  filter: (flags) => Object.fromEntries(            // strip allowlists
    Object.entries(flags).map(([k, v]) => [k, { ...v, users: undefined }]),
  ),
});
```

Then on the client:

```ts
// browser
import { Flags, httpSource } from "bq-analytics";
const flags = new Flags({ source: httpSource({ url: "/api/flags" }) });
await flags.ready();
flags.isOn("new-checkout", userId);

// Expo / RN — point at your hosted API
const flags = new Flags({
  source: httpSource({
    url: `${API_URL}/api/flags`,
    headers: { authorization: `Bearer ${deviceToken}` },
  }),
});
```

### Verify the install

```bash
pnpm exec bq-flags on smoke-test --rollout 100%
pnpm exec bq-flags list                # shows smoke-test row
pnpm exec bq-flags delete smoke-test
```

Then in code, gate something on a flag, redeploy, and confirm exposures
land in BigQuery:

```sh
bq query --nouse_legacy_sql --format=pretty \
  "SELECT * FROM \`<gcp>.events.raw\` WHERE event_name = '\$flag_called' ORDER BY ts DESC LIMIT 5"
```

## Operate

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
