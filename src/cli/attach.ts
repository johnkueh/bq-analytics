import type { Analytics } from "../index.js";

export interface AttachCliHooksOptions {
  /** logged as the `source` field on captured errors. Default "cli" */
  source?: string;
  /** Exit the process after flushing on SIGINT/SIGTERM. Default true. */
  exitOnSignal?: boolean;
  /** Max time to wait for flush before giving up. Default 5000 ms. */
  flushTimeoutMs?: number;
}

/**
 * Attach process-level hooks that capture uncaught errors and flush
 * pending events before the CLI exits.
 *
 * ```ts
 * import { Analytics, bqTransport } from "bq-analytics";
 * import { attachCliHooks } from "bq-analytics/cli";
 *
 * const a = new Analytics({ transport: bqTransport({ projectId }) });
 * attachCliHooks(a, { source: "subsrip-cli" });
 *
 * a.track("cli.command_run", { command: process.argv[2] });
 * // ... do work ...
 * await a.flush();
 * ```
 *
 * The hooks installed:
 * - `uncaughtException`: log + flush + `process.exit(1)`
 * - `unhandledRejection`: log + best-effort flush
 * - `beforeExit`: flush
 * - `SIGINT` / `SIGTERM`: flush + `process.exit(0)` (when `exitOnSignal` is true)
 */
export function attachCliHooks(
  analytics: Analytics,
  options: AttachCliHooksOptions = {},
): () => void {
  const source = options.source ?? "cli";
  const exitOnSignal = options.exitOnSignal ?? true;
  const timeout = options.flushTimeoutMs ?? 5000;

  const flushBounded = async (): Promise<void> => {
    try {
      await Promise.race([
        analytics.flush(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("bq-analytics flush timeout")), timeout),
        ),
      ]);
    } catch {
      // best-effort
    }
  };

  const onUncaught = (err: Error): void => {
    analytics.log(
      "error",
      err.message ?? String(err),
      { stack: err.stack ?? null, fatal: true, kind: "uncaught_exception" },
      source,
    );
    void flushBounded().finally(() => process.exit(1));
  };

  const onUnhandled = (reason: unknown): void => {
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
    void flushBounded();
  };

  const onBeforeExit = (): void => {
    void flushBounded();
  };

  const onSignal = (sig: NodeJS.Signals) => () => {
    void flushBounded().finally(() => {
      if (exitOnSignal) process.exit(0);
    });
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("beforeExit", onBeforeExit);

  const sigintHandler = onSignal("SIGINT");
  const sigtermHandler = onSignal("SIGTERM");
  if (exitOnSignal) {
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);
  }

  return function detach() {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    process.off("beforeExit", onBeforeExit);
    if (exitOnSignal) {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
    }
  };
}
