-- The Notary's own database (PLAN M2.3): its ledger sequence and a journal of everything it
-- reserved, signed and saw committed. Separate from the record database on purpose: a compromised
-- core cannot rewrite what the Notary remembers having signed.
--
-- journal.status moves only forward: reserved -> signed -> committed. A `reserved` row may be
-- re-reserved (superseded) because nothing was signed for it. Once `signed` the entry, its hash
-- and its signature are fixed. Rows are never deleted.

CREATE SCHEMA notary;

CREATE FUNCTION notary.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- One row: the last signed entry. Forward only, one step at a time.
CREATE TABLE notary.state (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seq  bigint  NOT NULL CHECK (last_seq >= 0),
  last_hash text    CHECK (last_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((last_seq = 0) = (last_hash IS NULL))
);
INSERT INTO notary.state (id, last_seq, last_hash) VALUES (true, 0, NULL);

CREATE FUNCTION notary.guard_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_seq = OLD.last_seq + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notary.state moves forward one entry at a time (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER state_forward_only BEFORE UPDATE OR DELETE ON notary.state
  FOR EACH ROW EXECUTE FUNCTION notary.guard_state();
CREATE TRIGGER state_no_truncate BEFORE TRUNCATE ON notary.state
  FOR EACH STATEMENT EXECUTE FUNCTION notary.reject_mutation();

CREATE TABLE notary.journal (
  ledger_seq   bigint      PRIMARY KEY CHECK (ledger_seq >= 1),
  status       text        NOT NULL CHECK (status IN ('reserved', 'signed', 'committed')),
  prev_hash    text        CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  body_hash    text        NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  entry_hash   text        CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  -- The full LedgerEntry as signed, so a reconciler can insert it after a crash.
  entry        jsonb       CHECK (jsonb_typeof(entry) = 'object'),
  key_id       text,
  reserved_at  timestamptz NOT NULL,
  signed_at    timestamptz,
  committed_at timestamptz,
  CHECK ((ledger_seq = 1) = (prev_hash IS NULL)),
  CHECK ((status = 'reserved') = (entry_hash IS NULL AND entry IS NULL AND key_id IS NULL AND signed_at IS NULL)),
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
-- No two signed entries may share a predecessor: a fork is impossible.
CREATE UNIQUE INDEX journal_prev_hash_signed ON notary.journal (prev_hash) WHERE entry_hash IS NOT NULL;
CREATE UNIQUE INDEX journal_entry_hash ON notary.journal (entry_hash) WHERE entry_hash IS NOT NULL;

CREATE FUNCTION notary.guard_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ledger_seq = OLD.ledger_seq THEN
    IF OLD.status = 'reserved' AND NEW.status = 'reserved' THEN
      RETURN NEW; -- superseded reservation
    ELSIF OLD.status = 'reserved' AND NEW.status = 'signed'
          AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
          AND NEW.body_hash = OLD.body_hash AND NEW.reserved_at = OLD.reserved_at THEN
      RETURN NEW;
    ELSIF OLD.status = 'signed' AND NEW.status = 'committed'
          AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash AND NEW.body_hash = OLD.body_hash
          AND NEW.entry_hash = OLD.entry_hash AND NEW.entry = OLD.entry
          AND NEW.key_id = OLD.key_id AND NEW.reserved_at = OLD.reserved_at
          AND NEW.signed_at = OLD.signed_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'notary.journal row change refused (% from %)', TG_OP, OLD.status
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER journal_guard BEFORE UPDATE OR DELETE ON notary.journal
  FOR EACH ROW EXECUTE FUNCTION notary.guard_journal();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON notary.journal
  FOR EACH STATEMENT EXECUTE FUNCTION notary.reject_mutation();

-- Every checkpoint the Notary signed. The same cp_seq may appear twice (a retry after a failure);
-- the Witness decides which one is co-signed.
CREATE TABLE notary.checkpoint_journal (
  id            bigserial   PRIMARY KEY,
  cp_seq        bigint      NOT NULL CHECK (cp_seq >= 1),
  to_ledger_seq bigint      NOT NULL CHECK (to_ledger_seq >= 1),
  root_hash     text        NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  head_hash     text        NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  created_at    text        NOT NULL,
  signature     jsonb       NOT NULL,
  signed_at     timestamptz NOT NULL
);
CREATE TRIGGER checkpoint_journal_append_only BEFORE UPDATE OR DELETE ON notary.checkpoint_journal
  FOR EACH ROW EXECUTE FUNCTION notary.reject_mutation();
CREATE TRIGGER checkpoint_journal_no_truncate BEFORE TRUNCATE ON notary.checkpoint_journal
  FOR EACH STATEMENT EXECUTE FUNCTION notary.reject_mutation();
