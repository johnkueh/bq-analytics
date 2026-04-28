---
name: bq-analytics-install
description: Install AND instrument bq-analytics in a project. Phase 1 detects the runtime and wires the SDK. Phase 2 scans the repo for auth / payment / key feature surfaces, suggests events, and instruments track/identify/group inline. Use when the user wants to add analytics to a new or existing project.
---

# Adding bq-analytics to a project

This skill has two phases. **Both are required.** Phase 1 puts the pipes in place; Phase 2 makes the data useful by instrumenting the right code paths.

- Phase 1: Provision + wire the SDK (steps 0–6 below)
- Phase 2: Instrument auth / payment / key events (the "Phase 2 — Instrumentation" section)

## Step 0 — Detect the runtime

bq-analytics' first-class server target is **Next.js App Router on Vercel** — the route factories (`createTrackRoute`, `createLogDrainRoute`) are designed for that, and the setup script provisions Vercel-specific env vars + a Vercel Log Drain. Other server frameworks work but require user-written adapters (the SDK ships generic `Request → Response` handlers; mapping into Hono / Express / Fastify is a few lines, see README).

Look at the repo to decide which path to follow.

| Signal | Stack | First-class? |
|---|---|---|
| `next.config.*` + `next` in dependencies | **Next.js** (likely on Vercel) | ✅ Yes — full install path |
| `express`, `fastify`, `koa` in deps, no Next | **Node server (non-Next)** | ⚠️ Partial — adapter required for the route handlers; pure server-side `bqTransport` works as-is |
| `hono` in deps, no Next | **Hono** (any runtime) | ⚠️ Partial — `bq-analytics/hono` middleware works; `c.req.raw` lets you call route factories directly |
| `expo` / `react-native` + `app.json` | **Expo / RN** (client SDK) | ✅ Yes — uses `httpTransport` to talk to a *separate* Next.js server |
| no server framework, `bin` / `tsx` / `ts-node` scripts | **Node CLI** | ✅ Yes — calls `bqTransport` directly, no route needed |
| `pyproject.toml`, `Gemfile`, `go.mod` | **Non-Node** | ⚠️ Manual — POST JSON to `/api/track` from any language |
| HTML page with `<script>` only | **Browser-only** | ✅ Yes via `httpTransport` to a Next.js server |

If the project doesn't have a Next.js server **and** has client-side calls (browser/RN), the user needs a Next.js (or other Web-standard) server to host `/api/track` somewhere — explain this before proceeding. Common pattern: a single Next.js project hosts the route, and Expo / RN apps point their `httpTransport` at it.

A project may be a mix (e.g. Next.js web + Expo monorepo) — install the server route in the Next.js side, the client SDK in the Expo side, both pointed at the same backend.

## Common preflight (every stack)

1. **Confirm GCP project.** Run `gcloud projects list --format='value(projectId)'`. **Verify billing is enabled** with `gcloud billing projects describe <id>` — the BQ sandbox / free tier disallows streaming inserts and the SDK will 403.
2. **For Vercel-hosted stacks**: `vercel whoami` and `vercel ls`. Get a team-scope token from https://vercel.com/account/tokens for setup only — never commit.
3. **Install the package**: `pnpm add bq-analytics` (published on npm — works on Vercel CI, no extra setup).
4. **Vercel runtimes only**: also ensure `@vercel/functions` is in your project's dependencies — bq-analytics needs it to read the per-request OIDC token via `getVercelOidcToken()` (modern Vercel doesn't expose `VERCEL_OIDC_TOKEN` as an env var). Most Vercel projects already have it transitively; if not: `pnpm add @vercel/functions`.

## Provision GCP resources

The setup script handles BQ datasets + tables + IAM. For Vercel-hosted projects it also provisions Workload Identity Federation and a Log Drain.

**Vercel + Next.js** — first install (project not yet deployed):

