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

-- Materialized "current state" views

CREATE OR REPLACE VIEW `@@EVENTS_DATASET@@.users` AS
SELECT user_id,
  ARRAY_AGG(traits ORDER BY ts DESC LIMIT 1)[OFFSET(0)] AS traits,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM `@@EVENTS_DATASET@@.identifies`
GROUP BY user_id;

CREATE OR REPLACE VIEW `@@EVENTS_DATASET@@.groups_current` AS
SELECT group_type, group_id,
  ARRAY_AGG(traits ORDER BY ts DESC LIMIT 1)[OFFSET(0)] AS traits,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM `@@EVENTS_DATASET@@.groups`
GROUP BY group_type, group_id;

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
