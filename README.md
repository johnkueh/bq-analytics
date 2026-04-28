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
| Ops | none | one shell script per project |

If you want PostHog's UI, replays, and feature flags, use PostHog. If you mostly want event analytics that an AI agent can query, this is cheaper and your data stays yours.

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

Claude detects the runtime (Next.js / Express / Hono / Expo / CLI), runs the setup script, wires the route handlers, patches your auth middleware if needed, and tells you what to verify after deploy.

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
```

The smoke script writes to `bq_analytics_smoke_events` and `bq_analytics_smoke_logs` datasets you can drop afterwards (`scripts/teardown.sh`).

## Tests

```sh
pnpm test                  # 35 unit tests, no network
pnpm test:integration      # real BQ — requires BQ_INTEGRATION=1 and ADC
```

## Tear down

```sh
GCP_PROJECT_ID=my-project ./scripts/teardown.sh
```

Prompts before each destruction. Reversible WIF pool delete, irreversible dataset delete.

## Why not Segment?

Pricing's opaque ($300+/mo for indie scale based on past quotes), they're a router not a warehouse, and you'd still need a destination. This is the destination.

## License

MIT.
