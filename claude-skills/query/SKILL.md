---
name: bq-analytics-query
description: Query bq-analytics data in BigQuery via the bq CLI. Use when the user asks for product analytics, conversion funnels, log searches, user trait lookups, or any "show me from the data" question on a project that has bq-analytics installed.
---

# Querying bq-analytics

## If `bq` isn't on PATH

The skill assumes the gcloud BigQuery CLI is callable as `bq`. On macOS with Homebrew (`brew install gcloud-cli`), the binaries land in `/opt/homebrew/share/google-cloud-sdk/bin/` and are **not symlinked into `/opt/homebrew/bin/`**, so non-interactive shells (the ones tools like Claude Code spawn) won't find them — even when an interactive `which bq` works.

If a `bq` invocation fails with `command not found`, run one of:

```sh
# Option A — make it visible to non-interactive shells (loaded before .zshrc):
echo 'export PATH="/opt/homebrew/share/google-cloud-sdk/bin:$PATH"' >> ~/.zshenv

# Option B — symlink directly into a dir that's already on the system PATH:
ln -s /opt/homebrew/share/google-cloud-sdk/bin/{bq,gcloud,gsutil} /opt/homebrew/bin/
```

The PATH entry that lives in `~/.zshrc` only helps interactive shells — `~/.zshenv` is the right file for tooling. After either fix, plain `bq query …` calls below work as written.

## Tables you can rely on

```
events.raw           — append-only events. Hot columns: event_name, user_id, ts.
                       JSON: properties (use JSON_VALUE for filtering).
events.identifies    — append-only user trait updates.
events.groups        — append-only group trait updates.
events.user_groups   — append-only user→group memberships.

events.users                  — view: latest traits per user_id.
events.groups_current         — view: latest traits per (group_type, group_id).
events.user_groups_current    — view: most-recent group per (user_id, group_type).

events.feedback      — append-only product feedback. Hot columns: kind, user_id, ts.
                       kind ∈ {"bug", "request", "general", ...custom}.
                       JSON: properties. Plain TEXT: subject, message.

logs.raw             — Vercel Log Drain landing zone + SDK log() calls.
                       Hot columns: ts, level, path, status, message.
                       JSON: fields (SDK-emitted only).
```

All event/log tables partition by `DATE(ts)`. **Always include a `WHERE DATE(ts) > ...` filter** unless you're querying a single recent ID — full-table scans are 10–100× slower and bill against the 1 TB/mo free quota.

## Schema discovery

```sh
bq show --schema --format=prettyjson <project>.<dataset>.<table>
bq ls <project>:<dataset>
```

## Run a query

```sh
bq query --nouse_legacy_sql --format=json --max_rows=100 'SELECT ...'
```

Pass long SQL via stdin to avoid shell-quoting headaches with `$`:

```sh
bq query --nouse_legacy_sql --format=json <<'SQL'
SELECT JSON_VALUE(properties, '$.video_id') AS vid, COUNT(*) AS n
FROM `proj.events.raw`
WHERE event_name = 'translation.completed'
  AND DATE(ts) > CURRENT_DATE() - 7
GROUP BY 1 ORDER BY n DESC LIMIT 10
SQL
```

## Common queries

### Event counts by name

```sql
SELECT event_name, COUNT(*) AS n
FROM `proj.events.raw`
WHERE DATE(ts) > CURRENT_DATE() - 7
GROUP BY 1 ORDER BY n DESC;
```

### Funnel — pageview → translation.started → translation.completed

```sql
WITH steps AS (
  SELECT user_id,
    MAX(IF(event_name = 'pageview', 1, 0)) AS s1,
    MAX(IF(event_name = 'translation.started', 1, 0)) AS s2,
    MAX(IF(event_name = 'translation.completed', 1, 0)) AS s3
  FROM `proj.events.raw`
  WHERE DATE(ts) > CURRENT_DATE() - 7
  GROUP BY user_id
)
SELECT SUM(s1) AS viewed, SUM(s2) AS started, SUM(s3) AS completed FROM steps;
```

### Pro yearly users (joining identifies view)

```sql
SELECT u.user_id, u.last_seen, JSON_VALUE(u.traits, '$.email') AS email
FROM `proj.events.users` u
WHERE JSON_VALUE(u.traits, '$.plan') = 'pro'
  AND JSON_VALUE(u.traits, '$.plan_period') = 'yearly';
```

### Translations per household

```sql
SELECT g.group_id, JSON_VALUE(g.traits, '$.size') AS size, COUNT(e.event_id) AS n
FROM `proj.events.user_groups_current` ug
JOIN `proj.events.groups_current` g
  ON g.group_type = ug.group_type AND g.group_id = ug.group_id
JOIN `proj.events.raw` e USING (user_id)
WHERE ug.group_type = 'household'
  AND e.event_name = 'translation.completed'
  AND DATE(e.ts) > CURRENT_DATE() - 30
GROUP BY 1, 2 ORDER BY n DESC;
```

### Recent bug reports with user context

```sql
SELECT f.ts, f.subject, f.message,
       JSON_VALUE(u.traits, '$.plan')        AS plan,
       JSON_VALUE(u.traits, '$.app_version') AS app_version,
       JSON_VALUE(f.properties, '$.platform') AS platform
FROM `proj.events.feedback` f
LEFT JOIN `proj.events.users` u USING (user_id)
WHERE f.kind = 'bug'
  AND DATE(f.ts) > CURRENT_DATE() - 7
ORDER BY f.ts DESC LIMIT 50;
```

