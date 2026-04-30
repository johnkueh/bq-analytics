// Vercel Edge Config flag source. Reads a single key (default "flags")
// out of an Edge Config store and returns it as a FlagMap.
//
// `@vercel/edge-config` is a peer dep — only consumers using this source
// need to install it. Imported dynamically so non-Vercel bundles never
// pull it transitively.

import type { FlagMap, FlagSource } from "../flags.js";

export interface EdgeConfigSourceConfig {
  /**
   * Edge Config connection string. Defaults to `process.env.EDGE_CONFIG`,
   * which Vercel auto-injects when an Edge Config is connected to a project.
   */
  connectionString?: string;
  /** Key holding the flag map inside Edge Config. Default "flags". */
  key?: string;
}

export function edgeConfigSource(config: EdgeConfigSourceConfig = {}): FlagSource {
  const key = config.key ?? "flags";
  let getValue: (() => Promise<unknown>) | null = null;

  return {
    async read(): Promise<FlagMap> {
      if (!getValue) {
        const ec = (await import("@vercel/edge-config")) as {
          get: <T>(k: string) => Promise<T | undefined>;
          createClient: (cs: string) => { get: <T>(k: string) => Promise<T | undefined> };
        };
        if (config.connectionString) {
          const client = ec.createClient(config.connectionString);
          getValue = () => client.get<FlagMap>(key);
        } else {
          getValue = () => ec.get<FlagMap>(key);
        }
      }
      const value = (await getValue()) as FlagMap | undefined;
      return value ?? {};
    },
  };
}
