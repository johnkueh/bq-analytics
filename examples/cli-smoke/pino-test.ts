#!/usr/bin/env tsx
/**
 * Smoke test for `bq-analytics/pino` — pipes a few pino log lines into
 * BQ and verifies they land in logs.raw with the right level + fields.
 *
 * Usage:
 *   GCP_PROJECT_ID=... BQ_LOGS_DATASET=... pnpm smoke:pino
 */
import pino from "pino";
import { Analytics, bqTransport } from "../../src/index.js";
import { pinoBqTransport } from "../../src/transports/pino.js";

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) {
  console.error("GCP_PROJECT_ID is required");
  process.exit(1);
}

const RUN_ID = `pino-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
console.log(`[pino-smoke] run_id=${RUN_ID}`);

const a = new Analytics({
  transport: bqTransport({
    projectId,
    eventsDataset: process.env.BQ_EVENTS_DATASET ?? "bq_analytics_smoke_events",
    logsDataset: process.env.BQ_LOGS_DATASET ?? "bq_analytics_smoke_logs",
  }),
});

const dest = pinoBqTransport({ projectId, analytics: a, source: "pino-smoke" });
const logger = pino({ level: "debug" }, dest);

logger.info({ run_id: RUN_ID, request_id: "rq-1" }, "incoming request");
logger.warn({ run_id: RUN_ID, retries: 2 }, "transient blip");
logger.error({ run_id: RUN_ID, code: "DB_TIMEOUT" }, "downstream timeout");

await a.flush();
console.log(`[pino-smoke] flushed. verify with:`);
console.log(`  pnpm smoke:query ${RUN_ID}`);
