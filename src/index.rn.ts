// React Native / browser-bundle entry. Bundlers (Metro, esbuild, Webpack)
// pick this up via the `react-native` / `browser` export conditions in
// package.json. Server-only modules (auth.ts, insert.ts, bqTransport) are
// not transitively reachable from here, so RN bundles never see node:crypto,
// node:child_process, or @vercel/functions/oidc.

export type {
  AnalyticsConfig,
  BaseAttrs,
  BufferedRecord,
  EventRow,
  GroupRow,
  IdentifyRow,
  LogRow,
  Props,
  Transport,
  UserGroupRow,
} from "./types.js";

export { Analytics, httpTransport, type HttpTransportConfig } from "./core.js";
export {
  Flags,
  type Flag,
  type FlagMap,
  type FlagsConfig,
  type FlagSource,
} from "./flags.js";
export { httpSource, type HttpSourceConfig } from "./flag-sources/http.js";
