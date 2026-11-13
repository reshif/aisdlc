-- Deletion's redaction under row-level security (docs/specs/deletion.md §2, §4).
--
-- The audit migration (services/audit/migrations/0001_audit.sql) turns on row-level security for ledger.ledger_entry
-- with policies for SELECT and INSERT only. An UPDATE under RLS that no policy allows touches no row and raises
-- nothing, so the purge role's redaction (0002) silently left every entry as it was in a deployed stack (the tests'
-- owner and superuser sessions bypass RLS). This is the one UPDATE policy: the purge role, on an entry not yet
-- redacted, to a row that is redacted. The trigger of 0002 still decides the shape (hashes, seq, signature and
-- created_at unchanged; only the redacted forms) and that the purge role is the current role. Created here, before
-- RLS is on; it takes effect when the audit migration enables it.
CREATE POLICY ledger_entry_purge_redact ON ledger.ledger_entry
  FOR UPDATE TO aisdlc_purge
  USING (redacted_at IS NULL)
  WITH CHECK (redacted_at IS NOT NULL);