```sh
# Step 1: provision everything except the Log Drain
VERCEL_TOKEN=<paste> \
  ./node_modules/bq-analytics/scripts/setup-bq-oidc.sh \
    --gcp <GCP_PROJECT_ID> \
    --team <VERCEL_TEAM_SLUG> \
    --project <VERCEL_PROJECT_NAME> \
    --skip-drain

# Step 2: wire up the route files (see "Wire up the runtime" below)
# Step 3: deploy (git push or `vercel --prod`)
# Step 4: register the Log Drain (URL must be live)
VERCEL_TOKEN=<paste> \
  ./node_modules/bq-analytics/scripts/setup-bq-oidc.sh \
    --gcp <GCP_PROJECT_ID> \
    --team <VERCEL_TEAM_SLUG> \
    --project <VERCEL_PROJECT_NAME> \
    --domain <PROJECT_DOMAIN> \
    --drain-only
```

**Vercel + Next.js** — re-run / repair (project already deployed):

```sh
VERCEL_TOKEN=<paste> \
  ./node_modules/bq-analytics/scripts/setup-bq-oidc.sh \
    --gcp <GCP_PROJECT_ID> \
    --team <VERCEL_TEAM_SLUG> \
    --project <VERCEL_PROJECT_NAME> \
    --domain <PROJECT_DOMAIN>
```

**Non-Vercel (Express, Hono, Render, Fly, Lambda, etc.)** — only need datasets + a service account:

```sh
./node_modules/bq-analytics/scripts/setup-bq-oidc.sh \
  --gcp <GCP_PROJECT_ID> --skip-vercel
```

Then create a service-account JSON key, and either inject it via `GOOGLE_APPLICATION_CREDENTIALS_JSON` env var on your host, or use Workload Identity (AWS/GCP/etc.) if available.

**CLI / local dev** — no setup needed beyond datasets. Auth via `gcloud auth application-default login`.

The script is idempotent and:

1. Creates `events` + `logs` BigQuery datasets, applies table DDL.
2. *(Vercel)* WIF pool + OIDC provider scoped to one Vercel project.
3. *(Vercel)* `vercel-bq` SA with `bigquery.dataEditor` on the two datasets + `bigquery.jobUser` at project level.
4. *(Vercel)* Binds Vercel principals (production, preview, development) to the SA.
5. *(Vercel)* Pushes 7 env vars to all three Vercel environments.
6. *(Vercel)* Creates a Log Drain pointed at `/api/internal/log-drain`.

## Wire up the runtime — pick one or more

### Next.js (Vercel)

Two route files + one helper:

**`src/app/api/track/route.ts`**
```ts
import { createTrackRoute } from "bq-analytics/next";
import { after } from "next/server";

export const POST = createTrackRoute({
  projectId: process.env.GCP_PROJECT_ID,
  apiKey: process.env.ANALYTICS_API_KEY,
  waitUntil: (p) => after(() => p),   // ← non-blocking: 200 returns in ~5-15ms
  resolveUser: async (_req) => {
    // Clerk:    const { userId } = await auth(); return userId;
    // NextAuth: const s = await getServerSession(); return s?.user?.id;
    return null;
  },
});
```

**Why `waitUntil`?** Without it the handler blocks until BQ confirms the insert (~50-150ms latency added to every client request). With `waitUntil` the BQ insert runs in the background after the response is sent — clients get fast 200s. Browser/RN SDKs already retry on network failure via localStorage/AsyncStorage, so the lack of 5xx feedback isn't load-bearing.

**`src/app/api/internal/log-drain/route.ts`**
```ts
import { createLogDrainRoute } from "bq-analytics/next";
// MUST export both POST and GET. Vercel's modern drain creation validator
// probes GET with NO incoming headers and expects the response to carry
// `x-vercel-verify: <team-token>`. The setup script auto-fetches the token
// from your team and pushes it as VERCEL_VERIFY_TOKEN — pass it through.
export const { POST, GET } = createLogDrainRoute({
  projectId: process.env.GCP_PROJECT_ID,
  secret: process.env.LOG_DRAIN_SECRET!,
  vercelVerifyToken: process.env.VERCEL_VERIFY_TOKEN,
});
```

If `VERCEL_VERIFY_TOKEN` isn't set, the setup script will detect this on drain creation, parse the expected token from Vercel's 422 response, push it as an env var, and tell you to redeploy + re-run with `--drain-only`.

⚠️ **Never `console.log` inside POST** — drained lines are themselves drained, infinite loop. `console.error` on real errors only.

If using Clerk middleware (`src/proxy.ts` / `src/middleware.ts`), add `/api/internal/log-drain` and `/api/track` to the public route list.

### Local dev — pulling env vars

