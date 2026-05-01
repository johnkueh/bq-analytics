// bq-analytics/config — generic typed config primitive.
// Server-driven JSON blobs with fail-open defaults.

export { Config } from "./core.js";
export type {
  ConfigOptions,
  ConfigSource,
  ConfigValidator,
} from "./core.js";

export { edgeConfigSource } from "./edge-config.js";
export type { EdgeConfigSourceOptions } from "./edge-config.js";

export { httpConfigSource } from "./http.js";
export type { HttpConfigSourceOptions } from "./http.js";
