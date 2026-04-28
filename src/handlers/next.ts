import type { BqTransportConfig } from "../index.js";
import { bqTransport } from "../index.js";
import type { BufferedRecord } from "../types.js";

export interface TrackRouteOptions extends BqTransportConfig {
  /**
   * Resolves the authenticated userId for a request. Return null for anonymous.
   * If omitted, requests are accepted as-is (use only for trusted internal callers).
   */
  resolveUser?: (req: Request) => Promise<string | null> | string | null;
  /**
   * Optional API key check for CLI / external callers. If `apiKey` is set,
   * any request with header `x-api-key: <apiKey>` bypasses resolveUser and is
   * treated as authenticated for whatever userId the body specifies.
   */
  apiKey?: string;
  /**
   * Per-request hook to attach extra fields (e.g. ip, ua) to every record.
   */
  enrich?: (req: Request, record: BufferedRecord) => BufferedRecord;
  /**
   * If a record has no userId/anonymousId, drop it. Default false.
   */
  rejectAnonymous?: boolean;
  /**
   * If provided, the BQ insert runs in the background after the response is
   * sent — clients get a fast 200 (~5–15 ms) instead of waiting for the BQ
   * round-trip (~50–150 ms). On Fluid Compute the function instance is kept
   * alive until the promise resolves.
   *
   * **Strongly recommended** for browser / RN / public-facing clients —
   * removes BQ latency from the user-visible response time.
   *
   * Without `waitUntil` the handler blocks until BQ confirms and returns 502
   * on failure. Browser/RN client SDKs already retry on network failure via
   * localStorage/AsyncStorage, so the 5xx feedback isn't load-bearing.
   *
   * Next.js 15+ App Router:
   *   import { after } from "next/server";
   *   export const POST = createTrackRoute({ ..., waitUntil: (p) => after(() => p) });
   *
   * Vercel @vercel/functions:
   *   import { waitUntil } from "@vercel/functions";
   *   export const POST = createTrackRoute({ ..., waitUntil });
   *
   * Cloudflare Workers / Hono on edge:
   *   c.executionCtx.waitUntil(p)
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Next.js App Router POST handler factory for /api/track.
 *
 * Accepts JSON body: { records: BufferedRecord[] }
 *
 * Response shape depends on `waitUntil`:
 * - With `waitUntil`: returns 200 immediately, BQ insert runs in background.
 *   Insert errors are logged via `console.error` (which the Log Drain
 *   captures into logs.raw if installed).
 * - Without `waitUntil`: blocks until BQ confirms; returns 502 on failure.
 */
export function createTrackRoute(opts: TrackRouteOptions) {
  const transport = bqTransport(opts);

  return async function POST(req: Request): Promise<Response> {
    if (opts.apiKey && req.headers.get("x-api-key") === opts.apiKey) {
      // pass — api key bypass is enough auth
    } else if (opts.resolveUser) {
      try {
        await opts.resolveUser(req);
      } catch (err) {
        return json({ error: "auth failed", detail: (err as Error).message }, 401);
      }
    }

    let body: { records?: BufferedRecord[] };
    try {
      body = (await req.json()) as { records?: BufferedRecord[] };
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length === 0) return json({ ok: true, accepted: 0 });

    const cleaned: BufferedRecord[] = [];
    for (const r of records) {
      if (!validateRecord(r)) continue;
      const enriched = opts.enrich ? opts.enrich(req, r) : r;
      if (opts.rejectAnonymous && hasNoOwner(enriched)) continue;
      cleaned.push(enriched);
    }

    if (cleaned.length === 0) return json({ ok: true, accepted: 0 });

    if (opts.waitUntil) {
      // Fast path: dispatch BQ insert in background, return 200 immediately.
      opts.waitUntil(
        transport.send(cleaned).catch((err) => {
          // Don't throw — caller already got 200. Log so the failure is
          // captured by the drain pipeline (logs.raw) for diagnosis.
          console.error("[bq-analytics] /api/track insert failed:", err);
        }),
      );
      return json({ ok: true, accepted: cleaned.length });
    }

    // Blocking path: await BQ confirm, surface 502 on failure so client
    // SDK retry queues kick in.
    try {
      await transport.send(cleaned);
    } catch (err) {
      return json({ error: "insert failed", detail: (err as Error).message }, 502);
    }

    return json({ ok: true, accepted: cleaned.length });
  };
}

export interface LogDrainRouteOptions {
  projectId: string;
  logsDataset?: string;
  /** Shared secret expected on `x-drain-secret` header. */
  secret: string;
}

/**
 * Next.js App Router handler factory for Vercel Log Drain receiver.
 * Returns `{ POST, GET }` — both must be exported from your route file:
 *
 * ```ts
 * export const { POST, GET } = createLogDrainRoute({
 *   projectId, secret: process.env.LOG_DRAIN_SECRET!,
 * });
 * ```
 *
 * - `POST` accepts NDJSON drain batches and writes them into <logsDataset>.raw.
 * - `GET` echoes back `x-vercel-verify` so Vercel's drain-creation endpoint
 *   validation succeeds. Without this, drain creation fails with
 *   "Cannot validate endpoint url" / missing x-vercel-verify header.
 *
 * **POST is intentionally blocking** — it awaits the BQ insert and returns
 * 502 on failure. This is by design: Vercel's Log Drain delivers at-least-
 * once by retrying on 5xx, so blocking + 502 preserves durability. Returning
 * 200 in the background would turn drain into at-most-once. BQ insert
 * latency (~50–150ms) is well within Vercel's drain delivery timeout.
 *
 * IMPORTANT: never call console.log inside POST — drained log lines are
 * themselves drained, creating an infinite loop.
 */
export function createLogDrainRoute(opts: LogDrainRouteOptions) {
  const dataset = opts.logsDataset ?? "logs";

  async function POST(req: Request): Promise<Response> {
    if (req.headers.get("x-drain-secret") !== opts.secret) {
      return json({ error: "forbidden" }, 403);
    }

    const text = await req.text();
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return json({ ok: true, accepted: 0 });

    const rows = lines.map((line) => parseDrainLine(line));

    try {
      const { insertRows } = await import("../insert.js");
      await insertRows({ projectId: opts.projectId }, dataset, "raw", rows);
    } catch (err) {
      return json({ error: "insert failed", detail: (err as Error).message }, 502);
    }
    return json({ ok: true, accepted: rows.length });
  }

  function GET(req: Request): Response {
    // Vercel's drain validation calls GET with `x-vercel-verify: <token>`
    // and expects the same value echoed back in the response header.
    const verify = req.headers.get("x-vercel-verify") ?? "";
    return new Response(null, {
      status: 200,
      headers: { "x-vercel-verify": verify },
    });
  }

  return { POST, GET };
}

export function parseDrainLine(line: string): Record<string, unknown> {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return {
      ts: new Date().toISOString(),
      level: "info",
      source: "external",
      message: line.slice(0, 8000),
      request_id: null,
      deployment_id: null,
      path: null,
      status: null,
      region: null,
      raw: line,
    };
  }
  return {
    ts: new Date(e.timestamp ?? Date.now()).toISOString(),
    level: normalizeLevel(e.level ?? "info"),
    source: e.source ?? e.type ?? "lambda",
    message: typeof e.message === "string" ? e.message.slice(0, 8000) : JSON.stringify(e.message ?? "").slice(0, 8000),
    request_id: e.requestId ?? null,
    deployment_id: e.deploymentId ?? null,
    path: e.proxy?.path ?? null,
    status: e.proxy?.statusCode ?? null,
    region: e.proxy?.region ?? null,
    raw: JSON.stringify(e).slice(0, 16000),
  };
}

function normalizeLevel(l: string): string {
  const v = l.toLowerCase();
  if (v === "warning") return "warn";
  if (v === "fatal") return "error";
  if (["debug", "info", "warn", "error"].includes(v)) return v;
  return "info";
}

function validateRecord(r: any): r is BufferedRecord {
  if (!r || typeof r !== "object") return false;
  if (!["event", "identify", "group", "user_group", "log"].includes(r.kind)) return false;
  if (!r.row || typeof r.row !== "object") return false;
  return true;
}

function hasNoOwner(r: BufferedRecord): boolean {
  if (r.kind !== "event") return false;
  return !r.row.user_id && !r.row.anonymous_id;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
