-- RC-SEC-3: who acts at the kill switch is a person the kill switch has verified itself, not a name a
-- service token sent. Every kill, release approval, delegation and revocation carries a step-up proof
-- (signed by the bff's key, checked here with its public key) bound to exactly that act. This table is
-- the kill switch's own single-use ledger of those proofs: a proof is good for one act, once. Append-only.

CREATE TABLE killswitch.person_proof (
  proof_id   uuid        PRIMARY KEY,
  principal  text        NOT NULL,
  action     text        NOT NULL,
  bound_hash text        NOT NULL CHECK (bound_hash ~ '^[0-9a-f]{64}$'),
  method     text        NOT NULL,
  auth_time  timestamptz NOT NULL,
  used_at    timestamptz NOT NULL
);

CREATE TRIGGER person_proof_append_only BEFORE UPDATE OR DELETE ON killswitch.person_proof
  FOR EACH ROW EXECUTE FUNCTION killswitch.reject_mutation();
CREATE TRIGGER person_proof_no_truncate BEFORE TRUNCATE ON killswitch.person_proof
  FOR EACH STATEMENT EXECUTE FUNCTION killswitch.reject_mutation();
