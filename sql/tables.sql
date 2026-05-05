-- bq-analytics schema
-- Run once per project. Idempotent (CREATE IF NOT EXISTS).
-- Substitute @@EVENTS_DATASET@@ and @@LOGS_DATASET@@ with your dataset names
-- (defaults: "events" and "logs"). The setup script does this for you.

-- ====== events.* ============================================================

CREATE TABLE IF NOT EXISTS `@@EVENTS_DATASET@@.raw` (
  event_id     STRING NOT NULL,
  ts           TIMESTAMP NOT NULL,
  event_name   STRING NOT NULL,
  user_id      STRING,
  anonymous_id STRING,
  session_id   STRING,
  properties   JSON
)
PARTITION BY DATE(ts)
CLUSTER BY event_name, user_id
OPTIONS(description="Append-only product events. event_id is uuidv4 for dedup.");

CREATE TABLE IF NOT EXISTS `@@EVENTS_DATASET@@.identifies` (
  ts      TIMESTAMP NOT NULL,
  user_id STRING NOT NULL,
  traits  JSON
)
PARTITION BY DATE(ts)
CLUSTER BY user_id
OPTIONS(description="Append-only user trait updates. Latest row per user_id wins.");

CREATE TABLE IF NOT EXISTS `@@EVENTS_DATASET@@.groups` (
  ts         TIMESTAMP NOT NULL,
  group_type STRING NOT NULL,
  group_id   STRING NOT NULL,
  traits     JSON
)
PARTITION BY DATE(ts)
CLUSTER BY group_type, group_id
OPTIONS(description="Append-only group trait updates (org/household/team/etc).");

CREATE TABLE IF NOT EXISTS `@@EVENTS_DATASET@@.user_groups` (
  ts         TIMESTAMP NOT NULL,
  user_id    STRING NOT NULL,
  group_type STRING NOT NULL,
  group_id   STRING NOT NULL
)
PARTITION BY DATE(ts)
CLUSTER BY user_id
OPTIONS(description="User → group membership log. Latest row per (user_id, group_type) wins.");

CREATE TABLE IF NOT EXISTS `@@EVENTS_DATASET@@.feedback` (
  feedback_id  STRING NOT NULL,
  ts           TIMESTAMP NOT NULL,
  kind         STRING NOT NULL,
  subject      STRING,
  message      STRING NOT NULL,
  severity     STRING,
  url          STRING,
  user_id      STRING,
  anonymous_id STRING,
  session_id   STRING,
  properties   JSON
)
PARTITION BY DATE(ts)
CLUSTER BY kind, user_id
OPTIONS(description="Product feedback intake — bug reports, feature requests, general feedback. Joinable with events.users / events.raw on user_id for full context.");

-- Materialized "current state" views.
--
-- Trait merge semantics: latest-write-wins **per key**, not per row.
-- A partial write like `identify(u, {plan: "pro"})` does not clobber
-- previously-set keys (e.g. `email`); only the keys present in the new
-- write are updated. An empty `{}` write contributes nothing — it does
-- not erase existing traits. This matches Segment/PostHog/Mixpanel and
-- the typical caller mental model: SDKs that overload `group()` /
-- `identify()` for membership and trait writes (where membership is
-- the only intent) should not silently wipe traits.
--
-- Implementation: explode each row's top-level JSON keys, take the
-- latest value per key, rebuild the JSON object. Groups/users with
-- only empty `{}` writes still appear with `traits = {}`.

-- BQ JSON path arguments must be constants, so per-key extraction uses
-- subscript syntax (`traits[k]`) which permits a runtime key. The
-- merged JSON is rebuilt with STRING_AGG + SAFE.PARSE_JSON so per-key
-- value JSON (including null/numeric/string/object) round-trips
-- losslessly.

CREATE OR REPLACE VIEW `@@EVENTS_DATASET@@.users` AS
WITH expanded AS (
  SELECT user_id, k AS key, traits[k] AS value_json, ts
  FROM `@@EVENTS_DATASET@@.identifies`,
  UNNEST(JSON_KEYS(traits, 1)) AS k
),
latest_per_key AS (
  SELECT user_id, key,
         ARRAY_AGG(value_json ORDER BY ts DESC LIMIT 1)[OFFSET(0)] AS value_json
  FROM expanded
  GROUP BY user_id, key
),
merged AS (
  SELECT user_id,
         SAFE.PARSE_JSON(
           '{' || STRING_AGG(CONCAT(TO_JSON_STRING(key), ':', TO_JSON_STRING(value_json)), ',') || '}'
         ) AS traits
  FROM latest_per_key
  GROUP BY user_id
),
ts_summary AS (
  SELECT user_id, MIN(ts) AS first_seen, MAX(ts) AS last_seen
  FROM `@@EVENTS_DATASET@@.identifies`
  GROUP BY user_id
)
SELECT ts.user_id,
       COALESCE(m.traits, JSON '{}') AS traits,
       ts.first_seen,
       ts.last_seen
FROM ts_summary ts
LEFT JOIN merged m USING (user_id);

CREATE OR REPLACE VIEW `@@EVENTS_DATASET@@.groups_current` AS
WITH expanded AS (
  SELECT group_type, group_id, k AS key, traits[k] AS value_json, ts
  FROM `@@EVENTS_DATASET@@.groups`,
  UNNEST(JSON_KEYS(traits, 1)) AS k
),
latest_per_key AS (
  SELECT group_type, group_id, key,
         ARRAY_AGG(value_json ORDER BY ts DESC LIMIT 1)[OFFSET(0)] AS value_json
  FROM expanded
  GROUP BY group_type, group_id, key
),
merged AS (
  SELECT group_type, group_id,
         SAFE.PARSE_JSON(
           '{' || STRING_AGG(CONCAT(TO_JSON_STRING(key), ':', TO_JSON_STRING(value_json)), ',') || '}'
         ) AS traits
  FROM latest_per_key
  GROUP BY group_type, group_id
),
ts_summary AS (
  SELECT group_type, group_id, MIN(ts) AS first_seen, MAX(ts) AS last_seen
  FROM `@@EVENTS_DATASET@@.groups`
  GROUP BY group_type, group_id
)
SELECT ts.group_type, ts.group_id,
       COALESCE(m.traits, JSON '{}') AS traits,
       ts.first_seen,
       ts.last_seen
FROM ts_summary ts
LEFT JOIN merged m USING (group_type, group_id);

CREATE OR REPLACE VIEW `@@EVENTS_DATASET@@.user_groups_current` AS
SELECT user_id, group_type,
  ARRAY_AGG(group_id ORDER BY ts DESC LIMIT 1)[OFFSET(0)] AS group_id,
  MAX(ts) AS last_assigned_at
FROM `@@EVENTS_DATASET@@.user_groups`
GROUP BY user_id, group_type;

-- ====== logs.* ==============================================================

CREATE TABLE IF NOT EXISTS `@@LOGS_DATASET@@.raw` (
  ts            TIMESTAMP NOT NULL,
  level         STRING,
  source        STRING,
  message       STRING,
  fields        JSON,
  request_id    STRING,
  deployment_id STRING,
  path          STRING,
  status        INT64,
  region        STRING,
  raw           STRING
)
PARTITION BY DATE(ts)
CLUSTER BY level, status
OPTIONS(description="Logs landing zone. Receives both SDK log() calls (uses fields) and Vercel Log Drain lines (uses request_id/path/status/raw).");
