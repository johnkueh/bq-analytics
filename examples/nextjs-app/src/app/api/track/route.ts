import { createTrackRoute } from "bq-analytics/next";
import { after } from "next/server";

/**
 * POST /api/track
 *
 * Accepts a JSON body { records: BufferedRecord[] } from any client SDK
 * (browser, React Native, CLI). Inserts directly into BigQuery.
 *
 * Non-blocking: BQ insert runs in `after()`, the client gets a fast 200
 * (~5-15ms) instead of waiting for BQ (~50-150ms). Browser/RN client SDKs
 * have their own retry queues so the lack of 5xx feedback is fine.
 *
 * Replace resolveUser() with your auth lookup. Common patterns:
 *   - Clerk:    const { userId } = await auth(); return userId;
 *   - NextAuth: const session = await getServerSession(); return session?.user?.id;
 *   - Custom:   inspect cookies / headers / DB
 */
export const POST = createTrackRoute({
  projectId: process.env.GCP_PROJECT_ID,
  eventsDataset: process.env.BQ_EVENTS_DATASET ?? "events",
  logsDataset: process.env.BQ_LOGS_DATASET ?? "logs",
  apiKey: process.env.ANALYTICS_API_KEY,
  waitUntil: (p) => after(() => p),
  resolveUser: async (_req) => {
    // TODO: replace with real auth lookup. Returning null = anonymous.
    return null;
  },
  enrich: (req, record) => {
    if (record.kind !== "event") return record;
    const props = JSON.parse(record.row.properties || "{}") as Record<string, unknown>;
    props.ip ??= req.headers.get("x-forwarded-for") ?? null;
    props.ua ??= req.headers.get("user-agent") ?? null;
    return { ...record, row: { ...record.row, properties: JSON.stringify(props) } };
  },
});
