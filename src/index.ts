// Server (Node / Vercel Functions / etc.) entry. Re-exports the pure
// `Analytics` class from `./core.ts` plus the BigQuery direct-write transport
// `bqTransport` (which depends on auth.ts + insert.ts — both Node-only).
//
// React Native / browser consumers are routed to `./index.rn.ts` via the
// `react-native` / `browser` export conditions in package.json, so server-
// only deps (node:crypto, node:child_process, @vercel/functions/oidc) are
// never reachable from those builds.

import { insertRows } from "./insert.js";
import type { Transport } from "./types.js";

export type {
  AnalyticsConfig,
  BaseAttrs,
  BufferedRecord,
  EventRow,
  FeedbackRow,
  GroupRow,
  IdentifyRow,
  LogRow,
  Props,
  Transport,
  UserGroupRow,
} from "./types.js";

export {
  Analytics,
  httpTransport,
  type FeedbackInput,
  type FeedbackKind,
  type HttpTransportConfig,
} from "./core.js";
export {
  Flags,
  type Flag,
  type FlagMap,
  type FlagsConfig,
  type FlagSource,
} from "./flags.js";
export { httpSource, type HttpSourceConfig } from "./flag-sources/http.js";
export { insertRows, BqInsertError } from "./insert.js";
export { getAccessToken } from "./auth.js";

export interface BqTransportConfig {
  /**
   * GCP project id. May be undefined — when missing, the transport returns
   * a no-op `send()` so vitest runs / preview deploys without GCP env vars
   * don't crash on `flush()`. A console.warn is emitted once per process.
   */
  projectId?: string;
  eventsDataset?: string;
  logsDataset?: string;
}

let __noopWarned = false;

/** Server transport that writes directly to BigQuery via insertAll. */
export function bqTransport(config: BqTransportConfig): Transport {
  if (!config.projectId) {
    if (!__noopWarned) {
      __noopWarned = true;
      console.warn(
        "[bq-analytics] GCP_PROJECT_ID is not set; using no-op transport. " +
          "Events will be dropped silently. Set GCP_PROJECT_ID to enable.",
      );
    }
    return { async send() {} };
  }

  const projectId = config.projectId;
  const eventsDataset = config.eventsDataset ?? "events";
  const logsDataset = config.logsDataset ?? "logs";
  return {
    async send(records) {
      if (records.length === 0) return;
      const groups: Record<string, { dataset: string; table: string; rows: object[] }> = {};
      const push = (key: string, dataset: string, table: string, row: object) => {
        groups[key] ??= { dataset, table, rows: [] };
        groups[key].rows.push(row);
      };
      for (const r of records) {
        if (r.kind === "event") push("events.raw", eventsDataset, "raw", r.row);
        else if (r.kind === "identify") push("events.identifies", eventsDataset, "identifies", r.row);
        else if (r.kind === "group") push("events.groups", eventsDataset, "groups", r.row);
        else if (r.kind === "user_group")
          push("events.user_groups", eventsDataset, "user_groups", r.row);
        else if (r.kind === "feedback") push("events.feedback", eventsDataset, "feedback", r.row);
        else if (r.kind === "log") push("logs.raw", logsDataset, "raw", r.row);
      }
      await Promise.all(
        Object.values(groups).map((g) =>
          insertRows({ projectId }, g.dataset, g.table, g.rows as Record<string, unknown>[]),
        ),
      );
    },
  };
}
