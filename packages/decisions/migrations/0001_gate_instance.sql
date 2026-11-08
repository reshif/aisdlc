-- Decision kernel (PLAN M3.1-M3.3). Needs the record and ledger schemas.
--
-- `gate_instance`, `gate_vote` and `gate_event` are ONE read model (projection `gate_instance`),
-- folded from record events on `gate:<id>` and from ledger `decision` entries. Dropping them and
-- refolding gives the same rows (the rebuild harness checks it). `gate_nonce` is not a projection:
-- it is the short-lived server state of PreparedDecision (M3.3).

CREATE SCHEMA decisions;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA decisions TO aisdlc_app;

CREATE TABLE decisions.gate_instance (
  gate_instance_id   uuid        PRIMARY KEY,
  gate_id            text        NOT NULL,
  project_id         text        NOT NULL,
  subject_kind       text        NOT NULL CHECK (subject_kind IN ('item', 's0_record')),
  subject_id         text        NOT NULL,
  subject_hash       text        NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  evidence_pack_hash text        CHECK (evidence_pack_hash ~ '^[0-9a-f]{64}$'),
  requester          text,
  facts              jsonb       NOT NULL,
  expires_at         timestamptz NOT NULL,
  quorum_required    integer     NOT NULL CHECK (quorum_required >= 1),
  supersedes         uuid,
  opened_at          timestamptz NOT NULL,
  -- Everything below is derived from the ledger decisions of this instance (gate_vote), never
  -- from a record event.
  status             text        NOT NULL CHECK (status IN ('pending','decided','superseded','expired','closed')),
  outcome            text        CHECK (outcome IN ('approve','reject','request_changes')),
  approvers          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  decided_at         timestamptz,
  decided_ledger_seq bigint,
  superseded_by      uuid,
  CHECK ((status = 'pending') = (decided_at IS NULL AND decided_ledger_seq IS NULL)),
  CHECK (status = 'decided' OR outcome IS NULL)
);
CREATE INDEX gate_instance_subject_idx ON decisions.gate_instance (gate_id, subject_kind, subject_id);
CREATE INDEX gate_instance_pending_expiry_idx ON decisions.gate_instance (expires_at) WHERE status = 'pending';

-- One row per ledger decision entry for a gate instance (also entries that came after the gate was
-- decided: they are kept for the audit trail and are not effective). A row may exist before its
-- gate_instance row does; the fold does not depend on the order the two sources are read.
CREATE TABLE decisions.gate_vote (
  ledger_seq       bigint      PRIMARY KEY,
  gate_instance_id uuid        NOT NULL,
  entry_id         uuid        NOT NULL UNIQUE,
  subject_hash     text        NOT NULL,
  decision         text        NOT NULL,
  actor            text        NOT NULL,
  sod_waiver       boolean     NOT NULL,
  created_at       timestamptz NOT NULL,
  body             jsonb       NOT NULL
);
CREATE INDEX gate_vote_gate_idx ON decisions.gate_vote (gate_instance_id, ledger_seq);

-- Record events of a gate stream other than `gate.opened`: markers written in the same transaction
-- as a ledger decision, and evidence-viewed notes. Annotations only, they never change a status.
CREATE TABLE decisions.gate_event (
  event_id         uuid        PRIMARY KEY,
  gate_instance_id uuid        NOT NULL,
  stream_seq       integer     NOT NULL,
  type             text        NOT NULL,
  actor            text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  payload          jsonb       NOT NULL
);
CREATE INDEX gate_event_gate_idx ON decisions.gate_event (gate_instance_id, stream_seq);

-- PreparedDecision with a server nonce (PLAN M3.3, DM GateNonce). Single use, 10 minute expiry.
CREATE TABLE decisions.gate_nonce (
  nonce_sha256        text        PRIMARY KEY CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  gate_instance_id    uuid        NOT NULL,
  principal           text        NOT NULL,
  subject_hash        text        NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  evidence_hash       text        NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_viewed_at  timestamptz,
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX gate_nonce_gate_idx ON decisions.gate_nonce (gate_instance_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON decisions.gate_instance, decisions.gate_vote, decisions.gate_event TO aisdlc_app;
GRANT SELECT, INSERT, UPDATE ON decisions.gate_nonce TO aisdlc_app;

-- Lookups the lifecycle needs on the authoritative tables (the owner may add indexes; the data is
-- untouched): the open event of a subject, and the decisions of one gate instance.
CREATE INDEX gate_opened_subject_idx ON record.record_event ((body ->> 'subject_id'))
  WHERE type = 'gate.opened';
CREATE INDEX ledger_entry_gate_instance_idx ON ledger.ledger_entry (gate_instance_id, ledger_seq)
  WHERE gate_instance_id IS NOT NULL;
