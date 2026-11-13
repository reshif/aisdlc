-- Core: the onboarding console's sessions (docs/design/onboarding-console.md; P2). Needs the record schema and 0001_core.
--
-- `console_payload` is the ONE table here with authority of its own: the text of a turn (what the person typed with any
-- secret masked before it was stored, what the agent answered, an observation the factory wrote) kept OFF the hash chain
-- so it can be erased. The record names each payload by id and the sha256 of its text (`onboarding_session.turn_recorded`).
-- It carries the S0 id so a deletion of the onboarding sweeps it. Nothing else is stored here: no prompt, no context,
-- no key.
--
-- `console_session`, `console_turn` and `console_proposal` are read models: a fold of the `onboarding_session.*` events
-- on the `onboarding-session:<s0>` streams. Dropping them and refolding the record gives the same rows.

CREATE TABLE core.console_payload (
  payload_id  uuid        PRIMARY KEY,
  s0_id       uuid        NOT NULL,
  owner       text        NOT NULL,
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  text        text,
  redactions  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL,
  erased_at   timestamptz,
  CHECK ((text IS NULL) = (erased_at IS NOT NULL))
);
CREATE INDEX console_payload_s0_idx ON core.console_payload (s0_id);

CREATE TABLE core.console_session (
  s0_id         uuid        PRIMARY KEY,
  project_id    text        NOT NULL,
  started_by    text        NOT NULL,
  state         text        NOT NULL CHECK (state IN ('running', 'awaiting_person', 'paused', 'stopped', 'done')),
  cause         text,
  turns         integer     NOT NULL DEFAULT 0 CHECK (turns >= 0),
  opened_at     timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX console_session_started_idx ON core.console_session (started_by, updated_at DESC);

CREATE TABLE core.console_turn (
  s0_id        uuid        NOT NULL,
  seq          integer     NOT NULL CHECK (seq >= 1),
  role         text        NOT NULL,
  at           timestamptz NOT NULL,
  payload_id   uuid        NOT NULL,
  payload_sha  text        NOT NULL,
  observed     text,
  observed_sha text,
  prompt_sha   text,
  guidelines_revision text,
  global_seq   bigint      NOT NULL,
  PRIMARY KEY (s0_id, seq)
);

CREATE TABLE core.console_proposal (
  proposal_id  uuid        PRIMARY KEY,
  s0_id        uuid        NOT NULL,
  kind         text        NOT NULL,
  target       text        NOT NULL,
  body         jsonb       NOT NULL,
  proposal_sha text        NOT NULL,
  turn_seq     integer     NOT NULL,
  state        text        NOT NULL DEFAULT 'open',
  decided_by   text,
  decided_at   timestamptz,
  global_seq   bigint      NOT NULL
);
CREATE INDEX console_proposal_s0_idx ON core.console_proposal (s0_id);
