-- Core: the Projects and Onboarding context (PLAN M7.1, M7.2). Needs the record schema.
--
-- `project`, `repo`, `s0_record` and `s0_step` are the `core` read model: a pure fold of the record
-- streams `project:<id>`, `repo:<owner/name>` and `s0:<uuid>`. Dropping the tables and refolding
-- gives the same rows. `role_map_sync` is not a read model: it is the role-map sync loop's own
-- position (which published settings revision identity has been told about), and an optimisation
-- that can be emptied without changing anything but a repeat of identity's idempotent reconcile.

CREATE SCHEMA core;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA core TO aisdlc_app;

CREATE TABLE core.project (
  project_id     text        PRIMARY KEY,
  name           text        NOT NULL,
  team_id        text,
  classification text        NOT NULL CHECK (classification IN ('internal', 'confidential')),
  stack          text,
  deploys        boolean,
  tier           text        CHECK (tier IN ('T0', 'T1', 'T2')),
  level          text        CHECK (level IN ('census', 'light', 'full')),
  owner          text,
  -- Raise-only attestations given with onboarding requests, folded: the highest of each.
  attestations   jsonb       NOT NULL,
  version        integer     NOT NULL CHECK (version >= 1),
  updated_at     timestamptz NOT NULL
);

CREATE TABLE core.repo (
  -- owner/name without case: the key every lookup uses.
  repo_key         text        PRIMARY KEY,
  repo_id          text        NOT NULL,
  repo_ref         text        NOT NULL,
  project_id       text        NOT NULL,
  host             text        NOT NULL,
  owner            text        NOT NULL,
  name             text        NOT NULL,
  visibility       text        CHECK (visibility IN ('public', 'private', 'internal')),
  owner_type       text        CHECK (owner_type IN ('user', 'org')),
  plan             text,
  default_branch   text,
  stack            text,
  onboarding_level text        NOT NULL CHECK (onboarding_level IN ('none', 'census', 'light', 'full'))
);
CREATE INDEX repo_project_idx ON core.repo (project_id);

CREATE TABLE core.s0_record (
  s0_id             uuid        PRIMARY KEY,
  project_id        text        NOT NULL,
  repo_key          text        NOT NULL,
  repo_id           text        NOT NULL,
  status            text        NOT NULL CHECK (status IN
    ('app', 'running', 'card', 'blocked', 'starter', 'parked', 'done', 'rejected', 'superseded', 'withdrawn')),
  requested_level   text        NOT NULL CHECK (requested_level IN ('census', 'light', 'full')),
  signable_level    text        NOT NULL CHECK (signable_level IN ('census', 'light', 'full')),
  intake_ref        text        NOT NULL CHECK (intake_ref ~ '^record:\S+$'),
  rejected_at       text        CHECK (rejected_at IN ('0.1', '0.2', '0.3', '0.4', '0.5')),
  readiness_version integer,
  catalogue_version text        NOT NULL,
  catalogue_hash    text        NOT NULL CHECK (catalogue_hash ~ '^[0-9a-f]{64}$'),
  waiting           text,
  version           integer     NOT NULL CHECK (version >= 1),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX s0_record_repo_idx ON core.s0_record (repo_key, created_at);
CREATE INDEX s0_record_status_idx ON core.s0_record (status);

CREATE TABLE core.s0_step (
  s0_id         uuid        NOT NULL,
  step          text        NOT NULL CHECK (step IN ('0.1', '0.2', '0.3', '0.4', '0.5')),
  state         text        NOT NULL CHECK (state IN ('todo', 'running', 'card', 'blocked', 'done', 'skip')),
  blocked_cause text,
  started_at    timestamptz,
  finished_at   timestamptz,
  send_backs    integer     NOT NULL DEFAULT 0 CHECK (send_backs >= 0),
  failures      integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (s0_id, step),
  CHECK ((state = 'blocked') = (blocked_cause IS NOT NULL))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.project, core.repo, core.s0_record, core.s0_step TO aisdlc_app;

-- The role-map sync loop's position: the settings revision of each project that identity has
-- reconciled. A row is written only after identity answered, so a failed call is retried.
CREATE TABLE core.role_map_sync (
  project_id      text        PRIMARY KEY,
  rev_hash        text        NOT NULL CHECK (rev_hash ~ '^[0-9a-f]{64}$'),
  ledger_entry_id uuid        NOT NULL,
  reconciled_at   timestamptz NOT NULL,
  report          jsonb       NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON core.role_map_sync TO aisdlc_app;

-- Lookups of the authoritative streams by what they name.
CREATE INDEX core_s0_requested_idx ON record.record_event ((body ->> 's0_id'))
  WHERE type = 's0.requested';
CREATE INDEX core_s0_repo_idx ON record.record_event ((lower(body ->> 'repo')))
  WHERE type = 's0.requested';
