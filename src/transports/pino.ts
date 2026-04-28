import { Writable } from "node:stream";
import type { Analytics, BqTransportConfig, Props } from "../index.js";
import { Analytics as AnalyticsClass, bqTransport } from "../index.js";

export interface PinoBqTransportConfig extends BqTransportConfig {
  /** Logged as the `source` field on every line. Default "app" */
  source?: string;
  /**
   * Existing Analytics instance to share buffer with. If omitted, a new one
   * is created using `bqTransport(config)`.
   */
  analytics?: Analytics;
  /** Auto-flush after this many lines. Default 50. */
  flushAt?: number;
  /** Forwarding function for fields beyond the standard pino set. Default JSON.stringify. */
}

const PINO_LEVEL: Record<number, "debug" | "info" | "warn" | "error"> = {
  10: "debug",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error",
};

/**
 * Pino destination stream that batches log lines into bq-analytics.
 *
 * ```ts
 * import pino from "pino";
 * import { pinoBqTransport } from "bq-analytics/pino";
 *
 * const logger = pino({}, pinoBqTransport({ projectId: "..." }));
 * logger.info({ requestId: "r1" }, "request received");
 * ```
 *
 * The destination forwards each pino line into `Analytics.log()` and flushes
 * to BigQuery via the standard transport. Standard pino fields
 * (`level`, `msg`, `time`) are unpacked; everything else lands in `fields`.
 */
export function pinoBqTransport(config: PinoBqTransportConfig): Writable {
  const a =
    config.analytics ??
    new AnalyticsClass({
      transport: bqTransport(config),
      flushAt: config.flushAt ?? 50,
    });
  const source = config.source ?? "app";

  return new Writable({
    write(chunk, _enc, cb) {
      try {
        const obj = JSON.parse(chunk.toString()) as {
          level?: number;
          msg?: string;
          time?: number;
          [k: string]: unknown;
        };
        const { level, msg, time, ...rest } = obj;
        const lvl = PINO_LEVEL[level ?? 30] ?? "info";
        a.log(lvl, msg ?? "", rest as Props, source);
        cb();
      } catch {
        cb(); // ignore unparseable lines
      }
    },
  });
}
