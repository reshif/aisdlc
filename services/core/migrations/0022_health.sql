-- HealthSnapshot (PLAN M19, DM §3.10 HealthTile / HealthSnapshot). The newest READING of each tile: a service's
-- `/healthz` or one loop of a loop host, taken by core-worker's `health_snapshot` loop every 30 s. Ephemeral by design,
-- like `integrations.integration_health`: a reading is not a fact, it is never in the record, the ledger or a decision,
-- and a lost row is read again within 30 s. Readers apply the HealthSnapshot rule (older than two minutes: `unknown`).

CREATE TABLE core.health_snapshot (
  tile_id     text             PRIMARY KEY CHECK (tile_id ~ '^(service|loop)\.[a-z][a-z0-9_.-]{0,95}$'),
  domain      text             NOT NULL CHECK (domain IN ('service', 'loop')),
  state       text             NOT NULL CHECK (state IN ('ok', 'degraded', 'down', 'unknown')),
  detail_code text             CHECK (detail_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  sli_value   double precision,
  reporter    text             NOT NULL CHECK (reporter ~ '^[a-z][a-z0-9-]{0,47}$'),
  as_of       timestamptz      NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.health_snapshot TO aisdlc_app;
