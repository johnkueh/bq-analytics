import { createLogDrainRoute } from "bq-analytics/next";

/**
 * /api/internal/log-drain
 *
 * Receives Vercel Log Drain batches (NDJSON via POST) and answers Vercel's
 * endpoint validation challenge (GET → returns `x-vercel-verify`).
 *
 * `vercelVerifyToken` is required for new Vercel projects — the validator
 * probes GET with no headers and expects the response to carry the team's
 * verify token. The setup script auto-pushes it as VERCEL_VERIFY_TOKEN.
 *
 * IMPORTANT: never console.log inside POST — drain lines are themselves
 * drained, creating an infinite loop.
 */
export const { POST, GET } = createLogDrainRoute({
  projectId: process.env.GCP_PROJECT_ID,
  logsDataset: process.env.BQ_LOGS_DATASET ?? "logs",
  secret: process.env.LOG_DRAIN_SECRET!,
  vercelVerifyToken: process.env.VERCEL_VERIFY_TOKEN,
});
