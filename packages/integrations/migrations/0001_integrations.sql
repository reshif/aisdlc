-- Integration health (PLAN M10.4; DM §4.1 IntegrationHealth). The only runtime state of the registry:
-- the registry itself is config (`integrations.registry`, `integrations.installs`), published behind an
-- M1 gate. A row is the LAST report of one reporter (`codehost`, `gateway`) about one integration; it is
-- overwritten by each report, and a reader treats one older than two minutes as `unknown`
-- (contracts: `effectiveHealthState`). Not authoritative for anything: a rebuild is a fresh round of
-- reports.

CREATE SCHEMA integrations;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA integrations TO aisdlc_app;

CREATE TABLE integrations.integration_health (
  integration_id text        NOT NULL CHECK (integration_id ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  reporter       text        NOT NULL CHECK (reporter IN ('codehost', 'gateway')),
  state          text        NOT NULL CHECK (state IN ('ok', 'degraded', 'down', 'unknown')),
  detail_code    text        CHECK (detail_code ~ '^[a-z][a-z0-9_]{0,47}$'),
  as_of          timestamptz NOT NULL,
  PRIMARY KEY (integration_id, reporter)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.integration_health TO aisdlc_app;
