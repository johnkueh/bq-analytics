#!/usr/bin/env tsx
/**
 * Smoke test for `bq-analytics/cli` — sets up CLI hooks, throws an
 * uncaught exception, and exits. The error should land in logs.raw.
 *
 * Usage:
 *   GCP_PROJECT_ID=... BQ_LOGS_DATASET=... pnpm smoke:cli-error
 */
import { Analytics, bqTransport } from "../../src/index.js";
import { attachCliHooks } from "../../src/cli/attach.js";

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) {
  console.error("GCP_PROJECT_ID is required");
  process.exit(1);
}

const RUN_ID = `cli-error-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
console.log(`[cli-error] run_id=${RUN_ID}`);

const a = new Analytics({
  transport: bqTransport({
    projectId,
    eventsDataset: process.env.BQ_EVENTS_DATASET ?? "bq_analytics_smoke_events",
    logsDataset: process.env.BQ_LOGS_DATASET ?? "bq_analytics_smoke_logs",
  }),
});

attachCliHooks(a, { source: "cli-smoke" });

a.log("info", "cli-error smoke starting", { run_id: RUN_ID }, "cli-smoke");

// Trigger uncaughtException — the hook should capture it, flush, and exit(1).
setTimeout(() => {
  throw new Error(`intentional crash for ${RUN_ID}`);
}, 50);
