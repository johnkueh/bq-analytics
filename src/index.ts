import { insertRows } from "./insert.js";
import type {
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
};
export { insertRows, BqInsertError } from "./insert.js";
export { getAccessToken } from "./auth.js";

export class Analytics {
  private buffer: BufferedRecord[] = [];
  private flushAt: number;
  private transport: Transport;

  constructor(config: AnalyticsConfig) {
    this.transport = config.transport;
    this.flushAt = config.flushAt ?? 50;
  }

  track(event: string, properties: Props = {}, attrs: BaseAttrs = {}): void {
    const row: EventRow = {
      event_id: crypto.randomUUID(),
      ts: nowIso(),
      event_name: event,
      user_id: attrs.userId ?? null,
      anonymous_id: attrs.anonymousId ?? null,
      session_id: attrs.sessionId ?? null,
      properties: JSON.stringify(properties ?? {}),
    };
    this.buffer.push({ kind: "event", row });
    this.maybeAutoFlush();
  }

  identify(userId: string, traits: Props = {}): void {
    if (!userId) throw new Error("identify(): userId is required");
    const row: IdentifyRow = {
      ts: nowIso(),
      user_id: userId,
      traits: JSON.stringify(traits ?? {}),
    };
    this.buffer.push({ kind: "identify", row });
    this.maybeAutoFlush();
  }

  group(groupType: string, groupId: string, traits: Props = {}, userId?: string): void {
    if (!groupType || !groupId) throw new Error("group(): groupType and groupId are required");
    const ts = nowIso();
    const row: GroupRow = {
      ts,
      group_type: groupType,
      group_id: groupId,
      traits: JSON.stringify(traits ?? {}),
    };
    this.buffer.push({ kind: "group", row });
    if (userId) {
      const ug: UserGroupRow = { ts, user_id: userId, group_type: groupType, group_id: groupId };
      this.buffer.push({ kind: "user_group", row: ug });
    }
    this.maybeAutoFlush();
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields: Props = {},
    source = "app",
  ): void {
    const row: LogRow = {
      ts: nowIso(),
      level,
      source,
      message,
      fields: JSON.stringify(fields ?? {}),
    };
    this.buffer.push({ kind: "log", row });
    this.maybeAutoFlush();
  }

  /** Returns the count of buffered records (for tests / observability). */
  size(): number {
    return this.buffer.length;
  }

  /** Drains the buffer and sends through the transport. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const drain = this.buffer.splice(0);
    try {
      await this.transport.send(drain);
    } catch (err) {
      this.buffer.unshift(...drain);
      throw err;
    }
  }

  private maybeAutoFlush(): void {
    if (this.buffer.length >= this.flushAt) {
      void this.flush().catch(() => {});
    }
  }
}

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

/** Generic HTTP transport that POSTs the batch as JSON to a URL. */
export interface HttpTransportConfig {
  url: string;
  headers?: Record<string, string>;
  /** If set, called when send() throws; default rethrows. */
  onError?: (err: unknown, batch: BufferedRecord[]) => void;
}

export function httpTransport(config: HttpTransportConfig): Transport {
  return {
    async send(records) {
      if (records.length === 0) return;
      try {
        const res = await fetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...config.headers },
          body: JSON.stringify({ records }),
        });
        if (!res.ok) throw new Error(`http transport ${res.status}: ${await res.text()}`);
      } catch (err) {
        if (config.onError) config.onError(err, records);
        else throw err;
      }
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
