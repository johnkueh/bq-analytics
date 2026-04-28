export type Props = Record<string, unknown>;

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

export type BufferedRecord =
  | { kind: "event"; row: EventRow }
  | { kind: "identify"; row: IdentifyRow }
  | { kind: "group"; row: GroupRow }
  | { kind: "user_group"; row: UserGroupRow }
  | { kind: "log"; row: LogRow };

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
