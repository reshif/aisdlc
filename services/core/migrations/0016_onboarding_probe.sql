-- Core: the onboarding probe (PLAN M16; OB §3.2 LF3, §5.6; ADR-0003 §7 K-exec; DEC-17 refined, DEC-18).
--
-- READ MODEL. The authority is the record: `probe.granted` (written BEFORE a session is asked for: the grant the
-- sandbox-controller checks) and `probe.recorded` (the result, record-first) on the stream `probe:<s0_id>`. core folds
-- each event into this row as it writes it and can rebuild it from the events alone (`rebuildProbes`).
--
-- The sandbox-controller reads the grant through the view `core.probe_grant` (the id, the S0 record, the status and
-- when it was granted; never the result) and starts a K-exec session only while the row is `granted` and young.

CREATE TABLE core.onboarding_probe (
  probe_id      text        PRIMARY KEY CHECK (probe_id ~ '^probe-[0-9a-f]{32}$'),
  s0_id         uuid        NOT NULL,
  project_id    text        NOT NULL,
  repo          text        NOT NULL,
  census_hash   text        NOT NULL CHECK (census_hash ~ '^[0-9a-f]{64}$'),
  baseline_sha  text        NOT NULL CHECK (baseline_sha ~ '^[0-9a-f]{40}$'),
  image         text,
  status        text        NOT NULL CHECK (status IN ('granted', 'recorded')),
  outcome       text,
  result        jsonb,
  result_hash   text        CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  granted_at    timestamptz,
  recorded_at   timestamptz,
  -- the global_seq of the last event folded in: the order probes happened in
  event_gseq    bigint      NOT NULL,
  CHECK ((status = 'recorded') = (result IS NOT NULL AND outcome IS NOT NULL AND result_hash IS NOT NULL))
);
CREATE INDEX onboarding_probe_s0_idx ON core.onboarding_probe (s0_id, event_gseq);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.onboarding_probe TO aisdlc_app;

CREATE VIEW core.probe_grant AS
  SELECT probe_id, s0_id, status, granted_at FROM core.onboarding_probe WHERE granted_at IS NOT NULL;

DO $$
BEGIN
  CREATE ROLE aisdlc_sandbox_controller NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT SELECT ON core.probe_grant TO aisdlc_sandbox_controller;