After step 1 of the setup (env vars pushed to Vercel), pull them locally so `pnpm dev` can write to your real BigQuery dataset:

```sh
vercel env pull .env.local
```

The Vercel OIDC token rotates every ~12 hours. In `pnpm dev`, the SDK calls `@vercel/functions/oidc`'s `getVercelOidcToken()` which reads from request context — `vercel env pull .env.local` populates the supporting env vars (`GCP_PROJECT_ID`, etc) but the OIDC token itself is fetched dynamically per request. If you see "ID Token … is stale" errors, re-run `vercel env pull` to refresh the dev environment binding. The SDK falls back to a no-op transport when `GCP_PROJECT_ID` is missing (so vitest runs and preview deploys without env vars don't crash) — but that means you'll silently drop events if you forget the pull.

### Express / Hono / Fastify / Koa / raw Node

```ts
import pino from "pino";
import pinoHttp from "pino-http";
import { Analytics, bqTransport } from "bq-analytics";
import { pinoBqTransport } from "bq-analytics/pino";

const a = new Analytics({ transport: bqTransport({ projectId: process.env.GCP_PROJECT_ID! }) });
const logger = pino({}, pinoBqTransport({ projectId: process.env.GCP_PROJECT_ID!, analytics: a }));

app.use(pinoHttp({ logger }));   // every request → logs.raw

// inside any handler — no flush() call here, see middleware below
a.track("checkout.started", { plan }, { userId });

// graceful shutdown
process.on("SIGTERM", async () => { await a.flush(); process.exit(0); });
```

**Hono on Vercel / Cloudflare / Bun** — install the flush middleware once, then handlers stay clean:

```ts
import { Hono } from "hono";
import { honoFlushMiddleware } from "bq-analytics/hono";
import { analytics } from "@/lib/analytics";

const app = new Hono();
app.use("*", honoFlushMiddleware(analytics));   // flushes once per response
```

After this, route handlers should NOT call `analytics().flush()` themselves. Just `track()` / `identify()` / `group()` and return — the middleware does the flush. **Do not** wrap each call in `waitUntil(analytics().flush())` or `Promise.resolve(analytics().flush())` — that's redundant boilerplate.

For Express / Koa / raw Node, write the equivalent response hook:

```ts
// Express
app.use((req, res, next) => {
  res.on("finish", () => { void analytics().flush(); });
  next();
});
```

Fastify uses pino natively — pass the pino instance to `Fastify({ logger })` and skip pino-http. For flushing, use the `onResponse` hook the same way.

### Browser

```ts
import { Analytics } from "bq-analytics";
import { browserTransport, attachBrowserAutoFlush, attachWindowErrorHandler } from "bq-analytics/browser";

const a = new Analytics({ transport: browserTransport({ url: "/api/track" }) });
attachBrowserAutoFlush(() => a.flush());
attachWindowErrorHandler(a);
```

### Expo / React Native

```ts
import { Analytics } from "bq-analytics";
import { reactNativeTransport, attachExpoErrorHandler, attachAppStateFlush } from "bq-analytics/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

// Mutable headers ref — the RN transport spreads `config.headers` on every
// fetch, so mutating this object propagates new auth without rebuilding
// the Analytics instance (and losing the retry queue).
const headersRef: Record<string, string> = {};

// Mutable identity ref — the attach helpers below take getter closures
// that re-resolve userId on every event, so it tracks the *current*
// identity instead of whatever was set when the helpers were attached
// (typically null, before SecureStore loads).
let currentDeviceId: string | undefined;

const a = new Analytics({
  transport: reactNativeTransport({
    url: `${API_URL}/api/track`,
    headers: headersRef,
    storage: AsyncStorage,
  }),
});

// Attach once at module load with getter closures.
attachExpoErrorHandler(a, ErrorUtils, () => ({
  platform: Platform.OS,
  userId: currentDeviceId,
}));
attachAppStateFlush(a, AppState, () => ({ userId: currentDeviceId }));

// Call this when identity loads / rotates.
export function bindIdentity(identity: { deviceId: string; deviceToken: string } | null) {
  if (identity) {
    headersRef.authorization = `Bearer ${identity.deviceToken}`;
    currentDeviceId = identity.deviceId;
    a.identify(identity.deviceId, {
      platform: Platform.OS,
      app_version: Constants.expoConfig?.version ?? null,
      build_number:
        Constants.expoConfig?.ios?.buildNumber ??
        String(Constants.expoConfig?.android?.versionCode ?? "") || null,
      ota_update_id: Updates.updateId,            // null = on embedded JS
      ota_channel: Updates.channel,               // "production" | "preview" | "development"
      runtime_version: Updates.runtimeVersion,
    });
  } else {
    delete headersRef.authorization;
    currentDeviceId = undefined;
  }
}
```

