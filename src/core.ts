// Pure analytics buffer + transport dispatch. Zero Node / Vercel deps so this
// file is safe to import from RN/browser bundles.

import type {
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
import { randomId } from "./types.js";

export type FeedbackKind = "bug" | "request" | "general" | (string & {});

export interface FeedbackInput {
  /** "bug" | "request" | "general" — anything else is accepted as a custom kind. Default "general". */
  kind?: FeedbackKind;
  /** Optional short subject line. */
  subject?: string;
  /** Free-text body. Required. */
  message: string;
  /** For bug reports: e.g. "low" | "medium" | "high" | "critical". */
  severity?: string;
  /** URL / route the user was on when they submitted. */
  url?: string;
  /** Arbitrary structured metadata (app version, screen, build, etc.). */
  properties?: Props;
}

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
      event_id: randomId(),
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

  feedback(input: FeedbackInput, attrs: BaseAttrs = {}): void {
    if (!input || typeof input.message !== "string" || input.message.length === 0) {
      throw new Error("feedback(): message is required");
    }
    const row: FeedbackRow = {
      feedback_id: randomId(),
      ts: nowIso(),
      kind: input.kind ?? "general",
      subject: input.subject ?? null,
      message: input.message,
      severity: input.severity ?? null,
      url: input.url ?? null,
      user_id: attrs.userId ?? null,
      anonymous_id: attrs.anonymousId ?? null,
      session_id: attrs.sessionId ?? null,
      properties: JSON.stringify(input.properties ?? {}),
    };
    this.buffer.push({ kind: "feedback", row });
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
