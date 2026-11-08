-- Layered configuration (PLAN M3.5). Needs the record, ledger and decisions schemas.
--
-- Both tables are the `config` read model: a pure fold of the record streams `config:<lineage>`
-- (`config.proposed`, `config.published`). Dropping them and refolding gives the same rows.
-- Neither table is the authority on what is effective: a published row counts only while the
-- ledger holds the decided-approve M1 entry it names, and readers join to the ledger for that.

CREATE SCHEMA config;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA config TO aisdlc_app;

-- A revision is immutable: it is inserted once and never updated (a rebuild deletes and refolds).
CREATE TABLE config.config_revision (
  rev_hash        text        PRIMARY KEY CHECK (rev_hash ~ '^[0-9a-f]{64}$'),
  layer           text        NOT NULL CHECK (layer IN ('factory', 'project')),
  scope_kind      text        NOT NULL,
  scope_ref       text        NOT NULL,
  lineage         text        NOT NULL,
  parent_rev_hash text        CHECK (parent_rev_hash ~ '^[0-9a-f]{64}$'),
  doc             jsonb       NOT NULL CHECK (jsonb_typeof(doc) = 'object'),
  proposed_by     text        NOT NULL,
  proposed_at     timestamptz NOT NULL,
  global_seq      bigint      NOT NULL
);
CREATE INDEX config_revision_lineage_idx ON config.config_revision (lineage, global_seq);

CREATE FUNCTION config.reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'config.config_revision is immutable (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER config_revision_immutable BEFORE UPDATE ON config.config_revision
  FOR EACH ROW EXECUTE FUNCTION config.reject_update();

-- What `config_publish` recorded. Effective only with the ledger entry (see above).
CREATE TABLE config.config_published (
  rev_hash         text        PRIMARY KEY CHECK (rev_hash ~ '^[0-9a-f]{64}$'),
  lineage          text        NOT NULL,
  parent_rev_hash  text,
  gate_instance_id uuid        NOT NULL,
  ledger_entry_id  uuid        NOT NULL,
  published_by     text        NOT NULL,
  published_at     timestamptz NOT NULL,
  global_seq       bigint      NOT NULL
);
CREATE INDEX config_published_lineage_idx ON config.config_published (lineage, global_seq);

GRANT SELECT, INSERT, DELETE ON config.config_revision, config.config_published TO aisdlc_app;

-- Lookup of a proposed revision by hash on the authoritative record.
CREATE INDEX config_proposed_rev_idx ON record.record_event ((body ->> 'rev_hash'))
  WHERE type = 'config.proposed';
