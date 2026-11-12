-- Core: the Conversation context (PLAN M18; docs/design/portal-config.md §4). Needs the record schema and 0001_core.
--
-- `conversation_payload` is the ONE table here with authority of its own: the text of a turn (what a person typed,
-- with any secret masked before it was stored, and what the assistant answered) kept OFF the hash chain, so it can be
-- erased. The record names each payload by id and the sha256 of its text (`conversation.turn_recorded`); erasing a
-- payload clears `text`, sets `erased_at` and keeps the hash, so the record still says that something was said. Nothing
-- else is stored here: no prompt, no context, no key.
--
-- `conversation_thread`, `conversation_turn` and `ask_session` are read models: a fold of the `conversation.*` events on
-- the `thread:<id>` streams. Dropping them and refolding the record gives the same rows (`rebuildConversations`); the
-- text they show is joined from the payload table when read.

CREATE TABLE core.conversation_payload (
  payload_id  uuid        PRIMARY KEY,
  owner       text        NOT NULL,
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- NULL once erased
  text        text,
  -- [{rule_id, count}]: what was masked, never a value
  redactions  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL,
  erased_at   timestamptz,
  CHECK ((text IS NULL) = (erased_at IS NOT NULL))
);

CREATE TABLE core.conversation_thread (
  thread_id     uuid        PRIMARY KEY,
  owner         text        NOT NULL,
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('s0', 'project')),
  s0_id         uuid,
  project_id    text        NOT NULL,
  title_payload uuid        NOT NULL,
  turns         integer     NOT NULL DEFAULT 0 CHECK (turns >= 0),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX conversation_thread_owner_idx ON core.conversation_thread (owner, updated_at DESC);

CREATE TABLE core.conversation_turn (
  thread_id     uuid        NOT NULL,
  seq           integer     NOT NULL CHECK (seq >= 1),
  role          text        NOT NULL,
  kind          text        NOT NULL,
  at            timestamptz NOT NULL,
  payload_id    uuid        NOT NULL,
  payload_sha   text        NOT NULL,
  redactions    jsonb       NOT NULL,
  -- citations, proposals, drafts (ids and hashes), flags: as recorded
  body          jsonb       NOT NULL,
  ask_id        uuid,
  global_seq    bigint      NOT NULL,
  PRIMARY KEY (thread_id, seq)
);

CREATE TABLE core.ask_session (
  ask_id         uuid        PRIMARY KEY,
  thread_id      uuid        NOT NULL,
  principal      text        NOT NULL,
  budget_group   text        NOT NULL,
  body           jsonb       NOT NULL,
  finished_at    timestamptz NOT NULL,
  global_seq     bigint      NOT NULL
);
CREATE INDEX ask_session_thread_idx ON core.ask_session (thread_id);

GRANT SELECT, INSERT, UPDATE ON core.conversation_payload TO aisdlc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.conversation_thread TO aisdlc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.conversation_turn TO aisdlc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.ask_session TO aisdlc_app;
