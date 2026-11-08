-- Identity and access (PLAN M4.1). Needs the record and ledger schemas.
--
-- Every table here except `access_sync` is the `identity` read model: a pure fold of the journal
-- streams `principal:`, `group:`, `binding:`, `team:` and `link:` on the record. Dropping the tables
-- and refolding gives the same rows. Removals delete the row (the journal keeps the history).
-- `access_sync` is not a read model: it is the access-sync loop's position, an optimisation that
-- can be reset to 0 without changing what is on the ledger.

CREATE SCHEMA identity;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA identity TO aisdlc_app;

CREATE TABLE identity.principal (
  principal_id      text        PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('human', 'service')),
  status            text        NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  entra_oid         text,
  upn               text,
  logins            jsonb       NOT NULL,
  machine_actions   jsonb       NOT NULL,
  breakglass        boolean     NOT NULL,
  display_handle    text        NOT NULL,
  display_name      text        NOT NULL,
  role_label        text,
  status_changed_at timestamptz NOT NULL
);
CREATE INDEX principal_handle_idx ON identity.principal ((lower(display_handle)));

CREATE TABLE identity.grp (
  group_id    text    PRIMARY KEY,
  display     text    NOT NULL,
  pim_managed boolean NOT NULL,
  protected   boolean NOT NULL
);

CREATE TABLE identity.membership (
  group_id     text        NOT NULL,
  principal_id text        NOT NULL,
  active_from  timestamptz NOT NULL,
  active_until timestamptz,
  via          text        NOT NULL,
  source       text        NOT NULL,
  PRIMARY KEY (group_id, principal_id)
);
CREATE INDEX membership_principal_idx ON identity.membership (principal_id);

CREATE TABLE identity.binding (
  binding_id  uuid        PRIMARY KEY,
  group_id    text        NOT NULL,
  role_id     text        NOT NULL,
  scope_kind  text        NOT NULL,
  scope_ref   text        NOT NULL,
  constraints jsonb       NOT NULL,
  expiry      timestamptz,
  m_gate_ref  uuid,
  config_rev  text
);
CREATE INDEX binding_role_idx ON identity.binding (role_id);
CREATE INDEX binding_group_idx ON identity.binding (group_id);

CREATE TABLE identity.qualification (
  principal_id text        NOT NULL,
  qual_type    text        NOT NULL,
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz,
  source       text        NOT NULL,
  evidence_ref text,
  PRIMARY KEY (principal_id, qual_type)
);

CREATE TABLE identity.identity_link (
  link_key     text PRIMARY KEY,
  principal_id text NOT NULL,
  kind         text NOT NULL,
  issuer       text,
  value        text NOT NULL
);
CREATE INDEX identity_link_principal_idx ON identity.identity_link (principal_id);

CREATE TABLE identity.team (
  team_id        text PRIMARY KEY,
  name           text NOT NULL,
  classification text NOT NULL,
  idp_group      text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  identity.principal, identity.grp, identity.membership, identity.binding,
  identity.qualification, identity.identity_link, identity.team
  TO aisdlc_app;

-- The access-sync loop's position: every access event with global_seq <= ledgered_through has its
-- ledger entry (or was found to have one).
CREATE TABLE identity.access_sync (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  ledgered_through bigint NOT NULL DEFAULT 0 CHECK (ledgered_through >= 0)
);
INSERT INTO identity.access_sync DEFAULT VALUES;
GRANT SELECT, UPDATE ON identity.access_sync TO aisdlc_app;

-- One ledger entry per access event, whatever the application does: the access-sync loop is
-- idempotent on `body.access_event_id`, and this index makes a duplicate impossible.
CREATE UNIQUE INDEX ledger_access_event_key ON ledger.ledger_entry ((body ->> 'access_event_id'))
  WHERE entry_type LIKE 'access.%';

-- Lookups of the journal by what it names (the writer reads the authoritative record, not the read model).
CREATE INDEX identity_binding_project_idx ON record.record_event ((body -> 'constraints' ->> 'project_id'))
  WHERE type = 'binding.created';
CREATE INDEX identity_member_source_idx ON record.record_event ((body ->> 'source'))
  WHERE type = 'group.member_added';
CREATE INDEX identity_handle_created_idx ON record.record_event ((lower(body ->> 'display_handle')))
  WHERE type = 'principal.created';
CREATE INDEX identity_handle_updated_idx ON record.record_event ((lower(body ->> 'display_handle')))
  WHERE type = 'principal.updated';
