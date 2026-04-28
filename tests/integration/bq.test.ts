import { describe, expect, it, beforeAll } from "vitest";
import { Analytics, bqTransport, insertRows } from "../../src/index.js";

const RUN = process.env.BQ_INTEGRATION === "1";
const PROJECT = process.env.BQ_INTEGRATION_PROJECT ?? process.env.GCP_PROJECT_ID;
const EVENTS_DATASET = process.env.BQ_INTEGRATION_EVENTS_DATASET ?? "bq_analytics_smoke_events";
const LOGS_DATASET = process.env.BQ_INTEGRATION_LOGS_DATASET ?? "bq_analytics_smoke_logs";

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
});
