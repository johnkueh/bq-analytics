import { createLogDrainRoute } from "bq-analytics/next";

/**
 * /api/internal/log-drain
 *
 * Receives Vercel Log Drain batches (NDJSON via POST) and answers Vercel's
 * endpoint validation challenge (GET → echo `x-vercel-verify`).
 *
 * The shared secret matches the `x-drain-secret` header registered when
 * creating the drain (the setup script does this for you).
 *
 * IMPORTANT: never console.log inside POST — drain lines are themselves
 * drained, creating an infinite loop.
 */
export const { POST, GET } = createLogDrainRoute({
  projectId: process.env.GCP_PROJECT_ID,
  logsDataset: process.env.BQ_LOGS_DATASET ?? "logs",
  secret: process.env.LOG_DRAIN_SECRET!,
});
