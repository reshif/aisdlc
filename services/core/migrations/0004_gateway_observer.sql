-- Core: where the gateway observer stopped (PLAN M10.3). The gateway appends `gateway.budget_exhausted`
-- (ET1) events to the record; core reads them in `global_seq` order and fires the item's trigger. The
-- cursor is only an optimisation: every trigger carries an idempotency key, so a lost cursor replays
-- harmlessly. Needs the record schema and 0001_core.

CREATE TABLE core.observer_cursor (
  name       text        PRIMARY KEY,
  global_seq bigint      NOT NULL CHECK (global_seq >= 0),
  updated_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON core.observer_cursor TO aisdlc_app;
