-- Core: S9 close-out (PLAN M15.4; FL S9 9.3 "Close-out record", 9.5 "Mode-E audit sample, async", B19).
--
-- READ MODELS. The authority is the record: `closeout.recorded` on `closeout:<item>` (with its ledger entry, written in
-- the same transaction: the ledger lock before the first append, the entry last), and the `audit.*` events on
-- `audit:<project>` (`audit.mode_e_suspended` also with a ledger entry). core folds each event into these tables as it
-- writes it and rebuilds them from the events alone (`rebuildCloseOut`, `rebuildAudits`).

-- One close-out record per item: what the item was, what decided it and what it shipped. The record is the event's.
CREATE TABLE core.closeout (
  item_id          uuid        PRIMARY KEY,
  project_id       text        NOT NULL,
  closeout_sha256  text        NOT NULL CHECK (closeout_sha256 ~ '^[0-9a-f]{64}$'),
  g4_mode          text        CHECK (g4_mode IN ('E', 'C')),
  record           jsonb       NOT NULL,
  recorded_at      timestamptz NOT NULL,
  event_gseq       bigint      NOT NULL
);
CREATE INDEX closeout_mode_e_idx ON core.closeout (project_id, event_gseq) WHERE g4_mode = 'E';

-- 9.5: every mode-E close-out considered for the sample once, drawn or not, and the audit's result when one is drawn.
CREATE TABLE core.audit_sample (
  item_id             uuid        PRIMARY KEY,
  project_id          text        NOT NULL,
  closeout_sha256     text        NOT NULL,
  g4_gate_instance_id text        NOT NULL,
  g4_deciders         text[]      NOT NULL,
  requester           text        NOT NULL,
  catalogue           jsonb       NOT NULL,
  sampled             boolean     NOT NULL,
  considered_gseq     bigint      NOT NULL,
  outcome             text        CHECK (outcome IN ('ok', 'gate_miss')),
  audited_by          text,
  result_gseq         bigint,
  CHECK ((outcome IS NULL) = (result_gseq IS NULL)),
  CHECK (outcome IS NULL OR sampled)
);
CREATE INDEX audit_sample_project_idx ON core.audit_sample (project_id, result_gseq);

-- B19: mode E suspended for a project (the pinned catalogue's miss rate over its minimum sample). Lifting it is 9.4's
-- (M15.5, a decided M-gate), not built here: a row stays.
CREATE TABLE core.mode_e_suspension (
  project_id   text        PRIMARY KEY,
  sampled      integer     NOT NULL,
  missed       integer     NOT NULL,
  detail       jsonb       NOT NULL,
  suspended_at timestamptz NOT NULL,
  event_gseq   bigint      NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.closeout, core.audit_sample, core.mode_e_suspension TO aisdlc_app;
