-- Repository search index (PLAN M12.1 2.1b). A rebuildable CACHE, not a read model of the record: the text
-- of a repository's head tree as of the census job that ran last, so an agent's read-only `KnowledgeSearch`
-- can answer without a mirror. Re-running the census rebuilds it; it holds no secret (a file the shared
-- secret ruleset hits is not indexed) and is only ever replaced whole, per repository, in one transaction.
-- One index per repository, at one commit: a search names the commit it needs and gets nothing from any other.

CREATE TABLE knowledge.repo_index (
  repo        text        PRIMARY KEY,
  commit_sha  text        NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  job_id      uuid        NOT NULL,
  files       integer     NOT NULL CHECK (files >= 0),
  bytes       bigint      NOT NULL CHECK (bytes >= 0),
  skipped     integer     NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  indexed_at  timestamptz NOT NULL
);

CREATE TABLE knowledge.repo_file (
  repo       text    NOT NULL REFERENCES knowledge.repo_index (repo) ON DELETE CASCADE,
  path       text    NOT NULL,
  blob_sha   text    NOT NULL CHECK (blob_sha ~ '^[0-9a-f]{40}$'),
  content    text    NOT NULL,
  PRIMARY KEY (repo, path)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.repo_index, knowledge.repo_file TO aisdlc_app;
