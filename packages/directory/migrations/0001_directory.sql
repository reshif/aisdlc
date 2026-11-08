-- The directory: Principal and Team read models in core's domain (PLAN M4.2, DM §8 gap 10).
-- Both tables are a pure fold of the identity journal on the record (`principal:` and `team:`
-- streams); dropping them and refolding gives the same rows. Needs the record schema only.

CREATE SCHEMA directory;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA directory TO aisdlc_app;

CREATE TABLE directory.principal (
  principal_id      text        PRIMARY KEY,
  handle            text        NOT NULL,
  display           text        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('human', 'service')),
  status            text        NOT NULL CHECK (status IN ('active', 'disabled', 'deleted'))
);
CREATE INDEX directory_principal_handle_idx ON directory.principal ((lower(handle)));

CREATE TABLE directory.team (
  team_id        text PRIMARY KEY,
  name           text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('internal', 'confidential')),
  idp_group      text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON directory.principal, directory.team TO aisdlc_app;
