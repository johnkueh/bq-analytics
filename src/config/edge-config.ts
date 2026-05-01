// Vercel Edge Config source for typed config blobs. Reads a single
// key out of an Edge Config store, optionally validates the shape,
// and returns it as a typed value (or null on validation failure /
// missing key — caller's `defaultValue` then takes over).
//
// `@vercel/edge-config` is an optional peer dep (loaded dynamically),
// so non-Vercel bundles never pull it transitively.

import type { ConfigSource, ConfigValidator } from "./core.js";

export interface EdgeConfigSourceOptions<T> {
  /** Edge Config item key. Required. */
  key: string;
  /**
   * Edge Config connection string. Defaults to `process.env.EDGE_CONFIG`,
   * which Vercel auto-injects when an Edge Config is connected to a project.
   */
  connectionString?: string;
  /**
   * Validator. Called on the raw value; if it returns false, we treat
   * the read as "no value" and return null (caller falls back to default).
   */
  validator?: ConfigValidator<T>;
}

export function edgeConfigSource<T>(options: EdgeConfigSourceOptions<T>): ConfigSource<T> {
  const { key, connectionString, validator } = options;
  let getValue: (() => Promise<unknown>) | null = null;

  return {
    async read(): Promise<T | null> {
      if (!getValue) {
        const ec = (await import("@vercel/edge-config")) as {
          get: <V>(k: string) => Promise<V | undefined>;
          createClient: (cs: string) => { get: <V>(k: string) => Promise<V | undefined> };
        };
        if (connectionString) {
          const client = ec.createClient(connectionString);
          getValue = () => client.get(key);
        } else {
          getValue = () => ec.get(key);
        }
      }
      const value = await getValue();
      if (value === undefined || value === null) return null;
      if (validator && !validator(value)) return null;
      return value as T;
    },
  };
}
