-- gate-relay (PLAN M15.3; docs/specs/gate-relay-api.md): the releases it made for approved G5s, as read models of the
-- `gaterelay.*` events on the `gaterelay:<item>` record streams. Rebuildable from the record alone (`rebuildGateRelay`):
-- each event carries the whole intent, refusal, marker or health verdict. Every table is append-only: a row is folded
-- from one event, once, and never changes (a later fact is a later row).
--
-- Least privilege. gate-relay is in the gate plane (AR9): no route to core's write or command APIs and no core HTTP
-- API at all; it reads the record, the ledger and two read models directly, as the login role `gate_relay` (db-init), a
-- member of the NOLOGIN group role below, which can do exactly this:
--
--   gaterelay.intent, gaterelay.refusal,   SELECT and INSERT (an event is folded once; never UPDATE or DELETE)
--   gaterelay.deploy_marker,
--   gaterelay.deploy_health
--   record.record_event                    SELECT and INSERT of `gaterelay:%` streams, SELECT of `gate:%` streams (the
--                                          G5 instance: `gate.opened` with its binding), by row-level security; never
--                                          UPDATE or DELETE
--   record.global_counter                  SELECT and UPDATE: every append locks this one row and moves it forward
--   ledger.ledger_entry                    SELECT: G5's status is a fold of ledger decisions, never of a projection
--   config.genuine_publish                 SELECT: the published release setting (`project.release`)
--   core.evidence_pack                     SELECT: where the signed pack of the bound head is (its bytes are verified
--                                          here, with the Notary's public key: core's word that it passed is not taken)
--   gatecheck.merge                        SELECT: gate-check's record that the merged commit is the gated merge of
--                                          the pack's head (the gate plane's own observation of the code host)
--
-- and nothing else: no item stream, no identity, knowledge, decisions or inbox table, no DDL.

CREATE SCHEMA IF NOT EXISTS gaterelay;

-- Record-first: an approved G5 (or an unhealthy release's rollback) is being deployed; written before the host is asked.
CREATE TABLE gaterelay.intent (
  marker_id         uuid        PRIMARY KEY,
  gate_instance_id  uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('release', 'rollback')),
  item_id           uuid        NOT NULL,
  repo_key          text        NOT NULL,
  environment       text        NOT NULL,
  merged_sha        text        NOT NULL CHECK (merged_sha ~ '^[0-9a-f]{40}$'),
  event_gseq        bigint      NOT NULL,
  UNIQUE (gate_instance_id, kind)
);

-- An approved G5 that will not be released, and why (final for that instance: a re-request is a new G5).
CREATE TABLE gaterelay.refusal (
  gate_instance_id  uuid        PRIMARY KEY,
  item_id           uuid        NOT NULL,
  project_id        text        NOT NULL,
  reason            text        NOT NULL,
  detail            text        NOT NULL,
  event_gseq        bigint      NOT NULL,
  refused_at        timestamptz NOT NULL
);
CREATE INDEX refusal_item_idx ON gaterelay.refusal (item_id);

-- The DeployMarker (DM §3.6): one deployment gate-relay created. One per G5 instance and kind: exactly once.
CREATE TABLE gaterelay.deploy_marker (
  marker_id         uuid        PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('release', 'rollback')),
  gate_instance_id  uuid        NOT NULL,
  item_id           uuid        NOT NULL,
  project_id        text        NOT NULL,
  repo_key          text        NOT NULL,
  environment       text        NOT NULL,
  merged_sha        text        NOT NULL CHECK (merged_sha ~ '^[0-9a-f]{40}$'),
  pack_sha256       text        NOT NULL CHECK (pack_sha256 ~ '^[0-9a-f]{64}$'),
  deployment_id     bigint      NOT NULL,
  rollback_of       uuid,
  payload           jsonb       NOT NULL,
  event_gseq        bigint      NOT NULL,
  created_at        timestamptz NOT NULL,
  UNIQUE (gate_instance_id, kind)
);
CREATE INDEX deploy_marker_target_idx ON gaterelay.deploy_marker (repo_key, environment, event_gseq);
CREATE INDEX deploy_marker_item_idx ON gaterelay.deploy_marker (item_id);

-- The first verdict on a deployment: healthy (its newest status is success) or unhealthy (failure, error).
CREATE TABLE gaterelay.deploy_health (
  marker_id           uuid        PRIMARY KEY REFERENCES gaterelay.deploy_marker (marker_id),
  health              text        NOT NULL CHECK (health IN ('healthy', 'unhealthy')),
  state               text        NOT NULL,
  rollback_marker_id  uuid,
  event_gseq          bigint      NOT NULL,
  observed_at         timestamptz NOT NULL
);

DO $$
BEGIN
  CREATE ROLE aisdlc_gaterelay NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA gaterelay, record, ledger, config, core, gatecheck TO aisdlc_gaterelay;
GRANT SELECT, INSERT ON gaterelay.intent, gaterelay.refusal, gaterelay.deploy_marker, gaterelay.deploy_health
  TO aisdlc_gaterelay;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_gaterelay;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_gaterelay;
GRANT SELECT ON ledger.ledger_entry TO aisdlc_gaterelay;
GRANT SELECT ON config.genuine_publish TO aisdlc_gaterelay;
GRANT SELECT ON core.evidence_pack TO aisdlc_gaterelay;
GRANT SELECT ON gatecheck.merge TO aisdlc_gaterelay;

-- The record's row-level security (enabled by the gateway migration, which runs before this one in the plan).
CREATE POLICY record_event_gaterelay_read ON record.record_event
  FOR SELECT TO aisdlc_gaterelay USING (stream LIKE 'gaterelay:%' OR stream LIKE 'gate:%');
CREATE POLICY record_event_gaterelay_append ON record.record_event
  FOR INSERT TO aisdlc_gaterelay WITH CHECK (stream LIKE 'gaterelay:%');

-- core (the owner of the item) reads the releases through the record; its app role reads the read models too.
GRANT USAGE ON SCHEMA gaterelay TO aisdlc_app;
GRANT SELECT ON gaterelay.intent, gaterelay.refusal, gaterelay.deploy_marker, gaterelay.deploy_health TO aisdlc_app;
