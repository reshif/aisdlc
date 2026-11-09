-- One row per budget reservation (PLAN M10 follow-up: reservation leak on crash). Until now a
-- reservation was only a counter on the budget group, so a process that died between `reserve` and
-- `settle` left `reserved_*` raised for ever and no one could tell whose it was. Now every reservation
-- is a row, and a recovery sweep settles the ones older than a bound as `abandoned`.
--
--   open       the call is in flight (or its process died)
--   settled    the call settled: its hold was released and its usage added
--   abandoned  the sweep released the hold; if the call completes later, it adds its usage and releases
--              nothing (the status, not a counter, says whether the hold is still there)

CREATE TABLE gateway.reservation (
  reservation_id uuid        PRIMARY KEY,
  budget_group   text        NOT NULL REFERENCES gateway.budget_group (group_id),
  vkey_id        uuid        NOT NULL,
  tokens         bigint      NOT NULL CHECK (tokens >= 0),
  cost_micro_usd bigint      NOT NULL CHECK (cost_micro_usd >= 0),
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'abandoned')),
  reserved_at    timestamptz NOT NULL,
  closed_at      timestamptz
);
CREATE INDEX reservation_open_idx ON gateway.reservation (reserved_at) WHERE status = 'open';
CREATE INDEX reservation_group_idx ON gateway.reservation (budget_group);

GRANT SELECT, INSERT, UPDATE ON gateway.reservation TO aisdlc_app;
