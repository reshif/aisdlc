-- The record: append-only, hash-chained events (PLAN M2.1, principle 2).
--
-- ROLE MODEL
--   aisdlc_app  NOLOGIN group role granted to every service that writes the record. It holds
--               INSERT and SELECT on record.record_event and nothing else on it: no UPDATE, DELETE
--               or TRUNCATE. Production login roles are members: GRANT aisdlc_app TO svc_core;
--   owner       the role that runs migrations. It owns the tables and could disable the triggers,
--               so it must not be used by services. A superuser can also bypass triggers with
--               session_replication_role = replica; that is why verifyChain exists and why the
--               ledger checkpoints (M2.4) anchor the heads outside this database.
-- Two independent layers stop mutation: grants (app role) and triggers (everyone, owner included).

CREATE SCHEMA record;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- exists (roles are cluster-wide; concurrent test databases may race here)
END
$$;

GRANT USAGE ON SCHEMA record TO aisdlc_app;

CREATE TABLE record.record_event (
  stream          text        NOT NULL CHECK (stream <> ''),
  seq             bigint      NOT NULL CHECK (seq >= 1),
  -- Position in commit order across all streams; assigned under the global_counter row lock.
  global_seq      bigint      NOT NULL CHECK (global_seq >= 1),
  event_id        uuid        NOT NULL,
  type            text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  body            jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  actor           text        NOT NULL CHECK (actor <> ''),
  -- Millisecond precision so the hashed ISO string round-trips exactly.
  occurred_at     timestamptz NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  idempotency_key text        CHECK (idempotency_key <> ''),
  prev_hash       text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash            text        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (stream, seq),
  CONSTRAINT record_event_event_id_key UNIQUE (event_id),
  CONSTRAINT record_event_global_seq_key UNIQUE (global_seq)
);

-- A duplicate signal is a no-op: the same key in the same stream can be stored once.
CREATE UNIQUE INDEX record_event_idempotency_key
  ON record.record_event (stream, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE FUNCTION record.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER record_event_no_update_delete
  BEFORE UPDATE OR DELETE ON record.record_event
  FOR EACH ROW EXECUTE FUNCTION record.reject_mutation();

CREATE TRIGGER record_event_no_truncate
  BEFORE TRUNCATE ON record.record_event
  FOR EACH STATEMENT EXECUTE FUNCTION record.reject_mutation();

GRANT SELECT, INSERT ON record.record_event TO aisdlc_app;

-- Global append order. A bigserial would hand out numbers in call order, not commit order: a
-- transaction that took 7 can commit after the one that took 8, so a reader that has folded up to 8
-- would skip 7 forever. Instead every append locks this single row (SELECT ... FOR UPDATE) before
-- it reads or writes anything, takes the next numbers from it, and the lock is held to COMMIT.
-- Appends are therefore serialised: global_seq order is commit order, has no gaps (a rolled-back
-- append returns its numbers) and a reader never sees N+1 without N.
CREATE TABLE record.global_counter (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seq bigint  NOT NULL CHECK (last_seq >= 0)
);
INSERT INTO record.global_counter (id, last_seq) VALUES (true, 0);

CREATE FUNCTION record.guard_global_counter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_seq >= OLD.last_seq THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record.global_counter only moves forward (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER global_counter_forward_only
  BEFORE UPDATE OR DELETE ON record.global_counter
  FOR EACH ROW EXECUTE FUNCTION record.guard_global_counter();

CREATE TRIGGER global_counter_no_truncate
  BEFORE TRUNCATE ON record.global_counter
  FOR EACH STATEMENT EXECUTE FUNCTION record.reject_mutation();

GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_app;
