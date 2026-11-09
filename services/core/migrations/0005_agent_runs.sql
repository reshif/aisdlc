-- Core: agent runs (PLAN M11.2). Needs the record schema and 0001_core.
--
-- `agent_run` and `agent_call` are read models: a pure fold (`@aisdlc/agents` `foldAgentRuns`) of
--   a) the dispatches core records on `agent:<item>` and the results on `item:<item>` streams,
--   b) the gateway's `gateway.model_call` events (no text), kept in `agent_call`,
--   c) core's own failures (`agent.run_failed`).
-- Dropping both tables and refolding the record gives the same rows (the rebuild test does exactly
-- that). Nothing writes them but the projection, and no write path reads them.

CREATE TABLE core.agent_run (
  run_id          uuid        PRIMARY KEY,
  item_id         uuid        NOT NULL,
  project_id      text        NOT NULL,
  -- the order the item's runs were dispatched in
  ord             integer     NOT NULL CHECK (ord >= 0),
  unit_id         text,
  step            text        NOT NULL,
  attempt         integer     NOT NULL CHECK (attempt >= 1),
  lane            text        NOT NULL,
  agent_id        text        NOT NULL,
  contract_version text       NOT NULL,
  prompt_ref      text        NOT NULL,
  prompt_sha256   text        NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  provider        text,
  model           text,
  vkey_id         text,
  calls           integer     NOT NULL DEFAULT 0 CHECK (calls >= 0),
  tokens_in       bigint      NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out      bigint      NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_micro_usd  bigint      NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  state           text        NOT NULL CHECK (state IN ('dispatched', 'finished', 'failed')),
  result          text,
  failure_code    text,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  -- AgentRunOutcome: the verdict is a column (stats), the judgements the evidence behind it
  verdict         text        NOT NULL,
  back_edges      text[]      NOT NULL DEFAULT '{}',
  triggers        text[]      NOT NULL DEFAULT '{}',
  judgements      jsonb       NOT NULL DEFAULT '[]'
);
CREATE INDEX agent_run_item_idx  ON core.agent_run (item_id, ord);
CREATE INDEX agent_run_agent_idx ON core.agent_run (agent_id, project_id);
CREATE INDEX agent_run_vkey_idx  ON core.agent_run (vkey_id) WHERE vkey_id IS NOT NULL;

-- One row per gateway call of a key minted for an item: the facts a run sums.
CREATE TABLE core.agent_call (
  call_id        text        PRIMARY KEY,
  vkey_id        text        NOT NULL,
  item_id        text        NOT NULL,
  global_seq     bigint      NOT NULL,
  tokens_in      bigint      NOT NULL CHECK (tokens_in >= 0),
  tokens_out     bigint      NOT NULL CHECK (tokens_out >= 0),
  cost_micro_usd bigint      NOT NULL CHECK (cost_micro_usd >= 0),
  provider_id    text,
  model_id       text,
  outcome        text        NOT NULL
);
CREATE INDEX agent_call_item_idx ON core.agent_call (item_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.agent_run, core.agent_call TO aisdlc_app;
