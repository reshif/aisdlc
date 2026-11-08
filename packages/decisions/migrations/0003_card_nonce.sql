-- PreparedDecision for a card that carries no gate (the S0 step cards, PLAN M7.3). A gate nonce is
-- bound to a gate instance; this one is bound to the card and to the evidence hash the person is
-- shown. Server state like `gate_nonce`: not a projection, not rebuilt.

CREATE TABLE decisions.card_nonce (
  nonce_sha256        text        PRIMARY KEY CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  card_id             uuid        NOT NULL,
  principal           text        NOT NULL,
  evidence_hash       text        NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_viewed_at  timestamptz,
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX card_nonce_card_idx ON decisions.card_nonce (card_id);

GRANT SELECT, INSERT, UPDATE ON decisions.card_nonce TO aisdlc_app;
