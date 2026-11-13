-- Redaction of ledger entries (owner decision 2026-11-13, "delete means delete"; docs/specs/deletion.md §2, §4).
--
-- Deleting an object keeps each of its ledger entries' place in the chain and erases what the entry said: the
-- hash, the link, the seq, the entry id, the Notary signature and created_at stay; the rest is erased. The chain
-- still verifies from the stored hashes (`verifyLedger(..., {allowRedacted})`), and every redacted entry must be
-- named by a later, fully verified `deletion.performed` entry.
--
-- Two shapes, and nothing else, are accepted, and only while the current role is aisdlc_purge (record/0005_purge.sql):
--   full   entry_type 'redacted', every gate/subject/decision/actor column NULL, sod_waiver false,
--          policy_bundle_version 'redacted', body {}.
--   actor  a person's decision on something that is not deleted (docs/specs/deletion.md §3 "Person"): the gate
--          columns and the decision kept so the gate's fold does not change, actor replaced by a `deleted.` id,
--          the body cut to the keys the fold reads (kind, superseded_by, quorum_required, approvals_after, override).
-- A DELETE is never accepted, and a checkpoint never changes.

DO $$
BEGIN
  CREATE ROLE aisdlc_purge NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

ALTER TABLE ledger.ledger_entry ADD COLUMN redacted_at timestamptz;
ALTER TABLE ledger.ledger_entry ADD COLUMN redaction_id uuid;
ALTER TABLE ledger.ledger_entry ADD CONSTRAINT ledger_entry_redaction_pair
  CHECK ((redacted_at IS NULL) = (redaction_id IS NULL));

CREATE FUNCTION ledger.guard_redaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  same_place boolean;
  full_shape boolean;
  actor_shape boolean;
BEGIN
  -- The purge role must be the current role (`SET LOCAL ROLE aisdlc_purge`), never just one the login could take.
  IF TG_OP = 'UPDATE' AND current_user = 'aisdlc_purge' THEN
    same_place := NEW.ledger_seq = OLD.ledger_seq AND NEW.entry_id = OLD.entry_id
      AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash AND NEW.entry_hash = OLD.entry_hash
      AND NEW.notary_key_id = OLD.notary_key_id AND NEW.notary_alg = OLD.notary_alg
      AND NEW.notary_sig = OLD.notary_sig AND NEW.created_at = OLD.created_at
      AND NEW.redacted_at IS NOT NULL AND NEW.redaction_id IS NOT NULL;
    full_shape := NEW.entry_type = 'redacted' AND NEW.gate_instance_id IS NULL AND NEW.gate_id IS NULL
      AND NEW.subject_kind IS NULL AND NEW.subject_id IS NULL AND NEW.subject_hash IS NULL
      AND NEW.decision IS NULL AND NEW.actor IS NULL AND NEW.sod_waiver = false
      AND NEW.policy_bundle_version = 'redacted' AND NEW.body = '{}'::jsonb;
    actor_shape := OLD.redacted_at IS NULL
      AND NEW.entry_type = OLD.entry_type
      AND NEW.gate_instance_id IS NOT DISTINCT FROM OLD.gate_instance_id
      AND NEW.gate_id IS NOT DISTINCT FROM OLD.gate_id
      AND NEW.subject_kind IS NOT DISTINCT FROM OLD.subject_kind
      AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
      AND NEW.subject_hash IS NOT DISTINCT FROM OLD.subject_hash
      AND NEW.decision IS NOT DISTINCT FROM OLD.decision
      AND NEW.sod_waiver = OLD.sod_waiver
      AND NEW.policy_bundle_version = OLD.policy_bundle_version
      AND NEW.actor ~ '^deleted\.[0-9a-f]{16}$'
      AND (NEW.body - ARRAY['kind', 'superseded_by', 'quorum_required', 'approvals_after', 'override'])
          = '{}'::jsonb;
    IF same_place AND (full_shape OR actor_shape) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DROP TRIGGER ledger_entry_no_update_delete ON ledger.ledger_entry;
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER ledger_entry_redact_only BEFORE UPDATE ON ledger.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_redaction();

GRANT USAGE ON SCHEMA ledger TO aisdlc_purge;
GRANT SELECT, UPDATE ON ledger.ledger_entry TO aisdlc_purge;
GRANT SELECT ON ledger.checkpoint TO aisdlc_purge;
