-- gate-check (PLAN M14.5; docs/specs/gate-check-api.md): the verdicts it wrote as `aisdlc/gate` and the merges it
-- observed, as read models of the `gatecheck.*` events on the `gatecheck:<repo>#<pr>` record streams. Rebuildable from
-- the record alone (`rebuildGateCheck`): each event carries the whole verdict or merge.
--
-- Least privilege. gate-check is in the gate plane (AR9): it has no route to core's write or command APIs and no core
-- HTTP API at all; it reads the record, the ledger and four of core's read models directly, as the login role
-- `gate_check` (db-init), a member of the NOLOGIN group role below, which can do exactly this:
--
--   gatecheck.verdict, gatecheck.merge,  SELECT and INSERT (an event is folded once; never UPDATE or DELETE)
--   gatecheck.repo_watch
--   record.record_event                  SELECT and INSERT of `gatecheck:%` streams, SELECT of `gate:%` streams (the
--                                        G3 instance of an item: `gate.opened`) and of each item's `item.created`
--                                        (the gating profile and tier it pinned: whether its lane's route has G3), all
--                                        by row-level security; never UPDATE or DELETE
--   record.global_counter                SELECT and UPDATE: every append locks this one row and moves it forward
--   ledger.ledger_entry                  SELECT: gate status is a fold of ledger decisions, never of a projection
--   config.genuine_publish               SELECT: the published bypass list (`codehost.merge_bypass`), nothing else of
--                                        config
--   core.repo                            SELECT: the registered repos, their project and onboarding level (S0)
--   core.pull_request, core.push_receipt SELECT: which PRs and heads the Push Broker wrote (agent PR, laundering)
--   core.evidence_pack                   SELECT: where the signed pack of a head is (its bytes are verified here, with
--                                        the Notary's public key: core's word that it passed is not taken)
--
-- and nothing else: no identity, knowledge, decisions or inbox table, no DDL.

CREATE SCHEMA IF NOT EXISTS gatecheck;

CREATE TABLE gatecheck.verdict (
  repo_key        text        NOT NULL,
  pr_number       integer     NOT NULL CHECK (pr_number >= 1),
  -- the stream seq of the event: the order the verdicts of one PR were given in
  seq             integer     NOT NULL CHECK (seq >= 1),
  head_sha        text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  profile         text        NOT NULL CHECK (profile IN ('agent', 's0', 'non_agent')),
  outcome         text        NOT NULL CHECK (outcome IN ('success', 'failure', 'action_required', 'pending')),
  reason          text        NOT NULL,
  project_id      text        NOT NULL,
  item_id         uuid,
  pack_sha256     text        CHECK (pack_sha256 ~ '^[0-9a-f]{64}$'),
  verdict_sha256  text        NOT NULL CHECK (verdict_sha256 ~ '^[0-9a-f]{64}$'),
  -- the verdict written as the check run on this head: this PR's own, or a stricter one of another open PR there
  check_verdict_sha256 text   NOT NULL CHECK (check_verdict_sha256 ~ '^[0-9a-f]{64}$'),
  check_run_id    bigint,
  verdict         jsonb       NOT NULL,
  event_gseq      bigint      NOT NULL,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (repo_key, pr_number, seq)
);
CREATE INDEX verdict_item_idx ON gatecheck.verdict (item_id, event_gseq);
CREATE INDEX verdict_head_idx ON gatecheck.verdict (repo_key, head_sha);

CREATE TABLE gatecheck.merge (
  merge_id          uuid        PRIMARY KEY,
  repo_key          text        NOT NULL,
  project_id        text        NOT NULL,
  pr_number         integer     NOT NULL,
  head_sha          text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  class             text        NOT NULL CHECK (class IN ('gated', 'bypass', 'unauthorised', 'pre_watch')),
  merged_by         text,
  bypass_principal  text,
  item_id           uuid,
  payload           jsonb       NOT NULL,
  event_gseq        bigint      NOT NULL,
  recorded_at       timestamptz NOT NULL
);
CREATE INDEX merge_repo_idx ON gatecheck.merge (repo_key, event_gseq);

-- When gate-check started watching each repo (`gatecheck.repo_watched`, once per repo): a merge before it is
-- `pre_watch` (recorded, never classed, never reviewed).
CREATE TABLE gatecheck.repo_watch (
  repo_key        text        PRIMARY KEY,
  project_id      text        NOT NULL,
  watched_at      timestamptz NOT NULL,
  default_branch  text        NOT NULL,
  head_sha        text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  event_gseq      bigint      NOT NULL
);

DO $$
BEGIN
  CREATE ROLE aisdlc_gatecheck NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA gatecheck, record, ledger, config, core TO aisdlc_gatecheck;
GRANT SELECT, INSERT ON gatecheck.verdict, gatecheck.merge, gatecheck.repo_watch TO aisdlc_gatecheck;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_gatecheck;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_gatecheck;
GRANT SELECT ON ledger.ledger_entry TO aisdlc_gatecheck;
GRANT SELECT ON config.genuine_publish TO aisdlc_gatecheck;
GRANT SELECT ON core.repo, core.pull_request, core.push_receipt, core.evidence_pack TO aisdlc_gatecheck;

-- The record's row-level security (enabled by the gateway migration, which runs before this one in the plan).
CREATE POLICY record_event_gatecheck_read ON record.record_event
  FOR SELECT TO aisdlc_gatecheck USING (
    stream LIKE 'gatecheck:%' OR stream LIKE 'gate:%' OR (stream LIKE 'item:%' AND type = 'item.created')
  );
CREATE POLICY record_event_gatecheck_append ON record.record_event
  FOR INSERT TO aisdlc_gatecheck WITH CHECK (stream LIKE 'gatecheck:%');

-- core (the owner) reads the merges for X4; its app role reads the read models too.
GRANT USAGE ON SCHEMA gatecheck TO aisdlc_app;
GRANT SELECT ON gatecheck.verdict, gatecheck.merge, gatecheck.repo_watch TO aisdlc_app;
