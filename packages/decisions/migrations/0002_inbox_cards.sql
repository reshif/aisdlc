-- Inbox cards (PLAN M3.4) and the `config` gate subject (PLAN M3.5).

-- An M1 gate decides a config revision: its subject is a config lineage.
ALTER TABLE decisions.gate_instance DROP CONSTRAINT gate_instance_subject_kind_check;
ALTER TABLE decisions.gate_instance
  ADD CONSTRAINT gate_instance_subject_kind_check CHECK (subject_kind IN ('item', 's0_record', 'config'));

-- The `inbox` read model: a pure fold of the record streams `card:<id>` (no ledger feed). A card
-- owns no decision and no status. Its status is derived at read time from its gate instances (the
-- `gate_instance` projection, which folds the ledger) and from its step entries on the ledger, so
-- nothing here can disagree with the ledger. Dropping these tables and refolding gives the same rows.
CREATE TABLE decisions.inbox_card (
  card_id       uuid        PRIMARY KEY,
  project_id    text        NOT NULL,
  subject_kind  text        NOT NULL,
  subject_id    text        NOT NULL,
  card_group    text        NOT NULL,
  label         text,
  role          text        NOT NULL,
  requester     text,
  sla_due_at    timestamptz NOT NULL,
  opened_at     timestamptz NOT NULL,
  payload_hash  text        CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  escalated_at  timestamptz
);
CREATE INDEX inbox_card_subject_idx ON decisions.inbox_card (subject_kind, subject_id);

CREATE TABLE decisions.inbox_card_gate (
  card_id          uuid NOT NULL,
  gate_instance_id uuid NOT NULL,
  gate_id          text NOT NULL,
  subject_hash     text NOT NULL,
  position         integer NOT NULL,
  PRIMARY KEY (card_id, gate_instance_id)
);
CREATE INDEX inbox_card_gate_instance_idx ON decisions.inbox_card_gate (gate_instance_id);

CREATE TABLE decisions.inbox_card_step (
  card_id  uuid NOT NULL,
  step     text NOT NULL,
  slot     text NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (card_id, step)
);

-- An inbox entry for a principal that is NOT an eligible decider: the backup of an escalation.
-- (Eligible deciders are resolved at read time from the EligibilityPort, which can change.)
CREATE TABLE decisions.inbox_entry (
  card_id          uuid        NOT NULL,
  principal        text        NOT NULL,
  reason           text        NOT NULL CHECK (reason IN ('escalated_backup')),
  gate_instance_id uuid        NOT NULL,
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (card_id, principal, gate_instance_id)
);
CREATE INDEX inbox_entry_principal_idx ON decisions.inbox_entry (principal);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  decisions.inbox_card, decisions.inbox_card_gate, decisions.inbox_card_step, decisions.inbox_entry
  TO aisdlc_app;

-- Step decisions of a card on the ledger (entry_type 'card.step_decision').
CREATE INDEX ledger_entry_card_step_idx ON ledger.ledger_entry ((body ->> 'card_id'))
  WHERE entry_type = 'card.step_decision';
