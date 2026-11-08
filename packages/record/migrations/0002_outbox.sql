-- Transactional outbox (PLAN principle 3, inbox first): rows are written in the same transaction as
-- the event that causes them and dispatched afterwards, at least once, keyed for consumer dedupe.

CREATE TABLE record.outbox (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination     text        NOT NULL CHECK (destination <> ''),
  payload         jsonb       NOT NULL,
  idempotency_key text        NOT NULL CHECK (idempotency_key <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  CONSTRAINT outbox_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX outbox_pending ON record.outbox (destination, id) WHERE dispatched_at IS NULL;

-- Only delivery bookkeeping may change; what is delivered, where and under which key may not.
CREATE FUNCTION record.guard_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.destination = OLD.destination
     AND NEW.payload = OLD.payload
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.created_at = OLD.created_at
     AND (OLD.dispatched_at IS NULL OR NEW.dispatched_at = OLD.dispatched_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record.outbox rows are immutable except delivery bookkeeping (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER outbox_guard
  BEFORE UPDATE OR DELETE ON record.outbox
  FOR EACH ROW EXECUTE FUNCTION record.guard_outbox();

CREATE TRIGGER outbox_no_truncate
  BEFORE TRUNCATE ON record.outbox
  FOR EACH STATEMENT EXECUTE FUNCTION record.reject_mutation();

GRANT SELECT, INSERT, UPDATE ON record.outbox TO aisdlc_app;