### Investigation: feedback + last 30 min of user activity

The agent-investigation pattern. One query gives you the report + traits + the user's recent events leading up to it — no cross-system stitching.

```sql
WITH f AS (
  SELECT * FROM `proj.events.feedback`
  WHERE DATE(ts) > CURRENT_DATE() - 7
    AND kind = 'bug'
    AND user_id = 'u_alice'              -- or filter by feedback_id
)
SELECT
  f.feedback_id, f.ts AS reported_at, f.subject, f.message,
  JSON_VALUE(u.traits, '$.plan')        AS plan,
  JSON_VALUE(u.traits, '$.app_version') AS app_version,
  ARRAY(
    SELECT AS STRUCT e.event_name, e.ts, e.properties
    FROM `proj.events.raw` e
    WHERE e.user_id = f.user_id
      AND e.ts BETWEEN TIMESTAMP_SUB(f.ts, INTERVAL 30 MINUTE) AND f.ts
    ORDER BY e.ts DESC LIMIT 20
  ) AS recent_events
FROM f
LEFT JOIN `proj.events.users` u USING (user_id)
ORDER BY f.ts DESC;
```

### Feature requests grouped by theme (manual triage)

```sql
SELECT subject, message, ts, user_id,
       JSON_VALUE(properties, '$.app_version') AS app_version
FROM `proj.events.feedback`
WHERE kind = 'request'
  AND DATE(ts) > CURRENT_DATE() - 30
ORDER BY ts DESC;
```

For semantic clustering, dump the messages and feed them to the agent — BQ doesn't do similarity search natively at indie scale.

### Replace `vercel logs --query "beacon"`

```sql
SELECT ts, level, path, status, message
FROM `proj.logs.raw`
WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 MINUTE)
  AND CONTAINS_SUBSTR(message, 'beacon')
ORDER BY ts DESC LIMIT 50;
```

### 5xx rate by path, last hour

```sql
SELECT path,
       COUNTIF(status >= 500) AS errs,
       COUNT(*) AS total,
       SAFE_DIVIDE(COUNTIF(status >= 500), COUNT(*)) AS rate
FROM `proj.logs.raw`
WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND path IS NOT NULL
GROUP BY path ORDER BY errs DESC LIMIT 20;
```

### Pageviews from log drain (no client SDK needed)

```sql
SELECT path, COUNT(*) AS n
FROM `proj.logs.raw`
WHERE DATE(ts) > CURRENT_DATE() - 1
  AND status BETWEEN 200 AND 299
  AND path IS NOT NULL
  AND path NOT LIKE '/api/%'
  AND path NOT LIKE '/_next/%'
GROUP BY path ORDER BY n DESC LIMIT 50;
```

## When to fall back to `vercel-logs` instead

This skill assumes the project has bq-analytics installed and the Log Drain is feeding `logs.raw`. Some cases the drain doesn't cover — use the `vercel-logs` skill (CLI) for these:

- **Build logs** — drain captures only runtime stdout/stderr + request lines. Compile errors, install failures, framework warnings during build go through `vercel inspect <url> --logs` or `get_deployment_build_logs` MCP.
- **Live tail during a deploy** — drain has ~1–2 min batching lag. For "what's happening *right now*" use `vercel logs --follow`.
- **The first ~10 minutes after a fresh deployment** — drain delivery may not have caught up. Sanity-check with the CLI before assuming the data isn't there.
- **Project doesn't have bq-analytics installed yet** — `logs.raw` doesn't exist; everything goes via `vercel logs`.

## Performance tips

- **Always filter `WHERE DATE(ts) > ...`.** This restricts to specific date partitions. Forgetting it scans the full table.
- **Cluster columns**: `events.raw` clusters on `(event_name, user_id)`, `logs.raw` on `(level, status)`. Adding these to your `WHERE` is cheap.
- **JSON_VALUE for filtering, JSON_QUERY for nested access.** `JSON_VALUE` returns a STRING; cast with `CAST(... AS INT64)` etc. for numeric comparisons.
- **Cost guardrails**: BigQuery on-demand bills $5/TB after 1 TB free. A typical query at indie scale scans <100 MB and is free.

## When to add a dedicated column

If a JSON field shows up in `WHERE` clauses constantly (e.g. `properties.user_plan`, `traits.country`), promote it to a real column:

```sql
ALTER TABLE `proj.events.raw` ADD COLUMN user_plan STRING;
-- Then update the SDK to write it both as a column and in properties (for back-compat).
```

You won't need this until volume climbs into 100M+ events/mo or queries get slow.

## Anti-patterns to avoid

- **Don't UPDATE/DELETE rows in `events.raw`.** Streaming-inserted rows can't be modified for ~90 minutes anyway. The append-only design is on purpose; use `event_id` for dedup if needed.
- **Don't query without `DATE(ts)` filter** unless the partition pruning is intentional.
- **Don't dual-write events to PostHog "for safety".** That's the cost trap this whole architecture exists to avoid.

## If a query is unexpectedly empty

1. Streaming inserts have ~few-second visibility lag. Wait and retry.
2. Vercel Log Drain has ~5–30s delivery batching. Wait longer for log queries.
3. Check the `event_id` exists in `events.raw` directly with a `LIMIT 1` lookup — if missing, the SDK call probably failed. `bq-analytics` returns 5xx on insert failure; check the function logs.
4. Verify the dataset name matches `BQ_EVENTS_DATASET` / `BQ_LOGS_DATASET` env vars (defaults `events` / `logs`).
