// Next.js App Router GET handler for /api/flags.
//
// Returns the flag map as JSON. Backed by any FlagSource — defaults to
// edgeConfigSource() reading from process.env.EDGE_CONFIG.
//
// Use this when browser / RN clients need to read flags. Server code
// should consume the source directly (no extra HTTP hop needed).

import type { FlagMap, FlagSource } from "../flags.js";
import { edgeConfigSource } from "../flag-sources/edge-config.js";

export interface FlagsRouteOptions {
  /**
   * Source to read flags from. Defaults to `edgeConfigSource()`.
   * Pass a custom source for testing, or to read from a different store.
   */
  source?: FlagSource;
  /**
   * Resolves the authenticated userId. Return a string to allow, throw or
   * return `null` to reject. If omitted, the route is unauthenticated —
   * fine for trusted server-to-server use, NOT fine for public exposure
   * since flag config (experiment names, allowlists) leaks to the caller.
   */
  resolveUser?: (req: Request) => Promise<string | null> | string | null;
  /**
   * If set, requests with header `x-api-key: <apiKey>` bypass `resolveUser`.
   * Useful for CLI / cron jobs.
   */
  apiKey?: string;
  /**
   * Cache-control header on the response. Defaults to no-store (so clients
   * always see the latest), but you can opt into short caching to reduce
   * server load.
   */
  cacheControl?: string;
  /**
   * Filter the flag set per-request (e.g. only return flags relevant to
   * the caller's user, or strip `users[]` to avoid leaking allowlists).
   */
  filter?: (flags: FlagMap, req: Request, userId: string | null) => FlagMap;
}

export function createFlagsRoute(opts: FlagsRouteOptions = {}) {
  const source = opts.source ?? edgeConfigSource();
  const cacheControl = opts.cacheControl ?? "no-store";

  return async function GET(req: Request): Promise<Response> {
    let userId: string | null = null;
    if (opts.apiKey && req.headers.get("x-api-key") === opts.apiKey) {
      // pass
    } else if (opts.resolveUser) {
      try {
        userId = (await opts.resolveUser(req)) ?? null;
        if (!userId) return json({ error: "unauthenticated" }, 401);
      } catch (err) {
        return json({ error: "auth failed", detail: (err as Error).message }, 401);
      }
    }

    let flags: FlagMap;
    try {
      flags = await source.read();
    } catch (err) {
      return json({ error: "source read failed", detail: (err as Error).message }, 502);
    }

    if (opts.filter) flags = opts.filter(flags, req, userId);

    return new Response(JSON.stringify({ flags }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": cacheControl,
      },
    });
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