**Why getter closures, not static objects.** RN identity typically loads
asynchronously (SecureStore → state → render). If you attach the helpers with
a static `{ userId }` while identity is still null, every subsequent
`app.state_changed` and uncaught-error event lands with `user_id: NULL`. The
getter form re-resolves on each event.

**Why the OTA / build traits.** When triaging "but I just OTA'd!" the only
honest answer is `ota_update_id` — everything else relies on the user
accurately reporting their bundle. `events.users` is last-write-wins per
deviceId, so the next OTA's `identify()` call updates the row in place;
`events.users` always reflects each device's current build. Don't stamp
these on every event — that bloats `events.raw` with no query benefit.

### Node CLI

```ts
import { Analytics, bqTransport, httpTransport } from "bq-analytics";
import { attachCliHooks } from "bq-analytics/cli";

// Two transport choices:
const a = new Analytics({ transport: bqTransport({ projectId }) });           // direct to BQ (needs GCP creds)
// OR
const a = new Analytics({ transport: httpTransport({ url: "https://prod/api/track", headers: { "x-api-key": KEY } }) });

attachCliHooks(a, { source: "my-cli" });
a.track("cli.command_run", { command: process.argv[2] });
// ... do work ...
await a.flush();   // CRITICAL: process exits the moment you return
```

## Use the SDK

Server-side singleton (`src/lib/analytics.ts`):

```ts
import { Analytics, bqTransport } from "bq-analytics";

declare global { var __bqa: Analytics | undefined; }

export function analytics() {
  if (!globalThis.__bqa) {
    globalThis.__bqa = new Analytics({
      transport: bqTransport({
        projectId: process.env.GCP_PROJECT_ID!,
        eventsDataset: process.env.BQ_EVENTS_DATASET,
        logsDataset: process.env.BQ_LOGS_DATASET,
      }),
    });
  }
  return globalThis.__bqa;
}
```

In any route handler:

```ts
import { after } from "next/server";
import { analytics } from "@/lib/analytics";

export async function POST(req: Request) {
  // ... do work ...
  analytics().track("foo.bar", { ... }, { userId });
  after(() => analytics().flush());
  return Response.json({ ok: true });
}
```

## Phase 2 — Instrumentation (don't skip)

Installation puts the pipes in place. **Instrumentation** is the part that makes the data useful — `track()`, `identify()`, `group()` calls in the right places. Don't leave this to the user; do the work.

**Order matters**: migrate what already exists first (cheap 1:1 swaps), then add net-new instrumentation. Don't write new `track()` calls for events the codebase is already emitting elsewhere.

### 2-pre-A. Detect and migrate existing analytics tools

Before adding anything, grep for an analytics SDK already in use:

```sh
rg -l 'posthog-js|posthog-node|@posthog' --type ts --type tsx
rg -l '@segment/analytics-node|analytics-node|rudder-sdk' --type ts --type tsx
rg -l '@amplitude/analytics-(node|browser)|amplitude-js' --type ts --type tsx
rg -l 'mixpanel|@mixpanel' --type ts --type tsx
rg -l 'gtag\(|google-analytics' --type ts --type tsx
rg -l 'plausible|umami' --type ts --type tsx
```

If anything matches:

1. **List every call site** of `.track(`, `.identify(`, `.group(`, `.capture(`, `.alias(`, etc.
2. **Map the API 1:1**:
   - `posthog.capture('event', props, { distinct_id })` → `analytics.track('event', props, { userId: distinct_id })`
   - `posthog.identify(id, traits)` → `analytics.identify(id, traits)`
   - `posthog.group(type, key, props)` → `analytics.group(type, key, props, userId)`
   - `analytics.track(name, props, ctx)` (Segment) → same name, same shape
   - `amplitude.track(eventType, props)` → `analytics.track(eventType, props, { userId })`
   - `mixpanel.track(name, props)` → `analytics.track(name, props, { userId })`
   - `gtag('event', name, params)` → `analytics.track(name, params, { userId })`
