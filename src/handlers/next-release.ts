// Next.js App Router GET handler for /api/release-config.
//
// Reads from a `ConfigSource<ReleaseConfig>` (defaults to
// `edgeConfigSource({key: 'release', validator: isReleaseConfig})`) and
// returns the typed JSON blob. Failures (missing connection, schema
// mismatch, source error) fall back to `DEFAULT_RELEASE_CONFIG` so
// clients always get a structurally-valid response — fail-open by
// design, since this powers the gate and the gate must never
// accidentally lock anyone out.

import type { ConfigSource } from "../config/core.js";
import { edgeConfigSource } from "../config/edge-config.js";
import {
  DEFAULT_RELEASE_CONFIG,
  RELEASE_KEY,
  type ReleaseConfig,
  isReleaseConfig,
} from "../release/schema.js";

export interface ReleaseConfigRouteOptions {
  /**
   * Source to read from. Defaults to `edgeConfigSource({key: 'release',
   * validator: isReleaseConfig})`. Override for tests / custom stores.
   */
  source?: ConfigSource<ReleaseConfig>;
  /**
   * Cache-Control header on the response. Defaults to a 60s edge cache
   * (matches recipes.im's production setting). Drop / shorten if you
   * need faster propagation but accept higher origin load.
   */
  cacheControl?: string;
  /**
   * Edge Config item key. Defaults to `'release'`. Override only if
   * you're storing the blob under a non-standard key.
   */
  edgeConfigKey?: string;
}

export function createReleaseConfigRoute(opts: ReleaseConfigRouteOptions = {}) {
  const source =
    opts.source ??
    edgeConfigSource<ReleaseConfig>({
      key: opts.edgeConfigKey ?? RELEASE_KEY,
      validator: isReleaseConfig,
    });
  const cacheControl = opts.cacheControl ?? "public, max-age=60, s-maxage=60";

  return async function GET(_req: Request): Promise<Response> {
    let config: ReleaseConfig = DEFAULT_RELEASE_CONFIG;
    try {
      const value = await source.read();
      if (value) config = value;
    } catch (err) {
      console.warn("[bq-analytics/release] source read failed:", err);
    }
    return new Response(JSON.stringify(config), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": cacheControl,
      },
    });
  };
}
