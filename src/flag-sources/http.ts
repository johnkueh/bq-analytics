// HTTP flag source. Generic JSON fetcher — works in any runtime that has
// `fetch`: browser, RN, Bun, Deno, Node 18+, Cloudflare Workers, Vercel Edge.
//
// Use this on the *client* side to consume flags via your own `/api/flags`
// route (which itself uses `edgeConfigSource()` server-side). Don't expose
// the Edge Config read token to browsers / mobile apps directly.

import type { FlagMap, FlagSource } from "../flags.js";

export interface HttpSourceConfig {
  /** URL that returns the flag map as JSON. Required. */
  url: string;
  /** Extra headers (e.g. `authorization`). */
  headers?: Record<string, string>;
  /** Override the global `fetch` (e.g. for tests, or an auth-aware wrapper). */
  fetcher?: typeof fetch;
}

export function httpSource(config: HttpSourceConfig): FlagSource {
  return {
    async read(): Promise<FlagMap> {
      const f = config.fetcher ?? fetch;
      const res = await f(config.url, {
        method: "GET",
        headers: { accept: "application/json", ...config.headers },
      });
      if (!res.ok) {
        throw new Error(`http source ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const body = (await res.json()) as Record<string, unknown> | null;
      if (!body) return {};
      // Accept either { ...flags } or { flags: { ...flags } } envelope.
      const inner = body.flags;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as FlagMap;
      }
      return body as FlagMap;
    },
  };
}
