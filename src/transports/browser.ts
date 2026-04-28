import type { BufferedRecord, Transport } from "../types.js";

export interface BrowserTransportConfig {
  /** URL of /api/track endpoint */
  url: string;
  /** Optional extra headers */
  headers?: Record<string, string>;
  /** localStorage key to persist failed batches. Default "bqa.q" */
  storageKey?: string;
  /** Max events to keep in localStorage before dropping oldest. Default 1000 */
  maxQueued?: number;
}

/** Browser transport: sendBeacon when possible, fetch+keepalive fallback,
 *  localStorage persistence for retry on next page load. */
export function browserTransport(config: BrowserTransportConfig): Transport {
  const storageKey = config.storageKey ?? "bqa.q";
  const maxQueued = config.maxQueued ?? 1000;

  void retryStored().catch(() => {});

  return {
    async send(records) {
      if (records.length === 0) return;
      const ok = await trySend(records);
      if (!ok) persist(records, storageKey, maxQueued);
    },
  };

  async function trySend(records: BufferedRecord[]): Promise<boolean> {
    const body = JSON.stringify({ records });
    const useBeacon =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      !config.headers;

    if (useBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(config.url, blob);
      if (ok) return true;
    }

    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body,
        keepalive: true,
        credentials: "same-origin",
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function retryStored() {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    let stored: BufferedRecord[] = [];
    try {
      stored = JSON.parse(raw) as BufferedRecord[];
    } catch {
      localStorage.removeItem(storageKey);
      return;
    }
    if (stored.length === 0) return;
    localStorage.removeItem(storageKey);
    const ok = await trySend(stored);
    if (!ok) persist(stored, storageKey, maxQueued);
  }
}

function persist(records: BufferedRecord[], key: string, max: number) {
  if (typeof localStorage === "undefined") return;
  const existing = (() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]") as BufferedRecord[];
    } catch {
      return [] as BufferedRecord[];
    }
  })();
  const merged = [...existing, ...records].slice(-max);
  try {
    localStorage.setItem(key, JSON.stringify(merged));
  } catch {
    // quota exceeded — drop
  }
}

/** Browser-only convenience: flush on visibility change + pagehide. */
export function attachBrowserAutoFlush(flush: () => Promise<void> | void) {
  if (typeof document === "undefined") return;
  const handler = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  document.addEventListener("visibilitychange", handler);
  window.addEventListener("pagehide", () => void flush());
  return () => {
    document.removeEventListener("visibilitychange", handler);
  };
}

interface BrowserAnalyticsLike {
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
    source?: string,
  ) => void;
  flush: () => Promise<void> | void;
}

/**
 * Auto-capture uncaught browser errors into `analytics.log("error", ...)`.
 * Hooks both `window.onerror` (sync errors) and `unhandledrejection` (promises).
 */
export function attachWindowErrorHandler(
  analytics: BrowserAnalyticsLike,
  opts: { source?: string } = {},
) {
  if (typeof window === "undefined") return () => {};
  const source = opts.source ?? "browser";

  const onError = (event: ErrorEvent): void => {
    analytics.log(
      "error",
      event.message ?? "unknown",
      {
        stack: event.error?.stack ?? null,
        filename: event.filename ?? null,
        lineno: event.lineno ?? null,
        colno: event.colno ?? null,
        kind: "uncaught_exception",
      },
      source,
    );
    void analytics.flush();
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as unknown;
    const isErr = reason instanceof Error;
    analytics.log(
      "error",
      isErr ? reason.message : String(reason),
      {
        stack: isErr ? reason.stack ?? null : null,
        kind: "unhandled_rejection",
      },
      source,
    );
    void analytics.flush();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
