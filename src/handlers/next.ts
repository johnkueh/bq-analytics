import type { BqTransportConfig } from "../index.js";
import type { BufferedRecord, Transport } from "../types.js";

// `bqTransport` is loaded dynamically inside `createTrackRoute` so this file
// stays Edge-bundler-safe for consumers that only use `createLogDrainRoute`
// — the static chain `next.ts → index.ts → auth.ts` would otherwise drag
// node:* imports into the Edge bundle even when they're never reached at
// runtime.

export interface TrackRouteOptions extends BqTransportConfig {
  /**
   * Resolves the authenticated userId for a request. Return null for anonymous.
   * If omitted, requests are accepted as-is (use only for trusted internal callers).
   */
  resolveUser?: (req: Request) => Promise<string | null> | string | null;
  /**
   * Optional API key check for CLI / external callers. If `apiKey` is set,
   * any request with header `x-api-key: <apiKey>` bypasses resolveUser and is
   * treated as authenticated for whatever userId the body specifies.
   */
  apiKey?: string;
  /**
   * Per-request hook to attach extra fields (e.g. ip, ua) to every record.
   */
  enrich?: (req: Request, record: BufferedRecord) => BufferedRecord;
  /**
   * If a record has no userId/anonymousId, drop it. Default false.
   */
  rejectAnonymous?: boolean;
  /**
   * If provided, the BQ insert runs in the background after the response is
   * sent — clients get a fast 200 (~5–15 ms) instead of waiting for the BQ
   * round-trip (~50–150 ms). On Fluid Compute the function instance is kept
   * alive until the promise resolves.
   *
   * **Strongly recommended** for browser / RN / public-facing clients —
   * removes BQ latency from the user-visible response time.
   *
   * Without `waitUntil` the handler blocks until BQ confirms and returns 502
   * on failure. Browser/RN client SDKs already retry on network failure via
   * localStorage/AsyncStorage, so the 5xx feedback isn't load-bearing.
   *
   * Next.js 15+ App Router:
   *   import { after } from "next/server";
   *   export const POST = createTrackRoute({ ..., waitUntil: (p) => after(() => p) });
   *
   * Vercel @vercel/functions:
   *   import { waitUntil } from "@vercel/functions";
   *   export const POST = createTrackRoute({ ..., waitUntil });
   *
   * Cloudflare Workers / Hono on edge:
   *   c.executionCtx.waitUntil(p)
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Next.js App Router POST handler factory for /api/track.
 *
 * Accepts JSON body: { records: BufferedRecord[] }
 *
 * Response shape depends on `waitUntil`:
 * - With `waitUntil`: returns 200 immediately, BQ insert runs in background.
 *   Insert errors are logged via `console.error` (which the Log Drain
 *   captures into logs.raw if installed).
 * - Without `waitUntil`: blocks until BQ confirms; returns 502 on failure.
 */
export function createTrackRoute(opts: TrackRouteOptions) {
  // Lazy-load bqTransport so consumers that import this file purely for
  // `createLogDrainRoute` (typically on Edge runtime) don't pay the static
  // `node:*` import chain via index.ts → auth.ts. First POST resolves it
  // once and caches the promise.
  let transportPromise: Promise<Transport> | null = null;
  const getTransport = (): Promise<Transport> => {
    if (!transportPromise) {
      transportPromise = import("../index.js").then((m) => m.bqTransport(opts));
    }
    return transportPromise;
  };

  return async function POST(req: Request): Promise<Response> {
    if (opts.apiKey && req.headers.get("x-api-key") === opts.apiKey) {
      // pass — api key bypass is enough auth
    } else if (opts.resolveUser) {
      try {
        await opts.resolveUser(req);
      } catch (err) {
        return json({ error: "auth failed", detail: (err as Error).message }, 401);
      }
    }

    let body: { records?: BufferedRecord[] };
    try {
      body = (await req.json()) as { records?: BufferedRecord[] };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length === 0) return json({ ok: true, accepted: 0 });

    const cleaned: BufferedRecord[] = [];
    for (const r of records) {
      if (!validateRecord(r)) continue;
      const enriched = opts.enrich ? opts.enrich(req, r) : r;
      if (opts.rejectAnonymous && hasNoOwner(enriched)) continue;
      cleaned.push(enriched);
    }

    if (cleaned.length === 0) return json({ ok: true, accepted: 0 });

    if (opts.waitUntil) {
      // Fast path: dispatch BQ insert in background, return 200 immediately.
      opts.waitUntil(
        getTransport()
          .then((transport) => transport.send(cleaned))
          .catch((err) => {
            // Don't throw — caller already got 200. Log so the failure is
            // captured by the drain pipeline (logs.raw) for diagnosis.
            console.error("[bq-analytics] /api/track insert failed:", err);
          }),
      );
      return json({ ok: true, accepted: cleaned.length });
    }

    // Blocking path: await BQ confirm, surface 502 on failure so client
    // SDK retry queues kick in.
    try {
      const transport = await getTransport();
      await transport.send(cleaned);
    } catch (err) {
      return json({ error: "insert failed", detail: (err as Error).message }, 502);
    }

    return json({ ok: true, accepted: cleaned.length });
  };
}

/**
 * Wrap a `resolveUser` function with a process-global Map cache so repeat
 * lookups of the same auth token (or other key) skip the underlying DB hit.
 *
 * Designed for the common shape: hash an auth header → DB SELECT to map it
 * to a stable user/device id. Without caching, every analytics POST pays the
 * round-trip; on Vercel Active CPU pricing that adds up fast.
 *
 * **Safe defaults:** TTL-less cache (mappings are typically write-once —
 * tokens don't rotate to point at different users mid-session). Cache key
 * comes from the `key` extractor you supply (e.g. the bearer token, or its
 * hash). If you DO rotate tokens, pass `ttlMs` to bound staleness.
 *
 * Per-Lambda-instance only — this is in-memory, not Edge Config / KV. Cold
 * starts pay the first lookup; warm instances are free.
 *
 * ```ts
 * const resolveUser = cachedResolver(
 *   (req) => req.headers.get("authorization")?.slice(7), // bearer token
 *   async (token) => {
 *     const row = await db.execute({ sql: "SELECT id FROM devices WHERE token = ?", args: [token] });
 *     return row.rows[0]?.id ?? null;
 *   },
 * );
 * export const POST = createTrackRoute({ projectId, resolveUser });
 * ```
 */
export function cachedResolver<TKey extends string>(
  key: (req: Request) => TKey | null | undefined,
  resolve: (key: TKey) => Promise<string | null> | string | null,
  opts: { ttlMs?: number; maxEntries?: number } = {},
): (req: Request) => Promise<string | null> {
  const cache = new Map<TKey, { value: string | null; expiresAt: number }>();
  const ttlMs = opts.ttlMs ?? Number.POSITIVE_INFINITY;
  const maxEntries = opts.maxEntries ?? 10_000;

  return async function resolveUserCached(req: Request): Promise<string | null> {
    const k = key(req);
    if (k == null) return null;

    const now = Date.now();
    const hit = cache.get(k);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = await resolve(k);
    // Cap memory by evicting the oldest entry on overflow. Map iteration
    // order is insertion order, so .keys().next() is the FIFO head.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(k, { value, expiresAt: now + ttlMs });
    return value;
  };
}

export interface LogDrainRouteOptions {
  projectId: string;
  logsDataset?: string;
  /** Shared secret expected on `x-drain-secret` header. */
  secret: string;
  /**
   * Team-level `x-vercel-verify` token. **Required for new Vercel projects.**
   *
   * Vercel's drain-creation validator probes the URL with a GET (no headers)
   * and requires the response to carry `x-vercel-verify: <team-token>`. Find
   * yours by checking https://vercel.com/<team>/~/settings (search "verify")
   * or by attempting to create a drain — Vercel's 422 response includes the
   * expected token. The setup script auto-pushes this as the
   * `VERCEL_VERIFY_TOKEN` env var.
   *
   * If omitted, GET falls back to echoing whatever `x-vercel-verify` is in
   * the request — which works for some legacy Vercel teams but fails the
   * modern creation flow.
   */
  vercelVerifyToken?: string;
}

/**
 * Next.js App Router handler factory for Vercel Log Drain receiver.
 * Returns `{ POST, GET }` — both must be exported from your route file:
 *
 * ```ts
 * // src/app/api/internal/log-drain/route.ts
 * export const runtime = 'edge'; // strongly recommended — see below
 * export const { POST, GET } = createLogDrainRoute({
 *   projectId, secret: process.env.LOG_DRAIN_SECRET!,
 * });
 * ```
 *
 * **Run on Edge runtime to avoid the drain self-loop.** Vercel's `lambda`
 * source emits START / END / REPORT log lines for every function invocation
 * — including this handler's own invocations. Those lines get shipped back
 * to the drain → re-emitted → shipped again. At recipes.im scale we observed
 * 96–98% of all `logs.raw` rows being the drain logging itself (~440k/day).
 *
 * Vercel's `edge` source does NOT emit START/END/REPORT (per
 * https://vercel.com/docs/drains/reference/logs#log-sources), so flipping
 * the runtime to `edge` breaks the loop at the source — no Vercel dashboard
 * config needed. The drain handler uses only fetch / Web APIs so it runs
 * cleanly on Edge.
 *
 * Auth: Vercel OIDC (`@vercel/functions/oidc`) is the production auth path
 * and works on Edge. Service-account-JSON and ADC fallback paths in `auth.ts`
 * are Node-only — Edge consumers should rely on OIDC (the `bq-analytics`
 * setup script configures this by default) or the `BQA_ACCESS_TOKEN` env
 * override.
 *
 * - `POST` accepts NDJSON drain batches and writes them into <logsDataset>.raw.
 * - `GET` echoes back `x-vercel-verify` so Vercel's drain-creation endpoint
 *   validation succeeds. Without this, drain creation fails with
 *   "Cannot validate endpoint url" / missing x-vercel-verify header.
 *
 * **POST is intentionally blocking** — it awaits the BQ insert and returns
 * 502 on failure. This is by design: Vercel's Log Drain delivers at-least-
 * once by retrying on 5xx, so blocking + 502 preserves durability. Returning
 * 200 in the background would turn drain into at-most-once. BQ insert
 * latency (~50–150ms) is well within Vercel's drain delivery timeout.
 *
 * IMPORTANT: never call console.log inside POST — drained log lines are
 * themselves drained, creating an infinite loop. (On Edge runtime, even
 * `console.*` output is emitted as drain events, so this rule still
 * applies.)
 */
export function createLogDrainRoute(opts: LogDrainRouteOptions) {
  const dataset = opts.logsDataset ?? "logs";

  // Vercel's drain validator probes via GET, HEAD, **and POST**, and
  // requires *every* response to carry `x-vercel-verify: <team-token>`.
  // Stamp the header on every Response we hand back so validation passes
  // regardless of method.
  const stamp = (res: Response): Response => {
    if (opts.vercelVerifyToken) {
      res.headers.set("x-vercel-verify", opts.vercelVerifyToken);
    }
    return res;
  };

  async function POST(req: Request): Promise<Response> {
    if (req.headers.get("x-drain-secret") !== opts.secret) {
      return stamp(json({ error: "forbidden" }, 403));
    }

    const text = await req.text();
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return stamp(json({ ok: true, accepted: 0 }));

    const rows = lines.map((line) => parseDrainLine(line));

    try {
      const { insertRows } = await import("../insert.js");
      await insertRows({ projectId: opts.projectId }, dataset, "raw", rows);
    } catch (err) {
      return stamp(json({ error: "insert failed", detail: (err as Error).message }, 502));
    }
    return stamp(json({ ok: true, accepted: rows.length }));
  }

  function GET(req: Request): Response {
    // Same response shape used for HEAD probes (Next.js auto-derives HEAD
    // from GET and copies our headers).
    const verify = opts.vercelVerifyToken ?? req.headers.get("x-vercel-verify") ?? "";
    return new Response(null, {
      status: 200,
      headers: { "x-vercel-verify": verify },
    });
  }

  return { POST, GET };
}

export function parseDrainLine(line: string): Record<string, unknown> {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return {
      ts: new Date().toISOString(),
      level: "info",
      source: "external",
      message: line.slice(0, 8000),
      request_id: null,
      deployment_id: null,
      path: null,
      status: null,
      region: null,
      raw: line,
    };
  }
  return {
    ts: new Date(e.timestamp ?? Date.now()).toISOString(),
    level: normalizeLevel(e.level ?? "info"),
    source: e.source ?? e.type ?? "lambda",
    message: typeof e.message === "string" ? e.message.slice(0, 8000) : JSON.stringify(e.message ?? "").slice(0, 8000),
    request_id: e.requestId ?? null,
    deployment_id: e.deploymentId ?? null,
    path: e.proxy?.path ?? null,
    status: e.proxy?.statusCode ?? null,
    region: e.proxy?.region ?? null,
    raw: JSON.stringify(e).slice(0, 16000),
  };
}

function normalizeLevel(l: string): string {
  const v = l.toLowerCase();
  if (v === "warning") return "warn";
  if (v === "fatal") return "error";
  if (["debug", "info", "warn", "error"].includes(v)) return v;
  return "info";
}

function validateRecord(r: any): r is BufferedRecord {
  if (!r || typeof r !== "object") return false;
  if (!["event", "identify", "group", "user_group", "log", "feedback"].includes(r.kind)) return false;
  if (!r.row || typeof r.row !== "object") return false;
  return true;
}

function hasNoOwner(r: BufferedRecord): boolean {
  if (r.kind !== "event") return false;
  return !r.row.user_id && !r.row.anonymous_id;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
