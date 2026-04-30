export type Props = Record<string, unknown>;

/**
 * UUID-shaped random string. Uses globalThis.crypto.randomUUID where
 * available (Node 18+, modern browsers, RN with a polyfill). Falls back
 * to a Math.random-based UUIDv4 for environments without crypto in scope
 * (Hermes-based React Native by default, older bundlers, etc.).
 *
 * Not cryptographically random — that's fine for analytics event IDs,
 * which exist for de-duplication, not authentication.
 */
export function randomId(): string {
  if (typeof globalThis !== "undefined") {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  }
  // UUIDv4 shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y ∈ {8,9,a,b}
  const r = (n: number) => Math.floor(Math.random() * n);
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[r(4) | 8];
    else out += hex[r(16)];
  }
  return out;
}

export interface BaseAttrs {
  userId?: string | null;
  anonymousId?: string | null;
  sessionId?: string | null;
}

export type EventRow = {
  event_id: string;
  ts: string;
  event_name: string;
  user_id: string | null;
  anonymous_id: string | null;
  session_id: string | null;
  properties: string;
};

export type IdentifyRow = {
  ts: string;
  user_id: string;
  traits: string;
};

export type GroupRow = {
  ts: string;
  group_type: string;
  group_id: string;
  traits: string;
};

export type UserGroupRow = {
  ts: string;
  user_id: string;
  group_type: string;
  group_id: string;
};

export type LogRow = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  fields: string;
};

export type FeedbackRow = {
  feedback_id: string;
  ts: string;
  kind: string;
  subject: string | null;
  message: string;
  severity: string | null;
  url: string | null;
  user_id: string | null;
  anonymous_id: string | null;
  session_id: string | null;
  properties: string;
};

export type BufferedRecord =
  | { kind: "event"; row: EventRow }
  | { kind: "identify"; row: IdentifyRow }
  | { kind: "group"; row: GroupRow }
  | { kind: "user_group"; row: UserGroupRow }
  | { kind: "log"; row: LogRow }
  | { kind: "feedback"; row: FeedbackRow };

export interface Transport {
  send(records: BufferedRecord[]): Promise<void>;
}

export interface AnalyticsConfig {
  transport: Transport;
  /** Auto-flush after this many records (server only). Default 50. */
  flushAt?: number;
  /** Auto-flush after this many ms (browser/RN only). Default 5000. */
  flushIntervalMs?: number;
}