3. **Replace inline** — keep the same event names + property shapes so historical analysis carries over.
4. **Remove the old SDK** from `package.json` once all call sites are migrated. Don't dual-write — it's a cost trap and event names will drift.

If migration is partial (user wants to keep PostHog for replays/flags but BQ for analytics), say so explicitly to the user and dual-write only the events they care about.

### 2-pre-B. Detect and migrate manually-built telemetry endpoints

Many indie projects have a hand-rolled debug endpoint — `/api/debug/log`, `/api/beacon`, `/api/event`, `/api/log`, `/api/telemetry`, `/api/track` (yours, conflict!). Find them:

```sh
fd -t f 'route\.(ts|tsx|js)$' . | xargs rg -l 'debug/log|/beacon|/telemetry|/event/log' 2>/dev/null
rg -l 'app\.(post|get)\(.{1,40}(beacon|telemetry|debug-log|debug/log)' --type ts
rg -l 'console\.log\(`?\[(beacon|telemetry|track|event|user)\]' --type ts --type tsx
```

For each match, decide:

- **Pure log forwarding** (handler just `console.log(JSON.stringify(body))`): **delete the handler**. It's redundant — `bq-analytics` ships `/api/track` for this. Update callers to POST to `/api/track` with `{ records: [{ kind: "log", row: {...} }] }`.
- **Custom logic in the handler** (auth check, device lookup, structured field extraction): **keep the route**, but replace its terminal `console.log` with `analytics.log("info", message, fields, source)`. The route still does its thing; the storage moves from Vercel logs to BQ.
- **Client-side beacon helper** (e.g. `makeBeacon(deviceToken)` in an Expo / RN / browser file): rewrite the helper to call `analytics.log()` from `bq-analytics`'s SDK. Same fire-and-forget semantics; same payload shape; one less custom function to maintain.

The recipes.im pattern (`/api/debug/log` + `[beacon]` console.log on the server, `makeBeacon(deviceToken)` on the client) is the canonical case — replace both server `console.log` and client `fetch('/api/debug/log', ...)` with `analytics.log(...)` and `analytics.track(...)`.

### 2-pre-C. Find structured `console.log` calls worth migrating

You won't migrate every `console.log` in the codebase — most are debugging. But anything that looks like a structured event (prefixed with `[name]`, JSON-encoded, or written specifically for searchability) is a candidate:

```sh
rg -n 'console\.log\(`?\[' --type ts --type tsx | head -50
rg -n 'console\.log\(JSON\.stringify' --type ts --type tsx | head -30
```

Show the user the list (capped at ~30) and ask which to migrate. Don't auto-migrate — these are often debug noise the user doesn't actually want in BQ.

### 2a-pre. No-auth apps: treat the device as the user

Some apps have no user auth — just devices and groups (e.g. an Expo app where each install gets a `deviceId` that joins a `householdId`, or a CLI tool keyed by machine). For these:

- **`userId` = the persistent device/install identifier.** It's stable across app launches; that's all `identify()` needs.
- **`identify(deviceId, traits)`** — `traits` are device-level: `platform`, `app_version`, `device_label`, `created_at`.
- **`group("household", householdId, traits, deviceId)`** — group is the org-equivalent. The 4th arg attaches this device to the household.
- **Events**: `track(event, props, { userId: deviceId })` — never `userId: householdId`.

Common mistake to avoid: identifying the household / org / team / workspace AS the user. That's a group, not a person. Use `group()` for it.

If/when the app later adds real auth, the new pattern is `identify(realUserId, traits)` and an alias mapping (`alias(deviceId → realUserId)`) — but until then, device-as-user works exactly like Segment/PostHog/Amplitude treat anonymous users (stable UUID = distinct_id).

### 2a. Find and instrument auth surfaces

Grep the repo for the auth provider:

```sh
# what to look for
rg -l 'clerk|@clerk' --type ts --type tsx          # Clerk
rg -l 'next-auth|getServerSession' --type ts --type tsx   # NextAuth
rg -l '@supabase/auth' --type ts --type tsx        # Supabase
rg -l 'lucia-auth|@lucia-auth' --type ts --type tsx       # Lucia
rg -l '@workos-inc/authkit' --type ts --type tsx   # WorkOS
```

Then instrument the following touchpoints with `identify()`:

| Auth provider | Instrument here | Call |
|---|---|---|
| Clerk | webhook handler for `user.created` (search: `rg 'user\.created' app/api/webhooks/clerk`) | `identify(userId, { email, signup_country, signup_source })` |
| Clerk | webhook handler for `user.updated` | `identify(userId, { email, ...changedTraits })` |
| NextAuth | `events.signIn` callback in `auth.ts` / `[...nextauth].ts` | `identify(userId, { email, provider })` |
| Supabase | sign-up route + `INSERT ON public.users` trigger consumer | `identify(userId, { email })` |
| Custom | wherever you create a user row in DB | `identify(userId, traits)` |

**Flush per request, not per call.** If you're using a flush middleware (Hono `honoFlushMiddleware`, Next `after(() => flush())` once at end-of-handler, Express `res.on("finish", flush)`), the route doesn't need its own flush. Don't sprinkle `waitUntil(analytics().flush())` on every track/identify call — that's the boilerplate-anti-pattern. If you're NOT using a middleware, do `await analytics().flush()` once before returning the response.

### 2b. Find and instrument payment / billing surfaces

```sh
rg -l 'stripe|@stripe/stripe' --type ts            # Stripe
rg -l 'polar\.sh|@polar-sh' --type ts              # Polar
rg -l 'paddle|@paddle' --type ts                   # Paddle
rg -l 'lemonsqueezy|@lemonsqueezy' --type ts       # Lemon Squeezy
rg -l 'app/api/webhooks/stripe' --type ts          # Stripe webhook route
```

Standard events to instrument in the payment webhook handler:

| Event | Trigger | Code |
|---|---|---|
| `subscription.created` | `customer.subscription.created` | `track("subscription.created", { plan, period, price_cents }, { userId })` |
| `subscription.upgraded` | `customer.subscription.updated` with `previous_attributes.items` containing higher tier | `track("subscription.upgraded", { from_plan, to_plan }, { userId })` |
| `subscription.canceled` | `customer.subscription.deleted` | `track("subscription.canceled", { plan, reason }, { userId })` |
| `payment.failed` | `invoice.payment_failed` | `track("payment.failed", { amount_cents, attempt_count }, { userId })` |
| `payment.recovered` | `invoice.paid` after a failed attempt | `track("payment.recovered", {...}, { userId })` |

**Also** call `identify()` on every subscription state change to refresh `plan` / `is_pro` traits:

```ts
identify(userId, {
  plan: subscription.plan.id,
  plan_period: subscription.recurring.interval,
  is_pro: subscription.status === "active",
  current_period_end: subscription.current_period_end,
});
```

### 2c. Suggest events from the route surface

List the app's routes to find likely event surfaces:

```sh
# Next.js App Router
fd 'page\.tsx?' src/app | grep -v node_modules
fd 'route\.tsx?' src/app | grep -v node_modules

