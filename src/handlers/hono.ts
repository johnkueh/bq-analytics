import type { Analytics } from "../index.js";

export interface HonoFlushOptions {
  /**
   * Background-flush sink used to keep the Hono response fast while the BQ
   * insert runs out-of-band. Pass this on platforms where Hono's adapter
   * doesn't bridge `executionCtx.waitUntil`.
   *
   * Vercel Node / Fluid Compute (the case this option exists for —
   * `hono/vercel`'s `handle()` is just `(req) => app.fetch(req)` and never
   * wires `executionCtx`):
   *
   * ```ts
   * import { waitUntil } from "@vercel/functions";
   * app.use("*", honoFlushMiddleware(analytics, { waitUntil }));
   * ```
   *
   * Next.js App Router (when mounting Hono inside a route handler):
   *
   * ```ts
   * import { after } from "next/server";
   * app.use("*", honoFlushMiddleware(analytics, { waitUntil: (p) => after(() => p) }));
   * ```
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Hard cap on the awaited-flush fallback in milliseconds. If BQ is
   * unreachable the underlying `fetch` has no built-in timeout — Node will
   * sit on the open connection for tens of seconds. This bound keeps the
   * Hono response from stalling that long; events that miss the deadline
   * are simply dropped. Defaults to 2000.
   *
   * Ignored when `waitUntil` is provided (background work isn't on the
   * response-latency critical path).
   */
  flushTimeoutMs?: number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
/**
 * Hono middleware that flushes the analytics buffer once per response.
 *
 * Removes the need to call `waitUntil(analytics().flush())` in every route
 * handler. Single line in your app entry replaces N flush calls.
 *
 * Resolution order for the flush sink:
 *
 * 1. Explicit `opts.waitUntil` (recommended on Vercel Node / Fluid — see
 *    {@link HonoFlushOptions.waitUntil}).
 * 2. `c.executionCtx.waitUntil` (Cloudflare Workers, Bun, Hono on edge).
 * 3. Fallback: **await the flush before resolving the response.**
 *
 * The fallback used to be fire-and-forget. That silently dropped events on
 * Vercel's Node runtime: `hono/vercel`'s adapter doesn't pass an
 * `executionCtx`, so the middleware fell to fire-and-forget, and Vercel
 * tore the function instance down before the BQ HTTPS POST completed.
 * Awaiting adds 50–300 ms of latency to the response but guarantees the
 * batch lands. Use `opts.waitUntil` to opt back into the fast path on
 * platforms that support background work.
 *
 * ```ts
 * import { Hono } from "hono";
 * import { honoFlushMiddleware } from "bq-analytics/hono";
 * import { analytics } from "@/lib/analytics";
 *
 * const app = new Hono();
 * app.use("*", honoFlushMiddleware(analytics));
 * ```
 *
 * @param getAnalytics  function returning the Analytics singleton (or the
 *                      instance directly). A getter is preferred so the
 *                      module-singleton pattern in `analytics()` works.
 * @param opts          optional `{ waitUntil }` sink (see above).
 */
export function honoFlushMiddleware(
  getAnalytics: (() => Analytics) | Analytics,
  opts: HonoFlushOptions = {},
) {
  const resolve = (): Analytics =>
    typeof getAnalytics === "function" ? (getAnalytics as () => Analytics)() : getAnalytics;

  return async function flushMiddleware(c: HonoContextLike, next: () => Promise<void>) {
    await next();
    const a = resolve();

    if (opts.waitUntil) {
      opts.waitUntil(a.flush().catch(() => {}));
      return;
    }

    // Hono's `c.executionCtx` is a *getter* that throws when no execution
    // context was provided (e.g. `hono/node-server` in `next dev`). Try/catch
    // is the only safe access pattern.
    let ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(a.flush());
      return;
    }

    // Last-resort: block the response so the batch lands. Fire-and-forget
    // here looks correct but loses events on Vercel Node — the function
    // instance is torn down before the BQ POST resolves. Bounded so an
    // unreachable BQ doesn't stall the response for the fetch's full
    // connection timeout.
    const flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    await Promise.race([
      a.flush().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, flushTimeoutMs).unref?.()),
    ]);
  };
}

interface HonoContextLike {
  /**
   * On Vercel/Cloudflare/Bun this is `{ waitUntil }`. On Node dev servers
   * Hono's getter throws — we handle that with try/catch in the middleware.
   */
  readonly executionCtx?: { waitUntil?: (p: Promise<unknown>) => void };
}
