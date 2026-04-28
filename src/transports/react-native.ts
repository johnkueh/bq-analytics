import type { BufferedRecord, Transport } from "../types.js";

export interface RNStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ReactNativeTransportConfig {
  /** Full URL of /api/track endpoint */
  url: string;
  /** Optional extra headers (e.g. { authorization: `Bearer ${deviceToken}` }) */
  headers?: Record<string, string>;
  /** AsyncStorage-shaped persistence (pass `@react-native-async-storage/async-storage` default export) */
  storage?: RNStorageLike;
  /** Storage key for retry queue. Default "bqa.q" */
  storageKey?: string;
  /** Max events held in storage before dropping oldest. Default 1000 */
  maxQueued?: number;
  /** Per-attempt fetch timeout in ms. Default 8000 */
  timeoutMs?: number;
}

/** React Native / Expo transport: fetch with timeout + AsyncStorage retry queue. */
export function reactNativeTransport(config: ReactNativeTransportConfig): Transport {
  const storageKey = config.storageKey ?? "bqa.q";
  const maxQueued = config.maxQueued ?? 1000;
  const timeoutMs = config.timeoutMs ?? 8000;

  if (config.storage) void retryStored().catch(() => {});

  return {
    async send(records) {
      if (records.length === 0) return;
      const ok = await trySend(records);
      if (!ok) await persist(records);
    },
  };

  async function trySend(records: BufferedRecord[]): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify({ records }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function retryStored() {
    if (!config.storage) return;
    const raw = await config.storage.getItem(storageKey);
    if (!raw) return;
    let stored: BufferedRecord[] = [];
    try {
      stored = JSON.parse(raw) as BufferedRecord[];
    } catch {
      await config.storage.removeItem(storageKey);
      return;
    }
    if (stored.length === 0) return;
    await config.storage.removeItem(storageKey);
    const ok = await trySend(stored);
    if (!ok) await persist(stored);
  }

  async function persist(records: BufferedRecord[]) {
    if (!config.storage) return;
    let existing: BufferedRecord[] = [];
    try {
      const raw = await config.storage.getItem(storageKey);
      if (raw) existing = JSON.parse(raw) as BufferedRecord[];
    } catch {
      existing = [];
    }
    const merged = [...existing, ...records].slice(-maxQueued);
    try {
      await config.storage.setItem(storageKey, JSON.stringify(merged));
    } catch {
      // ignore
    }
  }
}

interface RNAnalyticsLike {
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
    source?: string,
  ) => void;
  track: (event: string, props?: Record<string, unknown>, attrs?: Record<string, unknown>) => void;
  flush: () => Promise<void> | void;
}

interface ErrorUtilsLike {
  getGlobalHandler(): ((error: unknown, isFatal?: boolean) => void) | null;
  setGlobalHandler(fn: (error: unknown, isFatal?: boolean) => void): void;
}

interface AppStateLike {
  addEventListener(
    event: "change",
    listener: (state: string) => void,
  ): { remove(): void };
}

/**
 * Static or dynamically-resolved attribute bag passed alongside each event
 * fired by `attachExpoErrorHandler` / `attachAppStateFlush`. Pass a function
 * when the values can change after attach (typical for `userId` — identity
 * usually loads asynchronously after the analytics instance is wired up).
 */
type AttrsOrGetter = Record<string, unknown> | (() => Record<string, unknown>);

function resolveAttrs(attrs: AttrsOrGetter): Record<string, unknown> {
  return typeof attrs === "function" ? attrs() : attrs;
}

/**
 * Capture RN uncaught JS errors via ErrorUtils.setGlobalHandler.
 *
 * Pass `ErrorUtils` (it's a global in RN) and (optionally) extra context.
 * Pass `context` as a function when its values can change after attach
 * (e.g. `userId` from an identity provider that loads asynchronously) —
 * the function is called every time an error fires.
 *
 * ```ts
 * import { Analytics } from "bq-analytics";
 * import { reactNativeTransport, attachExpoErrorHandler } from "bq-analytics/react-native";
 *
 * const a = new Analytics({ transport: reactNativeTransport({ url, storage: AsyncStorage }) });
 * attachExpoErrorHandler(a, ErrorUtils, () => ({
 *   platform: Platform.OS,
 *   userId: getCurrentIdentity()?.id,
 * }));
 * ```
 */
export function attachExpoErrorHandler(
  analytics: RNAnalyticsLike,
  errorUtils: ErrorUtilsLike,
  context: AttrsOrGetter = {},
  opts: { source?: string } = {},
) {
  const source = opts.source ?? "rn";
  const previous = errorUtils.getGlobalHandler();

  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const isErr = error instanceof Error;
    analytics.log(
      "error",
      isErr ? error.message : String(error),
      {
        stack: isErr ? error.stack ?? null : null,
        fatal: !!isFatal,
        kind: "uncaught_exception",
        ...resolveAttrs(context),
      },
      source,
    );
    void analytics.flush();
    if (previous) previous(error, isFatal);
  });

  return function detach() {
    if (previous) errorUtils.setGlobalHandler(previous);
  };
}

/**
 * Track RN AppState transitions and flush when the app backgrounds.
 *
 * Pass `attrs` as a function when its values can change after attach
 * (e.g. identity loads asynchronously) — it's invoked every state change.
 *
 * ```ts
 * import { AppState } from "react-native";
 * attachAppStateFlush(a, AppState, () => ({ userId: getCurrentIdentity()?.id }));
 * ```
 */
export function attachAppStateFlush(
  analytics: RNAnalyticsLike,
  appState: AppStateLike,
  attrs: AttrsOrGetter = {},
  opts: { trackEvents?: boolean } = {},
) {
  const trackEvents = opts.trackEvents ?? true;
  const sub = appState.addEventListener("change", (state) => {
    if (trackEvents) {
      analytics.track("app.state_changed", { state }, resolveAttrs(attrs));
    }
    if (state === "background" || state === "inactive") {
      void analytics.flush();
    }
  });
  return function detach() {
    sub.remove();
  };
}
