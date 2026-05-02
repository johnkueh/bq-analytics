# bq-analytics

Tiny analytics SDK that sends events directly to BigQuery. PostHog/Segment-shaped API. Queryable from `bq` CLI — designed for AI agents (Claude Code etc.) to drive analysis instead of dashboards.

- **~$0/month at indie scale.** 5M events/mo fits inside BigQuery's free tiers (2 TiB streaming ingest + 10 GB storage + 1 TB query).
- **No vendor lock-in.** Data lives in your own GCP project. Migrate to ClickHouse/DuckDB/Tinybird with one `bq extract`.
- **Works on Vercel + Next.js, Expo / React Native, browser, CLI, anywhere with `fetch`.**
- **No queue infra to run.** Browser/RN persist failed batches locally; Vercel Log Drain retries the logs pipeline at-least-once. Server-side `track()` calls have the same in-memory-only durability as PostHog/Segment/Amplitude — see [Durability](#durability) below.
- **Auth via Vercel OIDC → GCP Workload Identity Federation.** No service-account JSON keys.

## Why not PostHog?

| | PostHog Cloud | bq-analytics |
|---|---|---|
| 100k events/mo | $0 | $0 |
| 5M events/mo | ~$153 | ~$0–1 |
| Mobile (Expo / RN) | yes | yes |
| CLI access for ad-hoc queries | weak (HogQL via REST) | excellent (`bq query`) |
| Data lives in | PostHog's ClickHouse | your GCP project |
| Feature flags | yes (rich UI) | yes (config-as-data, CLI, no UI) |
| Ops | none | one shell script per project |

If you want PostHog's UI and replays, use PostHog. If you mostly want event analytics + flags that an AI agent can query and operate, this is cheaper and your data stays yours.

## Coverage matrix

| Runtime | Manual log | Auto request logs | Auto error capture | Lifecycle flush |
|---|---|---|---|---|
| Next.js (Vercel) | `analytics.log()` | Vercel Log Drain *or* pino | `process.on("uncaughtException")` | `after(() => flush())` |
| Express / Hono / Fastify / Koa / raw Node | `analytics.log()` *or* `logger.info()` | `bq-analytics/pino` + `pino-http` (or framework logger) | `attachCliHooks()` *or* framework error handler | `process.on("SIGTERM")` |
| Browser | `analytics.log()` | n/a | `attachWindowErrorHandler` | `attachBrowserAutoFlush` |
| Expo / RN | `analytics.log()` | n/a | `attachExpoErrorHandler` | `attachAppStateFlush` |
| Node CLI | `analytics.log()` | n/a | `attachCliHooks` | `attachCliHooks` (handles SIGINT/SIGTERM) |
| Non-Node (Python, Go, …) | POST to `/api/track` from your language | per-framework | per-language convention | per-language |

All runtimes write to the same BigQuery schema. Pick the right helper for your stack — see [Setup by stack](#setup-by-stack) for snippets.

## Quickstart

The fastest path is via the Claude Code marketplace — Claude drives the install for you.

```
# in any Claude Code session, one-time per machine
/plugin marketplace add johnkueh/claude-skills
/plugin install claude-skills@johnkueh-skills

# then in any project
/bq-analytics-install
```

Claude detects the runtime (Next.js / Express / Hono / Expo / CLI), runs the setup script, wires the route handlers, patches your auth middleware if needed, and tells you what to verify after deploy. Feature flags are an opt-in Phase 3 of the same install skill — `/bq-analytics-install` will offer to provision Edge Config + the `bq-flags` CLI if you want them.

If you'd rather do it manually:

```sh
pnpm add bq-analytics

# One-shot per project: BQ datasets + tables, Vercel OIDC, IAM bindings, log drain
TEAM_SLUG=acme PROJECT_NAME=my-app PROJECT_DOMAIN=www.example.com \
  VERCEL_TOKEN=... \
  ./node_modules/bq-analytics/scripts/setup-bq-oidc.sh --gcp my-gcp-project
```

Then in your Next.js app:

```ts
// src/app/api/track/route.ts
export { POST } from "bq-analytics/next/track-route";

// src/app/api/internal/log-drain/route.ts
export { POST } from "bq-analytics/next/log-drain-route";

// anywhere in server code
import { Analytics, bqTransport } from "bq-analytics";
const a = new Analytics({ transport: bqTransport({ projectId: "..." }) });
a.track("translation.started", { videoId: "abc" }, { userId: "u1" });
a.identify("u1", { plan: "pro", credits: 47 });
a.group("household", "h1", { size: 4 }, "u1");
a.log("info", "import worked", { source: "instagram" });
await a.flush();           // or in a Next route: after(() => a.flush())
```

Browser:

```ts
import { Analytics } from "bq-analytics";
import { browserTransport, attachBrowserAutoFlush } from "bq-analytics/browser";

const a = new Analytics({
  transport: browserTransport({ url: "/api/track" }),
});
attachBrowserAutoFlush(() => a.flush());
a.track("page.viewed", { path: location.pathname });
```

React Native (Expo):

```ts
import { Analytics } from "bq-analytics";
import { reactNativeTransport } from "bq-analytics/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const a = new Analytics({
  transport: reactNativeTransport({
    url: `${API_URL}/api/track`,
    headers: { authorization: `Bearer ${deviceToken}` },
    storage: AsyncStorage,
  }),
});
a.track("import.started", { source: "instagram" }, { userId });
```

## Setup by stack

Pick the section that matches your runtime. All write to the same `events.*` and `logs.*` tables.

### Next.js on Vercel

```ts
// src/app/api/track/route.ts
import { createTrackRoute } from "bq-analytics/next";
export const POST = createTrackRoute({
  projectId: process.env.GCP_PROJECT_ID!,
  resolveUser: async (req) => /* your auth lookup */ null,
});

// src/app/api/internal/log-drain/route.ts
import { createLogDrainRoute } from "bq-analytics/next";
export const POST = createLogDrainRoute({
  projectId: process.env.GCP_PROJECT_ID!,
  secret: process.env.LOG_DRAIN_SECRET!,
});

// src/lib/analytics.ts — server singleton
import { Analytics, bqTransport } from "bq-analytics";
declare global { var __bqa: Analytics | undefined; }
export function analytics() {
  return globalThis.__bqa ??= new Analytics({
    transport: bqTransport({ projectId: process.env.GCP_PROJECT_ID! }),
  });
}

// in any route handler
import { after } from "next/server";
analytics().track("foo", { ... }, { userId });
after(() => analytics().flush());
```

The setup script provisions the Vercel Log Drain pointed at `/api/internal/log-drain` automatically. If you prefer pino over Log Drain, swap to the **Express / Hono / Fastify** recipe — drain is optional.

### Express / Hono / Fastify / Koa / raw Node

```ts
import pino from "pino";
import { pinoBqTransport } from "bq-analytics/pino";
import { Analytics, bqTransport } from "bq-analytics";

const a = new Analytics({ transport: bqTransport({ projectId }) });
const logger = pino({}, pinoBqTransport({ projectId, analytics: a, source: "api" }));

// Express
import pinoHttp from "pino-http";
app.use(pinoHttp({ logger }));               // every request → logs.raw
app.post("/checkout", async (req, res) => {
  a.track("checkout.started", { plan: "pro" }, { userId: req.userId });
  res.json({ ok: true });
});
app.use((err, _req, _res, _next) => {        // capture errors
  a.log("error", err.message, { stack: err.stack }, "express");
});

// Hono — same pattern, swap pinoHttp for hono/logger
// Fastify — pass `logger` to Fastify({ logger }) directly (Fastify uses pino natively)

// Graceful shutdown — flush before SIGTERM kills you
process.on("SIGTERM", async () => { await a.flush(); process.exit(0); });
```

### Node CLI / scripts

```ts
import { Analytics, bqTransport } from "bq-analytics";
import { attachCliHooks } from "bq-analytics/cli";

const a = new Analytics({ transport: bqTransport({ projectId }) });
attachCliHooks(a, { source: "my-cli" });   // uncaught + unhandled + SIGINT/SIGTERM

a.track("cli.command_run", { command: process.argv[2] });
// ... do work ...
await a.flush();   // CRITICAL: process exits the moment you return
```

If your CLI talks to a hosted product (e.g. `subsrip` CLI hitting subs.rip), use `httpTransport` instead of `bqTransport` — same SDK, the events go through `/api/track` with an API key.

### Browser

```ts
import { Analytics } from "bq-analytics";
import {
  browserTransport,
  attachBrowserAutoFlush,
  attachWindowErrorHandler,
} from "bq-analytics/browser";

const a = new Analytics({ transport: browserTransport({ url: "/api/track" }) });
attachBrowserAutoFlush(() => a.flush());   // flush on pagehide / visibilitychange
attachWindowErrorHandler(a);               // uncaught + unhandledrejection → logs.raw

a.track("page.viewed", { path: location.pathname });
```

### Expo / React Native

```ts
import { Analytics } from "bq-analytics";
import {
  reactNativeTransport,
  attachExpoErrorHandler,
  attachAppStateFlush,
} from "bq-analytics/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";

const a = new Analytics({
  transport: reactNativeTransport({
    url: `${API_URL}/api/track`,
    headers: { authorization: `Bearer ${deviceToken}` },
    storage: AsyncStorage,
  }),
});

// Pass `attrs` as a getter when userId loads asynchronously (typical when
// identity comes from SecureStore / AsyncStorage). The closure resolves on
// every event, so userId reflects the current identity instead of whatever
// was set when the helpers were attached.
let currentUserId: string | undefined;
attachExpoErrorHandler(a, ErrorUtils, () => ({ platform: Platform.OS, userId: currentUserId }));
attachAppStateFlush(a, AppState, () => ({ userId: currentUserId }));

// later, when identity loads:
currentUserId = identity.deviceId;

a.track("import.started", { source: "instagram" }, { userId: currentUserId });
```

#### Recommended `identify()` traits for Expo apps

When you call `analytics.identify(deviceId, traits)`, include enough device
context that you can answer "which build was this user on?" without asking
them. The trait names below are a convention — bq-analytics doesn't enforce
them, but consistent names make BQ queries portable across consumers.

```ts
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

a.identify(deviceId, {
  platform: Platform.OS,                                    // "ios" | "android"
  app_version: Constants.expoConfig?.version ?? null,       // "1.4.2"
  build_number:                                             // TestFlight build
    Constants.expoConfig?.ios?.buildNumber ??
    String(Constants.expoConfig?.android?.versionCode ?? "") || null,
  ota_update_id: Updates.updateId,                          // null when on embedded JS
  ota_channel: Updates.channel,                             // "production" | "preview" | "development"
  runtime_version: Updates.runtimeVersion,                  // matches the native build
});
```

Why these specifically:

- **`ota_update_id`** is the only honest answer to "but I OTA'd!" — anything
  else relies on the user accurately reporting their bundle.
- **`build_number`** disambiguates TestFlight builds within the same
  marketing version.
- **`ota_channel`** lets you split queries by production / preview /
  development without joining anything else.

`identify` writes to `events.users` with last-write-wins semantics, so the
next OTA's `identify` call updates the row in place — `events.users` always
reflects each device's current build. Don't stamp these on every event row;
that bloats `events.raw` for no query benefit.

### Non-Node (Python, Go, Ruby)

There's no native SDK. POST events directly to your `/api/track` route from any HTTP client. The schema is `{ records: [{ kind: "event", row: {...} }, ...] }` — see `src/types.ts` for the row shapes.

## Product feedback

Optional. One method on the SDK accepts bug reports, feature requests, and general feedback into a dedicated `events.feedback` BigQuery table — joinable with `events.users` and `events.raw` on `user_id`, so a Claude agent has one query for "this user said the upload broke; what was actually happening at that moment?"

```ts
analytics.feedback(
  {
    kind: "bug",                          // "bug" | "request" | "general" | (custom)
    subject: "Translate button does nothing",
    message: "After uploading a video, the Translate button is unresponsive.",
    severity: "high",                     // free-text, optional
    url: "/translate",                    // path/route at submission time
    properties: { app_version: "1.4.2", platform: "ios" },
  },
  { userId, sessionId },
);
```

Same intake as `track`/`identify`/`group` — buffered and flushed via the same lifecycle. Browser/RN submissions ride `/api/track`; server and CLI write direct via `bqTransport`. Anonymous submissions are accepted (omit `userId`).

This is **intake + warehouse**, not a helpdesk. There's no inbox UI, threading, or status mutation — those belong in Linear/Plain/Pylon if you need them. The point here is "Claude has the full story when investigating."

### Schema

```sql
events.feedback   feedback_id, ts, kind, subject, message, severity, url,
                  user_id, anonymous_id, session_id, properties JSON
```

Partitioned by `DATE(ts)`, clustered on `(kind, user_id)`. The `properties` JSON column is open-ended — stamp `app_version`, `build_number`, `screen`, `device`, anything you want.

### Per-runtime

The same method works on every transport. Pick the lifecycle that matches:

```ts
// Browser — flushes on visibilitychange/pagehide via attachBrowserAutoFlush
analytics.feedback({ kind: "bug", message }, { userId });

// Expo / RN — same shape, persists to AsyncStorage on transport failure
analytics.feedback({ kind: "request", message, properties: { platform: Platform.OS } }, { userId });

// Server (Next.js) — flush via after()
analytics.feedback({ kind: "general", message }, { userId });
after(() => analytics.flush());

// CLI — flushAt: 1 or await flush() before exit
analytics.feedback({ kind: "bug", message: err.message }, { userId });
await analytics.flush();
```

### Investigating with full context

Join feedback to traits and recent events for the "what was happening" story:

```sql
WITH f AS (
  SELECT * FROM `proj.events.feedback`
  WHERE DATE(ts) > CURRENT_DATE() - 7 AND kind = 'bug'
)
SELECT
  f.feedback_id, f.ts AS reported_at, f.subject, f.message,
  JSON_VALUE(u.traits, '$.plan')        AS plan,
  JSON_VALUE(u.traits, '$.app_version') AS app_version,
  ARRAY(
    SELECT AS STRUCT e.event_name, e.ts
    FROM `proj.events.raw` e
    WHERE e.user_id = f.user_id
      AND e.ts BETWEEN TIMESTAMP_SUB(f.ts, INTERVAL 30 MINUTE) AND f.ts
    ORDER BY e.ts DESC LIMIT 20
  ) AS recent_events
FROM f
LEFT JOIN `proj.events.users` u USING (user_id)
ORDER BY f.ts DESC LIMIT 50;
```

That single query gives an agent: the bug report, the user's plan + build, and the last 30 minutes of their session. No cross-system stitching.

## Feature flags

Optional. Backed by Vercel Edge Config; sub-second propagation; ~free at indie scale; exposures auto-track to `events.raw` so impact analysis is just BigQuery.

```ts
// src/lib/flags.ts
import { Flags } from "bq-analytics";
import { edgeConfigSource } from "bq-analytics/edge-config";
import { analytics } from "./analytics";

export const flags = new Flags({
  source: edgeConfigSource(),
  analytics: analytics(),         // → emits "$flag_called" exposures
  refreshIntervalMs: 60_000,      // pull updates every 60s
});

// in any server code (Next.js, Hono, raw Node, CLI)
await flags.ready();
if (flags.isOn("new-checkout", userId)) { /* new flow */ }
```

Browser / RN / Expo clients should fetch via your own `/api/flags` route — never expose the Edge Config token to clients:

```ts
// src/app/api/flags/route.ts
// Use the dedicated subpath — pulls @vercel/edge-config only on this route,
// keeping the base `bq-analytics/next` import edge-config-free for /api/track etc.
import { createFlagsRoute } from "bq-analytics/next/flags";
export const GET = createFlagsRoute({
  resolveUser: async (req) => /* your auth */ null,
  filter: (flags) => Object.fromEntries(           // strip allowlists
    Object.entries(flags).map(([k, v]) => [k, { ...v, users: undefined }]),
  ),
});

// browser / RN
import { Flags, httpSource } from "bq-analytics";
const flags = new Flags({ source: httpSource({ url: "/api/flags" }) });
await flags.ready();
flags.isOn("new-checkout", userId);
```

### Setup (one-time per repo)

```sh
./scripts/setup-edge-config.sh
```

Provisions an Edge Config store, mints a read token, sets `EDGE_CONFIG` on Vercel Production, pulls into `.env.local`. Idempotent.

### Operating flags — `bq-flags` CLI

```sh
bq-flags list                                 # current state
bq-flags on  new-checkout --rollout 25%       # create / turn on at 25%
bq-flags rollout new-checkout 100%            # ramp
bq-flags allow ai-suggestions u_alice u_bob   # allowlist
bq-flags off new-checkout                     # kill switch
bq-flags eval new-checkout --outcome subscription.started
```

`eval` runs the standard exposure / lift queries against `events.raw`. See `claude-skills/flags/SKILL.md` for the full operations guide and the cohort-materialisation flow (BQ query → user_id list → allowlist).

### Flag config shape

Stored as one JSON object under the `flags` key in Edge Config:

```json
{
  "new-checkout":   { "on": true, "rollout": 0.5 },
  "ai-suggestions": { "on": true, "users": ["u_john", "u_beta1"] },
  "kill-old-flow":  { "on": false }
}
```

`rollout` is `0..1` (deterministic FNV-1a hash on `userId+key`). `users` is an allowlist that bypasses the rollout. Combine for "force-on for testers + N% rollout for everyone else."

### Per runtime

| Runtime | Flag source | Notes |
|---|---|---|
| Next.js / Hono / raw Node / CLI on Vercel | `edgeConfigSource()` | Direct Edge Config read, 8–15ms warm |
| Node CLI off-Vercel | `edgeConfigSource({ connectionString: ... })` | Pass token explicitly |
| Browser (Next.js client) | `httpSource({ url: "/api/flags" })` | Through your `/api/flags` route |
| React Native / Expo | `httpSource({ url: \`\${API_URL}/api/flags\` })` | Same — never expose Edge Config token |

## Release config (force-update + what's-new)

Optional. Server-driven release UX for Expo / React Native apps: force-update gate (hard block / soft nudge), post-update what's-new sheet, channel-aware store deeplinks. One opinionated Edge Config blob under the key `release`. Same store as flags is fine.

```ts
// src/app/api/release-config/route.ts (Next.js)
import { createReleaseConfigRoute } from "bq-analytics/next/release";
export const GET = createReleaseConfigRoute();
// Reads `release` from Edge Config, validates, returns JSON with 60s edge cache.
```

```tsx
// app/_layout.tsx (Expo / RN) — headless components, you provide UI via render props
import * as Updates from "expo-updates";
import Constants from "expo-constants";
import { UpdateGate, ReleaseNotesPrompt } from "bq-analytics/release/native";
// Optional — only import this if you want the auto-summoned "Update ready" sheet.
// Lives on its own sub-entry so the main `release/native` stays expo-updates-free.
import { PendingUpdatePrompt } from "bq-analytics/release/native/pending-update";

const channel = Updates.channel || (__DEV__ ? "development" : "production");
const releaseTag =
  (Constants.expoConfig?.extra?.releaseTag as string | undefined) ??
  Constants.expoConfig?.version;

<UpdateGate
  iosAppId="123456789"
  androidPackage="com.example.app"
  channel={channel}
  renderHardBlock={({ message, openStore }) => (
    <YourForceUpdateScreen message={message} onUpdate={openStore} />
  )}
>
  <App />
  <ReleaseNotesPrompt
    iosAppId="123456789"
    androidPackage="com.example.app"
    channel={channel}
    appVersion={releaseTag}
    render={(ctx) => <YourWhatsNewSheet {...ctx} />}
  />
  <PendingUpdatePrompt
    render={(ctx) => <YourUpdateReadySheet {...ctx} />}
  />
</UpdateGate>
```

`ReleaseNotesPrompt` `ctx` gives the sheet `{notes, verdict, visible, onDismiss, onUpdate, onCtaTap}`. Verdict (`'ok'` | `'soft'`) drives the primary CTA; `'hard'` never reaches the sheet (the gate replaces children). Optional `appVersion` prop suppresses the sheet until the user is on the bundle whose label matches `notes.version` — useful when Edge Config flips notes ahead of expo-updates applying the bundle.

`PendingUpdatePrompt` `ctx` gives the sheet `{updateId, visible, onApply, onDismiss, applying}`. Auto-fires when an OTA bundle is downloaded but not yet applied; per-bundle dismissal stored in AsyncStorage so dismissing one bundle doesn't suppress the next. Skipped in `__DEV__` by default. Bundle discovery is delegated to expo-updates' `checkAutomatically: 'ON_LOAD'` — the prompt deliberately does NOT chain `checkForUpdateAsync` to AppState foreground transitions because that combination cascades through queued bundles (one consumer's post-mortem; the prompt enforces the safe pattern at the package level).

**`channel` prop**: forwarded to the per-channel store-deeplink resolver. Pass `Updates.channel` from expo-updates yourself — bq-analytics deliberately doesn't read it (keeps the main `release/native` entry expo-updates-free). Defaults to `'production'`.

### Setup (one-time per repo)

```sh
./scripts/setup-edge-config.sh   # if you don't already have an Edge Config store
./scripts/setup-release.sh       # seeds the `release` key with the no-op default
```

### Operating release config — `bq-release` CLI

```sh
bq-release show                                   # current state
bq-release gate off                               # disable the gate
bq-release gate soft 42                           # nudge users below build 42
bq-release gate hard 42 --message "Critical fix"  # full-screen block
bq-release notes "v1.1.0" --from notes.json       # publish what's-new
bq-release clear-notes
bq-release urls set preview ios "itms-beta://..."
```

Read-merge-write semantics — partial updates don't blow away other fields. All write commands accept `--dry-run`. Reads directly from Edge Config (no CDN cache lag). See `claude-skills/release/SKILL.md` for the full operations guide and per-release drafting workflow.

### Release config shape

```json
{
  "gate": {
    "minIosBuild": 0,
    "minAndroidBuild": 0,
    "hardBlock": false,
    "message": "optional override copy"
  },
  "whatsNew": {
    "version": "v1.1.0",
    "entries": [
      { "title": "Faster reel imports", "body": "Half the time on IG and TikTok." },
      { "title": "Allergen badges", "body": "Quick warning when household allergens match.",
        "cta": { "label": "Set up", "url": "myapp://household/allergens" } }
    ]
  },
  "updateUrls": {
    "production": { "ios": "itms-apps://...", "android": "market://..." },
    "preview":    { "ios": "itms-beta://..." }
  }
}
```

Validator is permissive — only `gate` shape is enforced; extra fields pass through so you can roll out richer schemas without breaking older clients.

### Telemetry

```ts
import { RELEASE_EVENTS } from "bq-analytics/release";
// "update_gate.shown"      | "update_gate.feedback_tapped"
// "whats_new.shown"        | "whats_new.dismissed" | "whats_new.update_tapped"
// "whats_new.feedback_tapped" | "whats_new.cta_tapped"
// "pending_update.shown"   | "pending_update.applied" | "pending_update.dismissed"
```

Cohorts slice by the existing `app_version` / `build_number` / `runtime_version` traits on `identify`. The pending-update events carry `update_id` in properties so you can correlate apply rate per OTA bundle.

## Architecture

```
                                       BigQuery (your GCP project)
                                       ┌──────────────────────────┐
                                       │ events.raw                │
                                       │ events.identifies         │
browser SDK ─┐                         │ events.groups             │
RN/Expo SDK ─┼─ POST /api/track ──────▶│ events.user_groups        │
CLI scripts ─┘                         │   + views: events.users,  │
server SDK ─── direct insertAll ──────▶│           groups_current  │
                                       │                           │
Vercel Log ──── /api/internal/         │ logs.raw                  │
Drain          log-drain ─────────────▶│                           │
                                       └──────────────────────────┘

                                                 ▲
                                                 │  bq query  (CLI / Claude)
```

Two pipelines, conceptually clean:

- **events.\***: explicit product events from any client (browser, RN, server, CLI). One JSON column per row keeps schema flexible — never migrate when you add a property.
- **logs.\***: implicit Vercel runtime captures via Log Drain (every `console.log`, every request). Replaces 1–3 day Vercel log retention with however long you keep BQ partitions.

## Schema

```sql
events.raw           event_id, ts, event_name, user_id, anonymous_id, session_id, properties JSON
events.identifies    ts, user_id, traits JSON
events.groups        ts, group_type, group_id, traits JSON
events.user_groups   ts, user_id, group_type, group_id

events.users          ── view: latest traits per user_id
events.groups_current ── view: latest traits per (group_type, group_id)
events.user_groups_current ── view: most-recent group per user/type

events.feedback      feedback_id, ts, kind, subject, message, severity, url,
                     user_id, anonymous_id, session_id, properties JSON

logs.raw             ts, level, source, message, fields JSON, request_id, deployment_id, path, status, region, raw
```

All tables partition by `DATE(ts)` and cluster on common filter columns. Custom traits/properties go in `JSON` columns — never alter schema for a new field.

## Querying

```sh
# events
bq query --nouse_legacy_sql --format=json '
  SELECT event_name, COUNT(*) AS n
  FROM `proj.events.raw` WHERE DATE(ts) > CURRENT_DATE() - 7
  GROUP BY 1 ORDER BY n DESC'

# pro yearly users → translation.completed conversion
bq query --nouse_legacy_sql --format=json '
  SELECT COUNT(*) FROM `proj.events.raw` e
  JOIN `proj.events.users` u USING (user_id)
  WHERE e.event_name = "translation.completed"
    AND JSON_VALUE(u.traits, "$.plan") = "pro"
    AND JSON_VALUE(u.traits, "$.plan_period") = "yearly"'

# bug reports from pro users in the last week
bq query --nouse_legacy_sql --format=json '
  SELECT f.subject, f.message, JSON_VALUE(u.traits, "$.email") AS email
  FROM `proj.events.feedback` f
  LEFT JOIN `proj.events.users` u USING (user_id)
  WHERE f.kind = "bug" AND DATE(f.ts) > CURRENT_DATE() - 7
    AND JSON_VALUE(u.traits, "$.plan") = "pro"
  ORDER BY f.ts DESC'

# replace `vercel logs --query`
bq query --nouse_legacy_sql --format=json '
  SELECT ts, level, path, status, message FROM `proj.logs.raw`
  WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 MINUTE)
    AND CONTAINS_SUBSTR(message, "beacon")
  ORDER BY ts DESC LIMIT 50'
```

There's a Claude skill in `claude-skills/query/SKILL.md` with prompt-shaped guidance for AI agents.

## Cost (5M events/month, indie scale)

| Component | $/month |
|---|---|
| BigQuery streaming ingest | $0 (under 2 TiB free tier) |
| BigQuery storage | ~$0.03 (60 GB active × $0.02/GiB) |
| BigQuery queries | $0 (under 1 TB free) |
| Vercel function — `/api/track` (5M × 10 ms) | ~$0.20 |
| Vercel function — drain handler (~5k batches × 50 ms) | ~$0.01 |
| Vercel Observability log overage | ~$0.13 (1.25 GB × $0.50/GiB after 1 GB free) |
| Vercel Log Drain delivery | $0 (Pro included) |
| **Total** | **~$0.40 / mo** |

PostHog Cloud at 5M: ~$153/mo. This is ~400× cheaper.

## Durability

Per pipeline, where could events be lost and how is that mitigated:

| Pipeline | In-flight loss on function-termination | Destination (BQ) outage |
|---|---|---|
| **Browser → `/api/track`** | Recovered: failed batches persist to `localStorage`, retried on next page load. | Same as in-flight — server returns 5xx, client persists for next session. |
| **RN/Expo → `/api/track`** | Recovered: failed batches persist to `AsyncStorage`, retried on next app launch. | Same as in-flight. |
| **Server SDK → BQ direct** | **Possible loss** if the function instance dies between a buffered `track()` and the next `flush()`. Mitigation: `flushAt: 1` or `await flush()` before returning (see below). | **Possible loss** — `/api/track` returns 5xx, no server-side queue. |
| **Vercel Log Drain → handler → BQ** | At-least-once: Vercel retries on 5xx responses. | At-least-once: same retry path. |
| **CLI scripts → `/api/track`** | The script process owns retry. | If `/api/track` returns 5xx, the call throws — script can retry. |

### How does this compare to PostHog / Segment / Amplitude?

The server-side in-flight gap is **identical** in all three. Verified against their docs and source:

- **PostHog Node** (`posthog-node`): in-memory buffer (`MemoryStorage`), no disk/Redis persistence. [Their official serverless guidance](https://posthog.com/docs/libraries/node): *"set `flushAt` to `1` and `flushInterval` to `0`"* and `await posthog.shutdown()`.
- **Segment** (`@segment/analytics-node`): in-memory buffer, default `flushAt: 20` / `flushInterval: 10000`. Same official guidance for Lambda.
- **Amplitude** (`@amplitude/analytics-node`): in-memory `flushQueueSize: 16000`, no persistence. Same official guidance: `await client.flush().promise`.

None of them ship a Redis/disk durability layer in the SDK. This SDK is on par.

### Where the hosted tools have an edge

Their **ingest endpoints are Kafka-backed**: an event that successfully POSTs to PostHog's `/capture` is durable even if their analytics DB is down. That's a real edge for *destination outages*, distinct from in-flight termination.

We don't have that — `/api/track` writes straight to BQ. BigQuery's published streaming SLA is 99.99%, so practical loss from this path is bounded. If you ever need true at-least-once for revenue-critical events, the cheapest path is to put a buffer in front: Upstash Redis + a QStash cron flusher (~50 lines, opt-in) — but for indie analytics use cases this is overkill.

### Recommended pattern for server-side `track()` on Vercel

The same trade-off PostHog/Segment recommend, in our shape:

```ts
// option A: flushAt: 1 — every track() does its own HTTP round-trip
const a = new Analytics({
  transport: bqTransport({ projectId }),
  flushAt: 1,
});
a.track("foo", { ... }, { userId });
// flush has already started; await before returning if you need certainty
await a.flush();

// option B: batch within a request, flush after response
import { after } from "next/server";
const a = analytics();          // singleton from src/lib/analytics.ts
a.track("foo", { ... }, { userId });
a.track("bar", { ... }, { userId });
after(() => a.flush());          // runs after response is sent; survives until done
```

Option B is preferred — Vercel's `after()` keeps the function alive long enough to drain the buffer, avoiding the per-event HTTP latency of A.

## Auth chain

The server entry resolves credentials in this order:

1. `BQA_ACCESS_TOKEN` env var (explicit override — useful for local smoke runs)
2. **Vercel OIDC token** (production / preview / development on Vercel). Modern Vercel runtimes don't expose this as an env var — fetched per-request via `@vercel/functions/oidc`'s `getVercelOidcToken()`. Make sure `@vercel/functions` is in your project's dependencies. Older runtimes that still set `VERCEL_OIDC_TOKEN` env var also work as a fallback. The fetched JWT is exchanged through Google STS + service-account impersonation.
3. `GOOGLE_APPLICATION_CREDENTIALS_JSON` (service-account JSON pasted into env, for non-Vercel deployments)
4. Application Default Credentials (`gcloud auth application-default login` for local dev)

Tokens are cached for ~1h to avoid re-exchanging on every insert.

## Local dev / smoke test

```sh
# one-time
gcloud auth application-default login

# send a representative mix of events
GCP_PROJECT_ID=my-project pnpm smoke

# verify they landed
pnpm smoke:query <run_id>

# flag smokes (against a real Edge Config — run setup-edge-config.sh first)
pnpm smoke:flags             # read latency + propagation + missing-key
pnpm smoke:flags-targeting   # allowlist / rollout / cohort / exposure / refresh
```

The events smoke writes to `bq_analytics_smoke_events` and `bq_analytics_smoke_logs` datasets you can drop afterwards (`scripts/teardown.sh`). The flag smokes write transient keys into your Edge Config and clean up after themselves.

## Tests

```sh
pnpm test                  # 92 unit tests, no network
pnpm test:integration      # real BQ — requires BQ_INTEGRATION=1 and ADC
```

## Tear down

```sh
GCP_PROJECT_ID=my-project ./scripts/teardown.sh

# if you set up flags
EC_ID=$(grep '^EDGE_CONFIG=' .env.local | sed -E 's|.*/(ecfg_[^?]+)\?.*|\1|')
vercel edge-config remove "$EC_ID"
vercel env rm EDGE_CONFIG production
```

Prompts before each destruction. Reversible WIF pool delete, irreversible dataset + Edge Config delete.

## Why not Segment?

Pricing's opaque ($300+/mo for indie scale based on past quotes), they're a router not a warehouse, and you'd still need a destination. This is the destination.

## License

MIT.
