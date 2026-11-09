-- Core: planning artefacts (PLAN M12.1, M12.2; DM §3.5 Artefact, §8 gap 6). Needs the record schema and 0001_core.
--
-- `artefact` is the CONTENT STORE of what a planning step produced: one row per (item, type, version), the
-- body as canonical JSON (RFC 8785) under its sha256. It is append-only (no UPDATE or DELETE is granted) and
-- content-addressed: `sha256` is the hash of `content`, and every read recomputes it. The record is the
-- authority for what exists: each row has an `artefact.stored` event on `planning:<item>` carrying the same
-- hash, written in the same transaction, and a reader also checks the event. The table never holds a
-- secret (the shared ruleset ran over the content before it was written) and never a prompt or a model's
-- conversation: only the structured artefact an agent proposed and the factory accepted.

CREATE TABLE core.artefact (
  -- the order artefacts were stored in (versions order one type; this orders them all)
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  item_id     uuid        NOT NULL,
  type        text        NOT NULL,
  version     integer     NOT NULL CHECK (version >= 1),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  project_id  text        NOT NULL,
  step        text        NOT NULL,
  command_key text        NOT NULL,
  run_id      uuid,
  content     text        NOT NULL,
  bytes       integer     NOT NULL CHECK (bytes >= 1),
  stored_at   timestamptz NOT NULL,
  PRIMARY KEY (item_id, type, version),
  -- a command stores at most one artefact of a type: a redelivery finds it instead of storing it again
  UNIQUE (item_id, command_key, type)
);
CREATE INDEX artefact_sha_idx ON core.artefact (item_id, sha256);

GRANT SELECT, INSERT ON core.artefact TO aisdlc_app;
