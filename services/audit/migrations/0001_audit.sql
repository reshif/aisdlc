-- The audit service (PLAN M19; ADR-0003 §1 Trust plane; docs/specs/audit-api.md): signed exports, erasure, legal hold
-- and retention. Every table here is a read model: a fold of the `audit.*` events on the service's own record streams
-- (`audit-export:<id>`, `audit-erasure:<id>`, `audit-hold:<id>`, `audit-retention`), rebuilt from the record alone
-- (`rebuildAudit`). The decisions themselves are ledger entries (`audit.export`, `erasure.execute`, `legal_hold.place`,
-- `legal_hold.release`), written last in the same transaction as their event (the lock order of AGENTS.md); the read
-- models name them by entry id.
--
-- Least privilege: the audit service connects as the login role `audit` (db-init), a member of the NOLOGIN group role
-- below, which can do exactly this:
--
--   audit.*                     SELECT, INSERT, UPDATE on its read models (never DELETE: only the owner rebuilds)
--   record.record_event         SELECT of every stream (an export reads the record of its scope), INSERT of `audit-%`
--                               streams only (row-level security), never UPDATE or DELETE
--   record.global_counter       SELECT and UPDATE: every append locks this one row and moves it forward
--   record.projection_checkpoint SELECT: whether identity's read model is current (the PDP refuses when it is behind)
--   ledger.ledger_entry         SELECT, and INSERT of its four entry types only (row-level security)
--   ledger.checkpoint           SELECT: the newest checkpoint is what an export is anchored to
--   config.genuine_publish      SELECT: the effective config (retention classes, the policy bundle)
--   identity read model         SELECT: the PDP's facts (principals, bindings, groups, memberships, links, qualifications)
--
-- and nothing else: no core table (the erasable payloads are core's, reached through core's API, scope `erasure`), no
-- decisions, knowledge or gateway table, no DDL. The signed exports themselves are in the object store's write-once
-- bucket `audit-exports`, never in Postgres.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.export (
  export_id      uuid        PRIMARY KEY,
  scope_kind     text        NOT NULL CHECK (scope_kind IN ('fleet', 'project')),
  project_id     text,
  from_at        timestamptz NOT NULL,
  to_at          timestamptz NOT NULL,
  requested_by   text        NOT NULL,
  export_sha256  text        NOT NULL UNIQUE CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  object_key     text        NOT NULL CHECK (object_key ~ '^[0-9a-f]{64}$'),
  entry_id       uuid        NOT NULL,
  -- ExportWrittenPayload, as recorded
  payload        jsonb       NOT NULL,
  event_gseq     bigint      NOT NULL,
  CHECK ((scope_kind = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX export_project_idx ON audit.export (project_id, event_gseq DESC);

CREATE TABLE audit.legal_hold (
  hold_id          uuid        PRIMARY KEY,
  scope_kind       text        NOT NULL CHECK (scope_kind IN ('fleet', 'project', 'principal')),
  scope_ref        text        NOT NULL,
  scope            jsonb       NOT NULL,
  matter_ref       text        NOT NULL,
  reason           text        NOT NULL,
  state            text        NOT NULL CHECK (state IN ('active', 'released')),
  placed_by        text        NOT NULL,
  placed_at        timestamptz NOT NULL,
  place_entry_id   uuid        NOT NULL,
  released_by      text,
  released_at      timestamptz,
  release_reason   text,
  release_entry_id uuid,
  event_gseq       bigint      NOT NULL,
  CHECK ((state = 'released') = (released_by IS NOT NULL))
);
CREATE INDEX legal_hold_active_idx ON audit.legal_hold (scope_kind, scope_ref) WHERE state = 'active';

CREATE TABLE audit.erasure (
  erasure_id    uuid        PRIMARY KEY,
  basis         text        NOT NULL CHECK (basis IN ('request', 'retention')),
  state         text        NOT NULL CHECK (state IN ('requested', 'blocked', 'approved', 'executed', 'rejected')),
  subject       jsonb,
  reason        text        NOT NULL,
  requested_by  text        NOT NULL,
  requested_at  timestamptz NOT NULL,
  approved_by   text,
  approved_at   timestamptz,
  matter_ref    text,
  entry_id      uuid,
  rejected_by   text,
  blocked_by    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  executed_at   timestamptz,
  event_gseq    bigint      NOT NULL
);
CREATE INDEX erasure_state_idx ON audit.erasure (state, requested_at);

CREATE TABLE audit.erasure_target (
  erasure_id  uuid    NOT NULL REFERENCES audit.erasure (erasure_id),
  payload_id  uuid    NOT NULL,
  kind        text    NOT NULL,
  thread_id   uuid    NOT NULL,
  owner       text    NOT NULL,
  project_id  text,
  sha256      text    NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  erased      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (erasure_id, payload_id)
);
CREATE INDEX erasure_target_payload_idx ON audit.erasure_target (payload_id);

CREATE TABLE audit.retention_sweep (
  event_gseq  bigint      PRIMARY KEY,
  class       text        NOT NULL,
  payload     jsonb       NOT NULL,
  at          timestamptz NOT NULL
);

DO $$
BEGIN
  CREATE ROLE aisdlc_audit NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA audit, record, ledger, config, identity TO aisdlc_audit;
GRANT SELECT, INSERT, UPDATE ON audit.export, audit.legal_hold, audit.erasure, audit.erasure_target,
  audit.retention_sweep TO aisdlc_audit;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_audit;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_audit;
GRANT SELECT ON record.projection_checkpoint TO aisdlc_audit;
GRANT SELECT, INSERT ON ledger.ledger_entry TO aisdlc_audit;
GRANT SELECT ON ledger.checkpoint TO aisdlc_audit;
GRANT SELECT ON config.genuine_publish TO aisdlc_audit;
GRANT SELECT ON identity.principal, identity.membership, identity.binding, identity.grp, identity.qualification,
  identity.identity_link TO aisdlc_audit;

-- The record's row-level security (enabled by the gateway migration, which runs before this one in the plan): the
-- audit role reads every stream (an export is the record of its scope) and appends only to its own.
CREATE POLICY record_event_audit_read ON record.record_event
  FOR SELECT TO aisdlc_audit USING (true);
CREATE POLICY record_event_audit_append ON record.record_event
  FOR INSERT TO aisdlc_audit WITH CHECK (stream LIKE 'audit-%');

-- The ledger gets row-level security here, for the one role that may write only some of its entry types. Every other
-- role keeps exactly what its grants gave it: the owner bypasses RLS, `aisdlc_app` writes any type as before, and any
-- role with a SELECT grant still reads every entry (the policy for reads is `true` for everyone; grants decide who).
ALTER TABLE ledger.ledger_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_entry_read ON ledger.ledger_entry FOR SELECT USING (true);
CREATE POLICY ledger_entry_app_append ON ledger.ledger_entry
  FOR INSERT TO aisdlc_app WITH CHECK (true);
CREATE POLICY ledger_entry_audit_append ON ledger.ledger_entry
  FOR INSERT TO aisdlc_audit WITH CHECK (
    entry_type IN ('audit.export', 'erasure.execute', 'legal_hold.place', 'legal_hold.release')
  );

-- core's portal reads (the bff and core connect as members of aisdlc_app) may show the audit read models.
GRANT USAGE ON SCHEMA audit TO aisdlc_app;
GRANT SELECT ON audit.export, audit.legal_hold, audit.erasure, audit.erasure_target, audit.retention_sweep
  TO aisdlc_app;
