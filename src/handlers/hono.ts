import type { Analytics } from "../index.js";

/**
 * Hono middleware that flushes the analytics buffer once per response.
 *
 * Removes the need to call `waitUntil(analytics().flush())` in every route
 * handler. Single line in your app entry replaces N flush calls.
 *
 * Works on Vercel Functions (uses `executionCtx.waitUntil`), Cloudflare
 * Workers (same API), and Node.js (falls back to fire-and-forget).
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
 */
export function honoFlushMiddleware(getAnalytics: (() => Analytics) | Analytics) {
  const resolve = (): Analytics =>
    typeof getAnalytics === "function" ? (getAnalytics as () => Analytics)() : getAnalytics;

  return async function flushMiddleware(c: HonoContextLike, next: () => Promise<void>) {
    await next();
    const a = resolve();

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
    } else {
      void a.flush().catch(() => {});
    }
  };
}

interface HonoContextLike {
  /**
   * On Vercel/Cloudflare/Bun this is `{ waitUntil }`. On Node dev servers
   * Hono's getter throws — we handle that with try/catch in the middleware.
   */
  readonly executionCtx?: { waitUntil?: (p: Promise<unknown>) => void };
}
