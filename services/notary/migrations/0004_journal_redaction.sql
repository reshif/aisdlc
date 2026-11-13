-- Delete means delete (owner decision 2026-11-13; docs/specs/deletion.md §1). The journal keeps a copy of every entry
-- the Notary signed; a deletion erases the copies of the entries it redacted in the ledger. One more change is
-- accepted, and only this one: a committed row's `entry` becomes {"redacted": true}, its seq, status, hashes, key and
-- times unchanged. The service makes it only for the entries a deletion.performed entry it signed itself names.

CREATE OR REPLACE FUNCTION notary.guard_journal() RETURNS trigger
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
    ELSIF OLD.status = 'committed' AND NEW.status = 'committed'
          AND NEW.entry = '{"redacted": true}'::jsonb
          AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash AND NEW.body_hash = OLD.body_hash
          AND NEW.entry_hash = OLD.entry_hash AND NEW.key_id = OLD.key_id
          AND NEW.reserved_at = OLD.reserved_at AND NEW.signed_at = OLD.signed_at
          AND NEW.committed_at = OLD.committed_at THEN
      RETURN NEW; -- a deletion erased the copy
    END IF;
  END IF;
  RAISE EXCEPTION 'notary.journal row change refused (% from %)', TG_OP, OLD.status
    USING ERRCODE = 'restrict_violation';
END
$$;
