// Thin wrapper around `Analytics.log()` that also writes to stdout. Designed
// as a drop-in replacement for `console.{log,warn,error}` in server-side
// code that wants log lines to land in `<dataset>.logs.raw` directly.
//
// This is the way to get server logs into BigQuery: call `logger.info(...)`
// from your own code and the line is stored via the bq-analytics transport
// you're already running. Note this captures only what you explicitly emit —
// Vercel runtime logs and third-party `console.*` you can't intercept are
// not collected here; use the `vercel-logs` CLI for those.

import type { Analytics } from "./core.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFieldArg = Record<string, unknown> | Error | unknown;

export interface CreateLoggerOptions {
  /** Stored verbatim in `logs.raw.source`. Defaults to `"app"`. */
  source?: string;
  /**
   * Also write to stdout/stderr so the line shows up in your platform's
   * live-tail viewer (e.g. `vercel logs`). Defaults to `true`. Set `false`
   * for environments that only want the BQ write.
   */
  stdout?: boolean;
}

export interface Logger {
  debug(message: string, fields?: LogFieldArg): void;
  info(message: string, fields?: LogFieldArg): void;
  warn(message: string, fields?: LogFieldArg): void;
  error(message: string, fields?: LogFieldArg): void;
}

/**
 * Coerce a `console.log`-style second arg into the `Record<string, unknown>`
 * that `Analytics.log()` accepts. Handles the common `catch (e) { … }` case
 * where `e: unknown` would otherwise force every caller to pre-wrap.
 */
function toFields(fields: LogFieldArg): Record<string, unknown> {
  if (fields === undefined || fields === null) return {};
  if (fields instanceof Error) {
    return { err: fields.message, stack: fields.stack };
  }
  if (typeof fields === "object" && !Array.isArray(fields)) {
    return fields as Record<string, unknown>;
  }
  return { value: typeof fields === "string" ? fields : String(fields) };
}

/**
 * Build a `console`-shaped logger that emits to stdout AND to
 * `<logsDataset>.raw` via the supplied Analytics instance.
 *
 * Accepts either an `Analytics` instance directly or a `() => Analytics`
 * thunk (useful when your app initializes the singleton lazily on a
 * `globalThis.__bqa` cache).
 *
 * @example
 *   // your-app/lib/logger.ts
 *   import { createLogger } from "bq-analytics/logger";
 *   import { analytics } from "./analytics"; // returns Analytics singleton
 *   export const logger = createLogger(analytics, { source: "lambda" });
 *
 *   // anywhere in your server code
 *   logger.info("[submit] accepted", { url, pending_id });
 *   try { ... } catch (e) { logger.error("submit failed", e); }
 */
export function createLogger(
  analyticsOrResolver: Analytics | (() => Analytics),
  options: CreateLoggerOptions = {},
): Logger {
  const resolve: () => Analytics =
    typeof analyticsOrResolver === "function"
      ? (analyticsOrResolver as () => Analytics)
      : () => analyticsOrResolver;
  const source = options.source ?? "app";
  const useStdout = options.stdout ?? true;

  function emit(level: LogLevel, message: string, fields?: LogFieldArg) {
    if (useStdout) {
      if (level === "error") console.error(message, fields);
      else if (level === "warn") console.warn(message, fields);
      else if (level === "debug") console.debug(message, fields);
      else console.log(message, fields);
    }

    try {
      resolve().log(level, message, toFields(fields), source);
    } catch {
      // Never let log emission throw — would otherwise mask the failure the
      // caller is trying to log.
    }
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
