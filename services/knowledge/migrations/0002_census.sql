-- Census read model (PLAN M6.5). A pure fold of `census.assembled` events on the
-- `census:<repo_id>:<baseline_sha>` record streams (drop the table, refold, same rows). The census
-- holds counts only where secrets are concerned: no finding, fingerprint, rule, path or commit.

CREATE TABLE knowledge.census (
  stream        text        NOT NULL,
  seq           bigint      NOT NULL CHECK (seq >= 1),
  global_seq    bigint      NOT NULL CHECK (global_seq >= 1),
  repo          text        NOT NULL,
  baseline_sha  text        NOT NULL CHECK (baseline_sha ~ '^[0-9a-f]{40}$'),
  census_hash   text        NOT NULL CHECK (census_hash ~ '^[0-9a-f]{64}$'),
  job_id        uuid        NOT NULL,
  assembled_at  timestamptz NOT NULL,
  census        jsonb       NOT NULL,
  PRIMARY KEY (stream, seq),
  UNIQUE (global_seq)
);
CREATE INDEX census_repo_idx ON knowledge.census (repo, global_seq DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.census TO aisdlc_app;
