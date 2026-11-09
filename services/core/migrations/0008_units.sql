-- Core: the `unit` read model (PLAN M12.4; DM §3.5 Unit, §6.4 "Planned: S5 plan lists Units in DAG order").
-- Needs the record schema and 0001_core.
--
-- It is a READ MODEL: the authority is the `units.planned` event on `planning:<item>`, one per plan, carrying the
-- plan's Units in DAG order with their scope and budget envelope. Core folds each event into these rows in the
-- same transaction and can rebuild the table from the events alone (`rebuildUnits`). A re-plan (B5, a human's
-- plan) is a new event: the item's Units that are still `Planned` are replaced by the new plan's, and a Unit
-- that has moved on (M13: Admitted and after) is never touched by a plan. The columns M13 fills (branch,
-- lease_epoch, head_sha, pr_ref) are NULL until it does; M12 writes `Planned` and nothing else.

CREATE TABLE core.unit (
  item_id      uuid        NOT NULL,
  unit_key     text        NOT NULL CHECK (unit_key ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  -- `<item>:<key>`: the id the rest of the system uses (a branch name `agent/<item>/<key>` in M13)
  unit_id      text        NOT NULL UNIQUE,
  project_id   text        NOT NULL,
  repo         text        NOT NULL,
  title        text        NOT NULL,
  paths        jsonb       NOT NULL,
  size         text        NOT NULL CHECK (size IN ('small', 'medium', 'large')),
  depends_on   jsonb       NOT NULL,
  position     integer     NOT NULL CHECK (position >= 0),
  envelope     jsonb       NOT NULL,
  state        text        NOT NULL DEFAULT 'Planned',
  plan_sha256  text        NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  base_sha     text        NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  branch       text,
  lease_epoch  integer,
  head_sha     text,
  pr_ref       text,
  planned_at   timestamptz NOT NULL,
  PRIMARY KEY (item_id, unit_key)
);
CREATE INDEX unit_project_idx ON core.unit (project_id, state);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.unit TO aisdlc_app;
