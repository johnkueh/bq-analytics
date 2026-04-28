# nextjs-app example

Reference Next.js 16 App Router setup using bq-analytics. Wires up:

- `POST /api/track` — accepts SDK calls from browser/RN/CLI
- `POST /api/internal/log-drain` — receives Vercel Log Drain NDJSON batches
- `lib/analytics.ts` — server-side `track`/`identify`/`group`/`log` helper

## Run locally (against real BigQuery)

1. `pnpm install` at repo root.
2. Copy `.env.example` to `.env.local` and fill in `GCP_PROJECT_ID`, dataset names, `LOG_DRAIN_SECRET`.
3. `gcloud auth application-default login` (one-time).
4. `pnpm dev`.

The route handlers use `BQA_ACCESS_TOKEN` if set (handy for token piping during smoke tests), otherwise fall back through Vercel OIDC (via `@vercel/functions/oidc` or `VERCEL_OIDC_TOKEN` env) → service-account JSON → ADC.

## Wire into a real Next.js project

Drop `src/lib/analytics.ts` and the two `app/api/.../route.ts` files into your own project. They depend only on `bq-analytics` (server entry) and Next 14+.

The Vercel side (env vars + Log Drain) is provisioned by `scripts/setup-bq-oidc.sh` at the repo root.
