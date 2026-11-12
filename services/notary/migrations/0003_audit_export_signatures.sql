-- The Notary's third signing purpose (PLAN M19): signed audit exports. Every export id it signed, with the scope the
-- caller named, the key and the signature, append-only (a compromised audit service cannot make the Notary forget an
-- export it signed). One row per export id: asking again answers the same signature; the same id with another scope is
-- refused by the service.

CREATE TABLE notary.audit_export_signature (
  export_sha256 text        PRIMARY KEY CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  scope_ref     text        NOT NULL,
  key_id        text        NOT NULL,
  signature     jsonb       NOT NULL,
  signed_at     timestamptz NOT NULL
);
CREATE TRIGGER audit_export_signature_append_only BEFORE UPDATE OR DELETE ON notary.audit_export_signature
  FOR EACH ROW EXECUTE FUNCTION notary.reject_mutation();
CREATE TRIGGER audit_export_signature_no_truncate BEFORE TRUNCATE ON notary.audit_export_signature
  FOR EACH STATEMENT EXECUTE FUNCTION notary.reject_mutation();
