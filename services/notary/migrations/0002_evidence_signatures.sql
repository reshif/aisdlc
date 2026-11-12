-- The Notary's second signing purpose (PLAN M14.4): Evidence Packs. Every pack id it signed, with the item and head
-- the caller named, the key and the signature, append-only (a compromised core cannot make the Notary forget a pack it
-- signed). One row per pack id: asking again answers the same signature; the same id with another item or head is
-- refused by the service.

CREATE TABLE notary.evidence_signature (
  pack_sha256 text        PRIMARY KEY CHECK (pack_sha256 ~ '^[0-9a-f]{64}$'),
  item_id     text        NOT NULL,
  head_sha    text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  key_id      text        NOT NULL,
  signature   jsonb       NOT NULL,
  signed_at   timestamptz NOT NULL
);
CREATE TRIGGER evidence_signature_append_only BEFORE UPDATE OR DELETE ON notary.evidence_signature
  FOR EACH ROW EXECUTE FUNCTION notary.reject_mutation();
CREATE TRIGGER evidence_signature_no_truncate BEFORE TRUNCATE ON notary.evidence_signature
  FOR EACH STATEMENT EXECUTE FUNCTION notary.reject_mutation();
