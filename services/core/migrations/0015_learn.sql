-- 9.4 Learn and the META gates (PLAN M15.5). Read models folded from `learn:<project>` (`learn.proposed`,
-- `learn.settled`) and `audit:<project>` (`audit.mode_e_lifted`), rebuilt from those events alone (`rebuildLearn`,
-- `rebuildAudits`).

-- One row per proposal: the META gate it went into and, once that gate ended on the ledger, how it ended.
CREATE TABLE core.learn_proposal (
  proposal_id      text        PRIMARY KEY CHECK (proposal_id ~ '^[0-9a-f]{64}$'),
  project_id       text        NOT NULL,
  kind             text        NOT NULL,
  topic            text        NOT NULL,
  meta_gate        text        NOT NULL CHECK (meta_gate IN ('M1', 'M2', 'M3', 'M5', 'M6')),
  gate_instance_id text        NOT NULL,
  card_id          text,
  proposal         jsonb       NOT NULL,
  proposed_at      timestamptz NOT NULL,
  proposed_gseq    bigint      NOT NULL,
  outcome          text,
  effect           text,
  ledger_entry_id  text,
  settled_gseq     bigint
);
CREATE INDEX learn_proposal_project_idx ON core.learn_proposal (project_id, topic, proposed_gseq);
CREATE INDEX learn_proposal_pending_idx ON core.learn_proposal (project_id) WHERE settled_gseq IS NULL;

-- The autonomy a decided M5 earned for a project (it replaces the probation cap). Only `learn.settled` with the effect
-- `autonomy_earned` writes it, and only for an approved M5 read from the ledger.
CREATE TABLE core.autonomy_earned (
  project_id       text        PRIMARY KEY,
  level            text        NOT NULL CHECK (level IN ('A0', 'A1', 'A2', 'A3')),
  proposal_id      text        NOT NULL,
  gate_instance_id text        NOT NULL,
  ledger_entry_id  text        NOT NULL,
  event_gseq       bigint      NOT NULL
);

-- B19's audit window: a decided M5 lift ends a suspension, and the next window counts only the audits after it.
CREATE TABLE core.mode_e_window (
  project_id  text   PRIMARY KEY,
  epoch       integer NOT NULL CHECK (epoch >= 1),
  since_gseq  bigint NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.learn_proposal, core.autonomy_earned, core.mode_e_window TO aisdlc_app;
