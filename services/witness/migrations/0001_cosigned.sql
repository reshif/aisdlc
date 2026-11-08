-- The Witness's own database (PLAN M2.4): every checkpoint it co-signed and the compact Merkle
-- range (frontier) of the tree at that point. It does not hold the ledger; it holds just enough to
-- check that the next checkpoint extends the last one. Separate from the record database and from
-- the Notary's, so rewriting history needs a compromise of all three.

CREATE SCHEMA witness;

CREATE FUNCTION witness.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TABLE witness.cosigned (
  cp_seq        bigint      PRIMARY KEY CHECK (cp_seq >= 1),
  to_ledger_seq bigint      NOT NULL CHECK (to_ledger_seq >= 1),
  root_hash     text        NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  head_hash     text        NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  -- {size, peaks[]}: the RFC 6962 compact range over entries 1..to_ledger_seq.
  frontier      jsonb       NOT NULL CHECK (jsonb_typeof(frontier) = 'object'),
  -- The full checkpoint with both signatures, as returned to the caller.
  checkpoint    jsonb       NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  cosigned_at   timestamptz NOT NULL
);

-- cp_seq has no gaps and the tree never shrinks, whatever the application does.
CREATE FUNCTION witness.guard_cosigned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev witness.cosigned;
BEGIN
  SELECT * INTO prev FROM witness.cosigned ORDER BY cp_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.cp_seq <> 1 THEN
      RAISE EXCEPTION 'first co-signed checkpoint must have cp_seq 1' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.cp_seq <> prev.cp_seq + 1 OR NEW.to_ledger_seq < prev.to_ledger_seq THEN
    RAISE EXCEPTION 'co-signed checkpoints must advance by one and never shrink'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cosigned_chain BEFORE INSERT ON witness.cosigned
  FOR EACH ROW EXECUTE FUNCTION witness.guard_cosigned();
CREATE TRIGGER cosigned_no_update_delete BEFORE UPDATE OR DELETE ON witness.cosigned
  FOR EACH ROW EXECUTE FUNCTION witness.reject_mutation();
CREATE TRIGGER cosigned_no_truncate BEFORE TRUNCATE ON witness.cosigned
  FOR EACH STATEMENT EXECUTE FUNCTION witness.reject_mutation();