# Express / Hono — grep for HTTP methods
rg -E '\b(app|router|honoApp)\.(get|post|put|delete|patch)\(' --type ts
```

Match each against the catalog below and suggest 3–7 events to start with — don't try to instrument 30 at once. Ask the user which to wire up. Per event, find the right code location and write the `track()` call inline.

#### Common event catalog

Pick the ones that map to actual code in the repo. Don't invent events for features that don't exist.

**Acquisition / activation**
- `pageview` (consider Log Drain instead — it captures every request automatically)
- `signup.started` — at sign-up form mount or first field interaction
- `signup.completed` — after Clerk `user.created` webhook fires (server-side, authoritative)
- `onboarding.completed` — after the user finishes the welcome flow
- `referral.invited` / `referral.accepted` — if there's a referral system

**Engagement / core feature usage**
- `<feature>.used` — name it after the verb in the route. e.g. `translation.started`, `transcription.completed`, `recipe.imported`, `chord.detected`. Find by reading what the API routes actually do.
- `search.performed` — if there's a search box
- `export.downloaded` — if there's a download button
- `share.created` — if there's a share/invite link
- `<resource>.created` / `<resource>.deleted` — for primary nouns (project, recipe, video, etc.)

**Monetization**
- `pricing.viewed` — instrument in `/pricing` page render or first interaction
- `checkout.started` — when the user clicks "Subscribe" / "Buy"
- `checkout.completed` — Stripe webhook (see 2b)
- `subscription.*` — Stripe webhook (see 2b)
- `paywall.viewed` / `paywall.dismissed` — if there's an in-app upsell

**Retention / risk**
- `login.completed` — useful for DAU/MAU metrics if you want them in BQ vs Clerk dashboard
- `account.deleted`
- `support.contacted` — if there's a contact form / Intercom / similar
- `error.encountered` — for known recoverable errors that matter (payment failed, upload rejected, …)

**B2B / multi-tenant only**
- `team.created`, `team.member_invited`, `team.member_joined` — accompany with `group("team", id, traits)` and `group("team", id, traits, userId)` to wire membership

### 2d. Read product-specific context

Before suggesting events, scan for:
- `CLAUDE.md` / `seo/CLAUDE.md` / `docs/` — the user's own product/marketing notes often list the metrics that matter
- `README.md` — the product's UVPs hint at what to measure
- Pricing / plan IDs in env vars or code — drives the `plan` trait values
- Existing analytics calls (PostHog, Segment, Amplitude) — replace 1:1 to preserve continuity

If the user has a memory note like `project_uvps.md` or similar, it'll often state explicitly what they care about. Honor that.

### 2e. Wire up enrich for every event

The `createTrackRoute` factory accepts an `enrich` hook. Set it to attach request-level fields (ip, ua) and any hot traits you don't want to join from `events.users`:

```ts
export const POST = createTrackRoute({
  ...,
  enrich: (req, record) => {
    if (record.kind !== "event") return record;
    const props = JSON.parse(record.row.properties || "{}") as Record<string, unknown>;
    props.ip ??= req.headers.get("x-forwarded-for");
    props.ua ??= req.headers.get("user-agent");
    return { ...record, row: { ...record.row, properties: JSON.stringify(props) } };
  },
});
```

Note: `enrich` runs once per record, so a batch of N events parses+stringifies properties N times. That's cheap for typical payloads but don't put expensive lookups in here — pull them from request-scoped cache or skip for events that don't need them.

### 2f. After instrumentation: ship a smoke commit

Before the user redeploys:

1. Print the list of events you instrumented (file:line each).
2. Print 2–3 example `bq query` SQL strings the user can run after their first real session to verify each surface fired correctly.
3. Suggest a follow-up: "after a day of real traffic, run `/bq-analytics-query show me event volume last 24h` to see what's flowing."

## Verify end-to-end

After redeploying:

```sh
# Send a test event from CLI
curl -X POST https://<domain>/api/track \
  -H "x-api-key: $ANALYTICS_API_KEY" \
  -H "content-type: application/json" \
  -d '{"records":[{"kind":"event","row":{"event_id":"test-1","ts":"2026-01-01T00:00:00Z","event_name":"smoke","user_id":"cli","anonymous_id":null,"session_id":null,"properties":"{}"}}]}'

