-- Core: eval run history (PLAN M11.3). Needs the record schema and 0001_core.
--
-- `eval_run` is a read model: a fold of `eval.run_recorded` events on the `eval:<suite>` streams of the
-- record (the payload is ids, hashes, per-case pass vectors and counts, never a prompt, an input or an
-- output). Dropping the table and refolding the record gives the same rows (the rebuild test does
-- exactly that). Nothing writes it but the projection, and no write path reads it. Evals are
-- factory-wide: `project_tag` is optional and only filters.
--
-- Why the record and not a table of its own authority: a run is a fact that happened, the trend of it
-- is the point, and the rule is that read models are rebuildable from the record (AGENTS.md). The
-- same fold pattern as `agent_run`, so AgentScore can join the two without a second source of truth.

CREATE TABLE core.eval_run (
  eval_run_id      uuid        PRIMARY KEY,
  suite_id         text        NOT NULL,
  project_tag      text,
  agent_id         text        NOT NULL,
  profile          text        NOT NULL,
  prompt_ref       text        NOT NULL,
  prompt_sha256    text        NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  contract_version text        NOT NULL,
  provider         text        NOT NULL,
  model            text        NOT NULL,
  harness_version  text        NOT NULL,
  trigger          text        NOT NULL,
  git_sha          text,
  store_id         text        NOT NULL,
  manifest_digest  text        NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  k                integer     NOT NULL CHECK (k >= 1),
  -- [{case_id, kind, security_tagged, trials: [{trial, passed, failure_code, infra_error, tokens_in, tokens_out, cost_micro_usd}]}]
  cases            jsonb       NOT NULL,
  cost_micro_usd   bigint      NOT NULL CHECK (cost_micro_usd >= 0),
  errored          integer     NOT NULL CHECK (errored >= 0),
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  -- where the fact is in the record (a trend is ordered by it when two runs end together)
  global_seq       bigint      NOT NULL
);
CREATE INDEX eval_run_suite_idx ON core.eval_run (suite_id, ended_at);
CREATE INDEX eval_run_agent_idx ON core.eval_run (agent_id, provider, model);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.eval_run TO aisdlc_app;
