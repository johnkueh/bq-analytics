// HTTP source for typed config blobs. Generic JSON fetcher — works in
// any runtime that has `fetch` (browser, RN, Bun, Deno, Node 18+,
// Cloudflare Workers, Vercel Edge).
//
// Use this on the *client* side to consume config via a server route
// (which itself uses `edgeConfigSource()` server-side). Don't expose
// the Edge Config read token to browsers / mobile apps directly.

import type { ConfigSource, ConfigValidator } from "./core.js";

export interface HttpConfigSourceOptions<T> {
  /** URL that returns the config as JSON. Required. */
  url: string;
  /** Validator. If false, read returns null (caller falls back to default). */
  validator?: ConfigValidator<T>;
  /** Extra headers (e.g. `authorization`). */
  headers?: Record<string, string>;
  /** Override the global `fetch` — handy for tests / auth-aware wrappers. */
  fetcher?: typeof fetch;
  /** Abort the fetch after this many ms. Default 2000. */
  timeoutMs?: number;
}

export function httpConfigSource<T>(options: HttpConfigSourceOptions<T>): ConfigSource<T> {
  const { url, validator, headers, fetcher, timeoutMs = 2000 } = options;
  return {
    async read(): Promise<T | null> {
      const f = fetcher ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await f(url, {
          method: "GET",
          headers: { accept: "application/json", ...headers },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        if (validator && !validator(body)) return null;
        return body as T;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
