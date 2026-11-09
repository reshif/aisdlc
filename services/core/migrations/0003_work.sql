-- Core: work items (PLAN M9.1, M9.2). Needs the record schema and 0001_core.
--
-- `work_item` is a read model: a pure fold of the record streams `item:<uuid>` through the lifecycle
-- interpreter (`@aisdlc/work`). Dropping the table and refolding gives the same rows. It answers three
-- questions without folding every stream: which items are active (the work driver), which items of a
-- repo are open (de-dupe), and whether a repo has agent work in flight (the effective-rules poll). The
-- authority stays the stream: every write path folds the stream itself.

CREATE TABLE core.work_item (
  item_id           uuid        PRIMARY KEY,
  project_id        text        NOT NULL,
  repo_key          text        NOT NULL,
  request_id        uuid        NOT NULL,
  -- NULL until G0 binds the lane profile (FL FIX 7).
  lane              text,
  proposed_lane     text        NOT NULL,
  -- The phase with holds applied (`Held`), and the phase it resumes to.
  phase             text        NOT NULL,
  underlying        text        NOT NULL,
  terminal          text,
  holds             integer     NOT NULL DEFAULT 0 CHECK (holds >= 0),
  -- Commands issued and not yet answered (what the work driver still has to see done).
  outstanding       integer     NOT NULL DEFAULT 0 CHECK (outstanding >= 0),
  -- sha256 of the normalised request text (the de-dupe key); NULL for a factory-raised item.
  text_sha256       text,
  tier              text        NOT NULL,
  lease_open        boolean     NOT NULL,
  session_open      boolean     NOT NULL,
  -- Agent work in flight: S6 or S7 with an open lease or session. TRUE also when the item's
  -- catalogue pin is not carried by this build (it cannot be interpreted, so assume the worst).
  in_flight         boolean     NOT NULL,
  pin_unavailable   boolean     NOT NULL DEFAULT false,
  catalogue_version text        NOT NULL,
  catalogue_hash    text        NOT NULL CHECK (catalogue_hash ~ '^[0-9a-f]{64}$'),
  seq               integer     NOT NULL CHECK (seq >= 1),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX work_item_active_idx ON core.work_item (repo_key) WHERE terminal IS NULL;
CREATE INDEX work_item_dedupe_idx ON core.work_item (repo_key, text_sha256) WHERE terminal IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.work_item TO aisdlc_app;

-- Lookups of the authoritative streams by what they name (the de-dupe scan reads the stream, not the table).
CREATE INDEX core_item_created_idx
  ON record.record_event ((lower(body ->> 'repo')), (body #>> '{intake,text_sha256}'))
  WHERE type = 'item.created';
CREATE INDEX core_work_item_marker_idx ON record.record_event ((body ->> 'request_id'))
  WHERE type = 'work.item_created';
