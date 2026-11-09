-- Model gateway (PLAN M10.3): virtual keys and budget groups. Needs the record schema: the gateway
-- appends `gateway.*` events (ModelCall, ET1, key minted and revoked) to the record in the same
-- transaction that settles a budget, so a call is metered or it did not happen.
--
-- A virtual key is stored by the sha256 of its secret only; the secret is returned once, at mint.
-- A budget group's usage lives here and is only ever moved by the gateway: `reserved_*` is what calls
-- in flight may still spend (so two concurrent calls cannot both spend the last token), `used_*` is
-- what settled calls spent, and `exhausted_at` is the hard stop.

CREATE SCHEMA gateway;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA gateway TO aisdlc_app;

CREATE TABLE gateway.budget_group (
  group_id                text        PRIMARY KEY,
  max_tokens              bigint      NOT NULL CHECK (max_tokens > 0),
  max_cost_micro_usd      bigint      NOT NULL CHECK (max_cost_micro_usd > 0),
  used_tokens             bigint      NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  used_cost_micro_usd     bigint      NOT NULL DEFAULT 0 CHECK (used_cost_micro_usd >= 0),
  reserved_tokens         bigint      NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  reserved_cost_micro_usd bigint      NOT NULL DEFAULT 0 CHECK (reserved_cost_micro_usd >= 0),
  exhausted_at            timestamptz,
  created_at              timestamptz NOT NULL
);

CREATE TABLE gateway.vkey (
  vkey_id       uuid        PRIMARY KEY,
  key_hash      text        NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scope_kind    text        NOT NULL CHECK (scope_kind IN ('unit', 'job', 'session')),
  scope_ref     text        NOT NULL,
  project_id    text        NOT NULL,
  lane          text,
  data_class_max text       NOT NULL CHECK (data_class_max IN ('D0', 'D1', 'D2', 'D3')),
  models        text[]      NOT NULL,
  tools         text[]      NOT NULL,
  budget_group  text        NOT NULL REFERENCES gateway.budget_group (group_id),
  item_id       text,
  unit_id       text,
  step          text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL,
  minted_by     text        NOT NULL
);
CREATE INDEX vkey_budget_group_idx ON gateway.vkey (budget_group);

GRANT SELECT, INSERT, UPDATE ON gateway.budget_group, gateway.vkey TO aisdlc_app;
