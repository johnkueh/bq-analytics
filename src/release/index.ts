// bq-analytics/release — opinionated release-management primitives.
//
// Server-driven force-update gate, post-update what's-new sheet, and
// per-channel store deeplinks. Cross-runtime exports (schema, evaluator,
// store-url, telemetry constants). For React Native components and
// hooks see `bq-analytics/release/native`.

export type {
  ReleaseGate,
  ChannelUpdateUrls,
  UpdateUrls,
  WhatsNewEntry,
  WhatsNew,
  ReleaseConfig,
} from "./schema.js";

export {
  DEFAULT_RELEASE_CONFIG,
  RELEASE_KEY,
  isReleaseConfig,
} from "./schema.js";

export type { GateVerdict, EvaluateGateOptions } from "./evaluate-gate.js";
export { evaluateGate } from "./evaluate-gate.js";

export type { OpenAppStoreOptions } from "./store-url.js";
export { openAppStore, resolveAppStoreUrl } from "./store-url.js";

export { RELEASE_EVENTS } from "./events.js";
export type { ReleaseEventName } from "./events.js";

export {
  HAS_LAUNCHED_KEY,
  LAST_SEEN_KEY,
  RELEASE_CACHE_KEY,
} from "./async-storage-keys.js";
