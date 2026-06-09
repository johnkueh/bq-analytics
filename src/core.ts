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

export type FeedbackKind =
  | "bug"
  | "request"
  | "general"
  | "email"
  | "bounce"
  | "complaint"
  | (string & {});

export interface FeedbackInput {
  /**
   * `bug` / `request` / `general` — in-product feedback (e.g. a FeedbackSheet).
   * `email` — inbound support email captured via a webhook (e.g. Resend `email.received`).
   * `bounce` / `complaint` — deliverability signals from the email provider.
   * Anything else is accepted as a custom kind. Default "general".
   */
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

  /**
   * Open a scope for a multi-step operation (HTTP request, CLI command, client
   * orchestration function). Accumulate context with `scope.set(...)` and call
   * `scope.end()` when the operation finishes — one wide row lands in
   * `logs.raw` with all accumulated fields plus `duration_ms`.
   *
   * Use `withScope(analytics, opts, fn)` for the common try/catch/end shape.
   */
  scope(opts: ScopeOptions): Scope {
    return new Scope(this, opts);
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

export interface ScopeOptions {
  /**
   * Stable namespace written to `logs.raw.source`. Pick one per orchestration
   * (e.g. `"process"`, `"submit"`, `"instagram_extract"`) so wide-event rows
   * are filterable by where they came from.
   */
  source: string;
  /**
   * Written to `logs.raw.message`. Default `"scope"`. The accumulated context
   * lives in `fields` — message stays short.
   */
  message?: string;
  /**
   * Initial fields. Useful for identifiers that apply to the whole scope
   * (request_id, household_id, source_type).
   */
  fields?: Props;
  /**
   * Default `"info"`. If `scope.error(...)` is called, the level is auto-
   * promoted to `"error"` regardless of this setting.
   */
  level?: "debug" | "info" | "warn" | "error";
}

/**
 * Wide-event accumulator for a bounded operation. Built via `analytics.scope({...})`
 * or wrapped via `withScope(analytics, {...}, fn)`. Emits one log row on `end()`.
 */
export class Scope {
  private analytics: Pick<Analytics, "log">;
  private opts: ScopeOptions;
  private fields: Props;
  private startedAt: number;
  private errored = false;
  private ended = false;

  constructor(analytics: Pick<Analytics, "log">, opts: ScopeOptions) {
    this.analytics = analytics;
    this.opts = opts;
    this.fields = { ...(opts.fields ?? {}) };
    this.startedAt = Date.now();
  }

  /** Merge fields into the accumulator. Last write wins per key. */
  set(fields: Props): this {
    Object.assign(this.fields, fields);
    return this;
  }

  /**
   * Record an error. Promotes the eventual log level to `"error"`. Does NOT
   * end the scope — callers typically rethrow and let `withScope` (or their
   * own finally block) call `end()`.
   */
  error(err: unknown, fields: Props = {}): this {
    this.errored = true;
    const isErr = err instanceof Error;
    Object.assign(this.fields, fields, {
      error_message: isErr ? err.message : String(err),
      error_stack: isErr ? err.stack ?? null : null,
    });
    return this;
  }

  /**
   * Emit the wide-event row. Idempotent — subsequent calls are no-ops.
   * Auto-stamps `duration_ms`. Pass final fields here if you have last-mile
   * outcome data (status, recipe_id, etc.).
   */
  end(fields: Props = {}): void {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.fields, fields, {
      duration_ms: Date.now() - this.startedAt,
    });
    const level = this.errored ? "error" : this.opts.level ?? "info";
    this.analytics.log(level, this.opts.message ?? "scope", this.fields, this.opts.source);
  }

  /** True after `end()` has fired. */
  get isEnded(): boolean {
    return this.ended;
  }
}

/**
 * Wrap an async orchestration in a scope. Catches and rethrows so the scope
 * always ends with the right level/fields:
 *
 * - Returns the function's value on success (scope ends with `level: "info"`).
 * - Records the thrown error and ends the scope with `level: "error"`,
 *   then rethrows so callers handle it normally.
 *
 * ```ts
 * await withScope(analytics, { source: "process", fields: { pendingId } }, async (scope) => {
 *   scope.set({ cacheChecked: true });
 *   const result = await doWork();
 *   scope.set({ outcome: "success", recipeId: result.id });
 * });
 * ```
 */
export async function withScope<T>(
  analytics: Pick<Analytics, "log" | "scope">,
  opts: ScopeOptions,
  fn: (scope: Scope) => Promise<T> | T,
): Promise<T> {
  const scope = analytics.scope(opts);
  try {
    const result = await fn(scope);
    scope.end();
    return result;
  } catch (err) {
    scope.error(err);
    scope.end();
    throw err;
  }
}
