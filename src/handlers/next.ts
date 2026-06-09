import { after } from "next/server";
import type { BqTransportConfig } from "../index.js";
import type { Analytics } from "../core.js";
import type { BufferedRecord, Transport } from "../types.js";

// `bqTransport` is loaded dynamically inside `createTrackRoute` so this file
// stays Edge-bundler-safe — the static chain `next.ts → index.ts → auth.ts`
// would otherwise drag node:* imports into the Edge bundle even when they're
// never reached at runtime.

/**
 * Schedule `analytics.flush()` to run after the current Next.js response is
 * sent. Native-Next equivalent of `honoFlushMiddleware` — call this inside
 * a Route Handler (`app/api/.../route.ts`) that emits any
 * `analytics.{track,identify,group,feedback,log}()` records, otherwise the
 * buffered batch can be lost if the serverless instance is recycled before
 * the auto-flush threshold fires.
 *
 * Accepts either an `Analytics` instance or a `() => Analytics` thunk so
 * consumers using `globalThis`-cached lazy singletons can pass the resolver
 * directly.
 *
 * Safe to call multiple times in a single handler — extra `flush()`s are
 * cheap no-ops once the buffer is drained.
 *
 * @example
 *   import { flushAfter } from "bq-analytics/next";
 *   import { analytics } from "@/lib/analytics";
 *
 *   export async function GET(req: Request) {
 *     flushAfter(analytics);
 *     // ... handler may call analytics().track(...) or logger.*
 *     return Response.json({ ok: true });
 *   }
 */
export function flushAfter(
  analyticsOrResolver: Analytics | (() => Analytics),
): void {
  const a =
    typeof analyticsOrResolver === "function"
      ? (analyticsOrResolver as () => Analytics)()
      : analyticsOrResolver;
  after(() => a.flush().catch(() => {}));
}

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
 *   Insert errors are logged via `console.error`.
 * - Without `waitUntil`: blocks until BQ confirms; returns 502 on failure.
 */
export function createTrackRoute(opts: TrackRouteOptions) {
  // Lazy-load bqTransport so Edge-runtime consumers don't pay the static
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
            // Don't throw — caller already got 200. Log for diagnosis.
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
