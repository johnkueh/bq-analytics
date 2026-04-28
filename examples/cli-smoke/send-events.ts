#!/usr/bin/env tsx
/**
 * CLI smoke: send a representative mix of events directly to BigQuery,
 * then print the run id so you can query them back.
 *
 * Auth: uses Application Default Credentials.
 *   gcloud auth application-default login
 *
 * Usage:
 *   pnpm smoke
 *   GCP_PROJECT_ID=foo BQ_EVENTS_DATASET=bar pnpm smoke
 */
import { Analytics, bqTransport } from "../../src/index.js";

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) {
  console.error("GCP_PROJECT_ID is required");
  process.exit(1);
}
const eventsDataset = process.env.BQ_EVENTS_DATASET ?? "bq_analytics_smoke_events";
const logsDataset = process.env.BQ_LOGS_DATASET ?? "bq_analytics_smoke_logs";

const RUN_ID = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
  .toString(36)
  .slice(2, 7)}`;

console.log(`[smoke] project=${projectId} events=${eventsDataset} logs=${logsDataset}`);
console.log(`[smoke] run_id=${RUN_ID}`);

const analytics = new Analytics({
  transport: bqTransport({ projectId, eventsDataset, logsDataset }),
});

const userId = `smoke-user-${Math.random().toString(36).slice(2, 8)}`;
const householdId = `smoke-household-${Math.random().toString(36).slice(2, 8)}`;

// 1. identify
analytics.identify(userId, {
  email: `${userId}@example.com`,
  plan: "pro",
  plan_period: "yearly",
  signup_country: "AU",
  is_pro: true,
  credits_remaining: 47,
  run_id: RUN_ID,
});

// 2. group + user_group
analytics.group(
  "household",
  householdId,
  {
    size: 4,
    primary_language: "en",
    invited_count: 2,
    features: ["shared_recipes", "shared_calendar"],
    run_id: RUN_ID,
  },
  userId,
);

// 3. track — multiple events with varied shapes
const events = [
  ["pageview", { path: "/", referrer: null, run_id: RUN_ID }],
  ["pageview", { path: "/pricing", referrer: "/", run_id: RUN_ID }],
  ["translation.started", { video_id: "dQw4w9WgXcQ", source_lang: "en", target_lang: "ja", run_id: RUN_ID }],
  ["translation.completed", { video_id: "dQw4w9WgXcQ", duration_ms: 12_345, segments: 84, run_id: RUN_ID }],
  ["checkout.started", { plan: "pro", period: "yearly", price_cents: 5990, run_id: RUN_ID }],
] as const;

for (const [name, props] of events) {
  analytics.track(name, props, { userId, sessionId: RUN_ID });
}

// 4. log
analytics.log("info", "smoke run complete", { events: events.length, run_id: RUN_ID }, "smoke-cli");

await analytics.flush();

console.log(`[smoke] sent ${events.length} events + 1 identify + 1 group + 1 log`);
console.log(`[smoke] verify with:`);
console.log(`        pnpm smoke:query ${RUN_ID}`);
