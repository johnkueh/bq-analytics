import { createFlagsRoute } from "bq-analytics/next/flags";
import { flagSource } from "@/lib/flags";

/**
 * GET /api/flags
 *
 * Public flag fetch for browser / RN clients. Strips `users[]` allowlists
 * before returning so they never leak to the caller. Server-side code
 * should consume `flags()` directly — no extra HTTP hop.
 */
export const GET = createFlagsRoute({
  source: flagSource,
  cacheControl: "no-store",
  filter: (map) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, { ...v, users: undefined }]),
    ),
});
