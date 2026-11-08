-- The ledger: hash-chained, Notary-signed entries and Witness co-signed checkpoints, in the record
-- database (PLAN M2.3, M2.4). Core writes the rows; only the Notary can produce a valid signature.
--
-- ROLE MODEL (same as the record, see packages/record/migrations/0001_record_event.sql)
--   aisdlc_app  INSERT and SELECT on both tables, nothing else.
--   owner       owns the tables and could disable triggers; a superuser can also set
--               session_replication_role = replica. Neither is a service role. Offline
--               verification (`aisdlc verify-ledger`) and the Witness exist for exactly that case.
-- The database cannot check an ES256 signature, so it enforces the shape and the chain; the
-- signatures are checked by the Notary (before it signs), the writer (before it inserts) and the
-- offline verifier.

CREATE SCHEMA ledger;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- exists (roles are cluster-wide; created by the record migration too)
END
$$;

GRANT USAGE ON SCHEMA ledger TO aisdlc_app;

CREATE FUNCTION ledger.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TABLE ledger.ledger_entry (
  ledger_seq            bigint      PRIMARY KEY CHECK (ledger_seq >= 1),
  entry_id              uuid        NOT NULL,
  entry_type            text        NOT NULL CHECK (entry_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  gate_instance_id      uuid,
  gate_id               text,
  subject_kind          text,
  subject_id            text,
  subject_hash          text        CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  decision              text,
  actor                 text,
  sod_waiver            boolean     NOT NULL,
  policy_bundle_version text        NOT NULL CHECK (policy_bundle_version <> ''),
  body                  jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  prev_hash             text        CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash            text        NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  -- The Notary signature and the id of the key that made it.
  notary_key_id         text        NOT NULL CHECK (notary_key_id <> ''),
  notary_alg            text        NOT NULL CHECK (notary_alg = 'ES256'),
  notary_sig            text        NOT NULL CHECK (notary_sig ~ '^[A-Za-z0-9_-]+$'),
  -- Millisecond precision so the hashed ISO string round-trips exactly.
  created_at            timestamptz NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  CONSTRAINT ledger_entry_entry_id_key UNIQUE (entry_id),
  CONSTRAINT ledger_entry_entry_hash_key UNIQUE (entry_hash),
  CONSTRAINT ledger_entry_first_has_no_prev CHECK ((ledger_seq = 1) = (prev_hash IS NULL)),
  CONSTRAINT ledger_entry_decision_fields CHECK (
    entry_type <> 'decision' OR (
      gate_instance_id IS NOT NULL AND gate_id IS NOT NULL AND subject_kind IS NOT NULL
      AND subject_id IS NOT NULL AND subject_hash IS NOT NULL AND decision IS NOT NULL
      AND actor IS NOT NULL
    )
  )
);

-- The chain, enforced on insert: an entry is accepted only as the next one after the committed
-- head, linking to its entry_hash. No gap, no fork, whatever the application does. (Two writers
-- racing for one seq collide on the primary key; the writer also serialises with an advisory lock.)
CREATE FUNCTION ledger.guard_ledger_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head ledger.ledger_entry;
BEGIN
  SELECT * INTO head FROM ledger.ledger_entry ORDER BY ledger_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.ledger_seq <> 1 THEN
      RAISE EXCEPTION 'ledger starts at seq 1, got %', NEW.ledger_seq USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.ledger_seq <> head.ledger_seq + 1 OR NEW.prev_hash IS DISTINCT FROM head.entry_hash THEN
    RAISE EXCEPTION 'ledger entry % does not extend the head (seq %)', NEW.ledger_seq, head.ledger_seq
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ledger_entry_chain BEFORE INSERT ON ledger.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_ledger_chain();
CREATE TRIGGER ledger_entry_no_update_delete BEFORE UPDATE OR DELETE ON ledger.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER ledger_entry_no_truncate BEFORE TRUNCATE ON ledger.ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();

GRANT SELECT, INSERT ON ledger.ledger_entry TO aisdlc_app;

-- Checkpoints: a signed tree head over entries from_ledger_seq..to_ledger_seq, signed by the
-- Notary and co-signed by the Witness (signatures: [{signer, signature: {key_id, alg, value}}]).
CREATE TABLE ledger.checkpoint (
  cp_seq          bigint      PRIMARY KEY CHECK (cp_seq >= 1),
  from_ledger_seq bigint      NOT NULL CHECK (from_ledger_seq >= 1),
  to_ledger_seq   bigint      NOT NULL,
  root_hash       text        NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  head_hash       text        NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  signatures      jsonb       NOT NULL CHECK (jsonb_typeof(signatures) = 'array'),
  created_at      timestamptz NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  CHECK (to_ledger_seq >= from_ledger_seq),
  CHECK (signatures @> '[{"signer": "witness"}]'::jsonb),
  CHECK (signatures @> '[{"signer": "notary"}]'::jsonb)
);

-- Checkpoints advance by one, never shrink, and end at an entry whose hash is the head_hash.
CREATE FUNCTION ledger.guard_checkpoint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev ledger.checkpoint;
  covered ledger.ledger_entry;
BEGIN
  SELECT * INTO prev FROM ledger.checkpoint ORDER BY cp_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.cp_seq <> 1 THEN
      RAISE EXCEPTION 'first checkpoint must have cp_seq 1' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.cp_seq <> prev.cp_seq + 1 OR NEW.to_ledger_seq < prev.to_ledger_seq THEN
    RAISE EXCEPTION 'checkpoints advance by one and never shrink' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO covered FROM ledger.ledger_entry WHERE ledger_seq = NEW.to_ledger_seq;
  IF NOT FOUND OR covered.entry_hash <> NEW.head_hash THEN
    RAISE EXCEPTION 'checkpoint head_hash is not the entry_hash of entry %', NEW.to_ledger_seq
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER checkpoint_chain BEFORE INSERT ON ledger.checkpoint
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_checkpoint();
CREATE TRIGGER checkpoint_no_update_delete BEFORE UPDATE OR DELETE ON ledger.checkpoint
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER checkpoint_no_truncate BEFORE TRUNCATE ON ledger.checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();

GRANT SELECT, INSERT ON ledger.checkpoint TO aisdlc_app;
