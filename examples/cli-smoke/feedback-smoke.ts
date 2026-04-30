#!/usr/bin/env tsx
/**
 * CLI smoke: send a representative mix of product feedback directly to BigQuery,
 * then print the run id so you can query it back.
 *
 * Auth: uses Application Default Credentials.
 *   gcloud auth application-default login
 *
 * Usage:
 *   pnpm smoke:feedback
 *   GCP_PROJECT_ID=foo BQ_EVENTS_DATASET=bar pnpm smoke:feedback
 */
import { Analytics, bqTransport } from "../../src/index.js";

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) {
  console.error("GCP_PROJECT_ID is required");
  process.exit(1);
}
const eventsDataset = process.env.BQ_EVENTS_DATASET ?? "bq_analytics_smoke_events";
const logsDataset = process.env.BQ_LOGS_DATASET ?? "bq_analytics_smoke_logs";

const RUN_ID = `feedback-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
  .toString(36)
  .slice(2, 7)}`;

console.log(`[smoke] project=${projectId} events=${eventsDataset}`);
console.log(`[smoke] run_id=${RUN_ID}`);

const analytics = new Analytics({
  transport: bqTransport({ projectId, eventsDataset, logsDataset }),
});

const userId = `smoke-user-${Math.random().toString(36).slice(2, 8)}`;

analytics.identify(userId, {
  email: `${userId}@example.com`,
  plan: "pro",
  run_id: RUN_ID,
});

analytics.feedback(
  {
    kind: "bug",
    subject: "Translate button does nothing on iOS 17",
    message:
      "After uploading a video, the Translate button is unresponsive. Force-quitting and reopening the app fixes it for one click then breaks again.",
    severity: "high",
    url: "/translate",
    properties: {
      app_version: "1.4.2",
      build_number: "147",
      platform: "ios",
      ota_update_id: "abc123",
      run_id: RUN_ID,
    },
  },
  { userId, sessionId: RUN_ID },
);

analytics.feedback(
  {
    kind: "request",
    subject: "Bulk-export translations as a single SRT",
    message: "Would love a way to export every translation in a project into one combined SRT.",
    properties: { app_version: "1.4.2", platform: "web", run_id: RUN_ID },
  },
  { userId, sessionId: RUN_ID },
);

analytics.feedback(
  {
    kind: "general",
    message: "Love the new onboarding — much clearer than before. 🙏",
    properties: { run_id: RUN_ID },
  },
  { userId, sessionId: RUN_ID },
);

// Anonymous feedback (no userId) — also valid
analytics.feedback({
  kind: "bug",
  message: "Page 404'd when I clicked the share link from twitter",
  url: "/share/abc123",
  properties: { referrer: "https://t.co/abc", run_id: RUN_ID },
});

await analytics.flush();

console.log(`[smoke] sent 4 feedback rows (1 bug, 1 request, 1 general, 1 anonymous bug)`);
console.log(`[smoke] verify with:`);
console.log(
  `  bq query --nouse_legacy_sql --format=prettyjson "SELECT kind, subject, message, user_id FROM \\\`${projectId}.${eventsDataset}.feedback\\\` WHERE JSON_VALUE(properties, '$.run_id') = '${RUN_ID}' ORDER BY ts"`,
);
