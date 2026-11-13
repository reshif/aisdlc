-- Deletion's purge path (owner decision 2026-11-13, "delete means delete"; docs/specs/deletion.md §4).
--
-- ROLE MODEL (adds to 0001)
--   aisdlc_purge  NOLOGIN group role, a member of aisdlc_app, held ONLY by the deletion login (core's
--                 `CORE_PURGE_DATABASE_URL`), never by a service's normal login. It may remove the record
--                 events of a deleted object (each accounted for first in record.purged_event), redact an
--                 event of the object that sits in a stream of something else (its hash and link kept), remove
--                 outbox rows, and remove read-model rows of every schema (default privileges below). The
--                 purge transaction runs `SET LOCAL ROLE aisdlc_purge`.
-- The triggers still refuse everyone else, the owner included, and refuse a purge that is not purge-shaped.

DO $$
BEGIN
  CREATE ROLE aisdlc_purge NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- roles are cluster-wide
END
$$;

DO $$
BEGIN
  GRANT aisdlc_app TO aisdlc_purge;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

-- A redacted event: its type, body and actor erased, its place in the stream (seq, prev_hash, hash) kept.
ALTER TABLE record.record_event ADD COLUMN redacted_at timestamptz;

-- Every removed event leaves its global position here, and nothing else, so `verifyAll` can tell a purge from a
-- deleted row: a gap in global_seq is accepted only where this table names every missing position.
CREATE TABLE record.purged_event (
  global_seq  bigint      PRIMARY KEY CHECK (global_seq >= 1),
  deletion_id uuid        NOT NULL,
  purged_at   timestamptz NOT NULL
);
CREATE TRIGGER purged_event_no_update_delete
  BEFORE UPDATE OR DELETE ON record.purged_event
  FOR EACH ROW EXECUTE FUNCTION record.reject_mutation();
CREATE TRIGGER purged_event_no_truncate
  BEFORE TRUNCATE ON record.purged_event
  FOR EACH STATEMENT EXECUTE FUNCTION record.reject_mutation();
GRANT SELECT ON record.purged_event TO aisdlc_app;
GRANT INSERT ON record.purged_event TO aisdlc_purge;

-- The purge role must be the CURRENT role (`SET LOCAL ROLE aisdlc_purge`), not merely one the login could take:
-- membership alone would let every superuser and owner session through without asking for it.
CREATE FUNCTION record.is_purger() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_user = 'aisdlc_purge'
$$;

CREATE FUNCTION record.guard_record_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF record.is_purger() THEN
    IF TG_OP = 'DELETE'
       AND EXISTS (SELECT 1 FROM record.purged_event p WHERE p.global_seq = OLD.global_seq) THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.stream = OLD.stream AND NEW.seq = OLD.seq AND NEW.global_seq = OLD.global_seq
       AND NEW.event_id = OLD.event_id AND NEW.prev_hash = OLD.prev_hash AND NEW.hash = OLD.hash
       AND NEW.occurred_at = OLD.occurred_at
       AND NEW.type = 'redacted' AND NEW.body = '{}'::jsonb AND NEW.actor = 'redacted'
       AND NEW.idempotency_key IS NULL AND NEW.redacted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DROP TRIGGER record_event_no_update_delete ON record.record_event;
CREATE TRIGGER record_event_purge_only
  BEFORE UPDATE OR DELETE ON record.record_event
  FOR EACH ROW EXECUTE FUNCTION record.guard_record_event();

-- The outbox: delivery bookkeeping as before, and the purger may remove a row.
CREATE OR REPLACE FUNCTION record.guard_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND record.is_purger() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.destination = OLD.destination
     AND NEW.payload = OLD.payload
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.created_at = OLD.created_at
     AND (OLD.dispatched_at IS NULL OR NEW.dispatched_at = OLD.dispatched_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record.outbox rows are immutable except delivery bookkeeping (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

GRANT UPDATE, DELETE ON record.record_event TO aisdlc_purge;
GRANT DELETE ON record.outbox TO aisdlc_purge;

-- Read models: SELECT and DELETE on every table of every schema, now and later (tables a later migration creates,
-- by the role that runs the migrations). The triggers above keep the record and the ledger what they are.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO aisdlc_purge', s);
    EXECUTE format('GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA %I TO aisdlc_purge', s);
  END LOOP;
END
$$;
ALTER DEFAULT PRIVILEGES GRANT SELECT, DELETE ON TABLES TO aisdlc_purge;
ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO aisdlc_purge;
