import { describe, expect, it, beforeAll } from "vitest";
import { Analytics, bqTransport, insertRows, getAccessToken } from "../../src/index.js";

const RUN = process.env.BQ_INTEGRATION === "1";
const PROJECT = process.env.BQ_INTEGRATION_PROJECT ?? process.env.GCP_PROJECT_ID;
const EVENTS_DATASET = process.env.BQ_INTEGRATION_EVENTS_DATASET ?? "bq_analytics_smoke_events";
const LOGS_DATASET = process.env.BQ_INTEGRATION_LOGS_DATASET ?? "bq_analytics_smoke_logs";

// Streaming-insert visibility lag in BQ is ~few seconds. Polling helper for
// view-merge tests so the assertion doesn't race the buffer flush.
async function pollForRow<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r !== null) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`pollForRow timed out after ${timeoutMs}ms`);
}

async function bqQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const token = await getAccessToken({
    scope: "https://www.googleapis.com/auth/bigquery",
  });
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: sql, useLegacySql: false }),
    },
  );
  if (!res.ok) throw new Error(`bqQuery ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    rows?: { f: { v: string }[] }[];
    schema: { fields: { name: string }[] };
  };
  if (!body.rows) return [];
  const fields = body.schema.fields.map((f) => f.name);
  return body.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    row.f.forEach((cell, i) => {
      obj[fields[i]!] = cell.v;
    });
    return obj as T;
  });
}

describe.skipIf(!RUN)("BigQuery integration (real)", () => {
  beforeAll(() => {
    if (!RUN) return;
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.VERCEL_OIDC_TOKEN) {
      // ADC fallback — assumes `gcloud auth application-default login` was run
      // and the project + datasets already exist (created by the smoke script).
    }
  });

  it("inserts a single event row directly via insertRows", async () => {
    await insertRows({ projectId: PROJECT }, EVENTS_DATASET, "raw", [
      {
        event_id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        event_name: "vitest.direct",
        user_id: "vitest-user",
        anonymous_id: null,
        session_id: null,
        properties: JSON.stringify({ from: "integration-test" }),
      },
    ]);
  });

  it("Analytics + bqTransport: track + identify + group + log roundtrip", async () => {
    const a = new Analytics({
      transport: bqTransport({
        projectId: PROJECT,
        eventsDataset: EVENTS_DATASET,
        logsDataset: LOGS_DATASET,
      }),
    });
    a.track("vitest.event", { foo: "bar", n: 42 }, { userId: "vitest-user" });
    a.identify("vitest-user", { plan: "pro", credits: 47 });
    a.group("household", "h-vitest", { size: 4 }, "vitest-user");
    a.log("info", "hello from vitest", { request_id: "vt" }, "vitest");
    await a.flush();
    expect(a.size()).toBe(0);
  });

  // Regression: groups_current must merge per key, not pick latest row
  // wholesale. Caught a bug where `analytics.group(t, id, {}, userId)`
  // (the "join an existing group" pattern: register membership without
  // updating traits) was wiping the household's display_name from the
  // view because the empty `{}` write was the latest row. Fixed in the
  // view DDL (per-key merge via JSON_KEYS + traits[k]); these tests
  // pin the behavior so the regression can't slip back in unnoticed.
  it("groups_current merges traits per-key; later partial writes don't clobber earlier keys", async () => {
    const a = new Analytics({
      transport: bqTransport({
        projectId: PROJECT,
        eventsDataset: EVENTS_DATASET,
        logsDataset: LOGS_DATASET,
      }),
    });
    const groupId = `h-merge-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    a.group("household", groupId, { display_name: "Originally Named", created_at: 1000 });
    a.group("household", groupId, { plan: "pro" }); // adds key, leaves others alone
    a.group("household", groupId, {}, "user-merge"); // membership-only, must NOT wipe traits
    await a.flush();

    const merged = await pollForRow(async () => {
      const rows = await bqQuery<{ traits: string }>(
        `SELECT TO_JSON_STRING(traits) AS traits FROM \`${PROJECT}.${EVENTS_DATASET}.groups_current\` WHERE group_id='${groupId}' AND group_type='household'`,
      );
      return rows[0] ?? null;
    });
    const traits = JSON.parse(merged.traits);
    expect(traits).toEqual({
      display_name: "Originally Named",
      created_at: 1000,
      plan: "pro",
    });
  });

  it("users merges traits per-key; later partial identify() writes don't clobber earlier keys", async () => {
    const a = new Analytics({
      transport: bqTransport({
        projectId: PROJECT,
        eventsDataset: EVENTS_DATASET,
        logsDataset: LOGS_DATASET,
      }),
    });
    const userId = `u-merge-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    a.identify(userId, { email: "alice@example.com", plan: "free" });
    a.identify(userId, { plan: "pro" }); // upgrades plan, must NOT wipe email
    a.identify(userId, {}); // empty write must NOT wipe anything
    await a.flush();

    const merged = await pollForRow(async () => {
      const rows = await bqQuery<{ traits: string }>(
        `SELECT TO_JSON_STRING(traits) AS traits FROM \`${PROJECT}.${EVENTS_DATASET}.users\` WHERE user_id='${userId}'`,
      );
      return rows[0] ?? null;
    });
    const traits = JSON.parse(merged.traits);
    expect(traits).toEqual({
      email: "alice@example.com",
      plan: "pro",
    });
  });

  it("groups_current preserves explicit null trait values (vs. erasing)", async () => {
    // If a caller wants to clear a trait, they pass `{plan: null}` — that
    // should record null as the latest value, not "unset". The view
    // surfaces JSON null. Distinguishes "no write happened" (key absent)
    // from "explicit clear" (key present, value null).
    const a = new Analytics({
      transport: bqTransport({
        projectId: PROJECT,
        eventsDataset: EVENTS_DATASET,
        logsDataset: LOGS_DATASET,
      }),
    });
    const groupId = `h-null-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    a.group("household", groupId, { display_name: "Temp", plan: "pro" });
    a.group("household", groupId, { plan: null });
    await a.flush();

    const merged = await pollForRow(async () => {
      const rows = await bqQuery<{ traits: string }>(
        `SELECT TO_JSON_STRING(traits) AS traits FROM \`${PROJECT}.${EVENTS_DATASET}.groups_current\` WHERE group_id='${groupId}' AND group_type='household'`,
      );
      return rows[0] ?? null;
    });
    const traits = JSON.parse(merged.traits);
    expect(traits).toEqual({
      display_name: "Temp",
      plan: null,
    });
  });
});