# Confirm it landed (wait ~10s for streaming buffer)
bq query --nouse_legacy_sql --format=pretty \
  "SELECT ts, event_name FROM \`<gcp>.events.raw\` WHERE event_name = 'smoke' ORDER BY ts DESC LIMIT 1"
```

For log drain validation, hit any route that `console.log`s and check `logs.raw` after ~10–60s — Vercel batches drain delivery.

## Troubleshooting

**"Streaming insert is not allowed in the free tier"** — the GCP project is on BQ Sandbox. Enable billing on it via `console.cloud.google.com/billing` or pick a different project.

**"Permission 'bigquery.tables.updateData' denied"** — the WIF binding didn't propagate yet, or the env vars are stale on Vercel. Wait 30s and retry, or run the setup script again.

**Drain handler 502s** — `LOG_DRAIN_SECRET` doesn't match the value Vercel sends in `x-drain-secret`. Re-run setup with `--skip-vercel` ... actually no, just re-run setup; it regenerates the secret.

**Anonymous events being dropped** — `resolveUser` is required by default. If you want anonymous events, accept them in `resolveUser` (return null) and don't set `rejectAnonymous`.

## Tear down

```sh
GCP_PROJECT_ID=<id> ./node_modules/bq-analytics/scripts/teardown.sh
```

Prompts before each destruction.
