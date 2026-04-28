#!/usr/bin/env tsx
/**
 * CLI smoke verifier: queries BigQuery for rows tagged with the given run_id
 * and prints per-table counts + sample rows.
 *
 * Usage:
 *   pnpm smoke:query <RUN_ID>
 */
import { spawnSync } from "node:child_process";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: pnpm smoke:query <RUN_ID>");
  process.exit(1);
}

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) {
  console.error("GCP_PROJECT_ID is required");
  process.exit(1);
}
const eventsDataset = process.env.BQ_EVENTS_DATASET ?? "bq_analytics_smoke_events";
const logsDataset = process.env.BQ_LOGS_DATASET ?? "bq_analytics_smoke_logs";

const queries: Array<{ label: string; sql: string }> = [
  {
    label: "events.raw",
    sql: `SELECT event_name, ts, user_id, JSON_VALUE(properties, '$.run_id') AS run_id
          FROM \`${projectId}.${eventsDataset}.raw\`
          WHERE JSON_VALUE(properties, '$.run_id') = '${runId}'
          ORDER BY ts`,
  },
  {
    label: "events.identifies",
    sql: `SELECT ts, user_id,
                 JSON_VALUE(traits, '$.plan') AS plan,
                 JSON_VALUE(traits, '$.run_id') AS run_id
          FROM \`${projectId}.${eventsDataset}.identifies\`
          WHERE JSON_VALUE(traits, '$.run_id') = '${runId}'
          ORDER BY ts`,
  },
  {
    label: "events.groups",
    sql: `SELECT ts, group_type, group_id,
                 JSON_VALUE(traits, '$.size') AS size
          FROM \`${projectId}.${eventsDataset}.groups\`
          WHERE JSON_VALUE(traits, '$.run_id') = '${runId}'
          ORDER BY ts`,
  },
  {
    label: "events.user_groups (this run only — anchor on user from identifies)",
    sql: `SELECT ug.ts, ug.user_id, ug.group_type, ug.group_id
          FROM \`${projectId}.${eventsDataset}.user_groups\` ug
          JOIN \`${projectId}.${eventsDataset}.identifies\` id USING (user_id)
          WHERE JSON_VALUE(id.traits, '$.run_id') = '${runId}'`,
  },
  {
    label: "logs.raw",
    sql: `SELECT ts, level, source, message,
                 JSON_VALUE(fields, '$.run_id') AS run_id
          FROM \`${projectId}.${logsDataset}.raw\`
          WHERE JSON_VALUE(fields, '$.run_id') = '${runId}'
          ORDER BY ts DESC`,
  },
];

let allOk = true;
for (const { label, sql } of queries) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(
    "bq",
    [
      `--project_id=${projectId}`,
      "query",
      "--use_legacy_sql=false",
      "--format=pretty",
      "--max_rows=50",
    ],
    { input: sql, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (res.status === 0) {
    process.stdout.write(res.stdout);
  } else {
    allOk = false;
    console.error(`  query failed (exit ${res.status})`);
    if (res.stderr) console.error(res.stderr);
  }
}

if (!allOk) process.exit(1);
