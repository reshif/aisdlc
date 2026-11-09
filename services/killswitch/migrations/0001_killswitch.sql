-- The kill switch's own database (PLAN M9.6, AR9). Nothing here is core's: a stopped core, a lost record
-- database or a wedged work engine changes nothing about what is killed, who may kill and who may
-- release. Separate from the record database on purpose, like the Notary's and the Witness's.
--
-- `journal` is the kill switch's own signed, hash-chained history (ES256 by its own key): every kill,
-- release approval, release, delegation grant and revocation and holder sync. Append-only. The other
-- tables are the current state, and every change to them is a journal entry written in the same
-- transaction.

CREATE SCHEMA killswitch;

CREATE FUNCTION killswitch.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- The chain head: one row, forward only, one step at a time.
CREATE TABLE killswitch.head (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_seq  bigint  NOT NULL CHECK (last_seq >= 0),
  last_hash text    CHECK (last_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((last_seq = 0) = (last_hash IS NULL))
);
INSERT INTO killswitch.head (id, last_seq, last_hash) VALUES (true, 0, NULL);

CREATE FUNCTION killswitch.guard_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_seq = OLD.last_seq + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'killswitch.head moves forward one entry at a time (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER head_forward_only BEFORE UPDATE OR DELETE ON killswitch.head
  FOR EACH ROW EXECUTE FUNCTION killswitch.guard_head();
CREATE TRIGGER head_no_truncate BEFORE TRUNCATE ON killswitch.head
  FOR EACH STATEMENT EXECUTE FUNCTION killswitch.reject_mutation();

CREATE TABLE killswitch.journal (
  seq        bigint      PRIMARY KEY CHECK (seq >= 1),
  kind       text        NOT NULL,
  subject    text        NOT NULL,
  actor      text,
  body       jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  at         timestamptz NOT NULL,
  prev_hash  text        CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text        NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  signature  text        NOT NULL,
  key_id     text        NOT NULL,
  CHECK ((seq = 1) = (prev_hash IS NULL))
);
CREATE UNIQUE INDEX journal_prev_hash ON killswitch.journal (prev_hash) WHERE prev_hash IS NOT NULL;
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON killswitch.journal
  FOR EACH ROW EXECUTE FUNCTION killswitch.reject_mutation();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON killswitch.journal
  FOR EACH STATEMENT EXECUTE FUNCTION killswitch.reject_mutation();

-- A kill. `scope_kind`/`scope_ref` are the one Scope of the contracts; `project_id` is derived from it
-- (NULL for the fleet) so a project's kills are one index lookup. A kill is in force until `released`.
CREATE TABLE killswitch.kill (
  kill_id          uuid        PRIMARY KEY,
  scope_kind       text        NOT NULL CHECK (scope_kind IN ('fleet', 'project', 'lane', 'session')),
  scope_ref        text        NOT NULL,
  project_id       text,
  state            text        NOT NULL CHECK (state IN ('active', 'release_pending', 'released')),
  requested_by     text        NOT NULL,
  reason           text        NOT NULL,
  requested_at     timestamptz NOT NULL,
  release_required integer     NOT NULL CHECK (release_required IN (1, 2)),
  released_at      timestamptz,
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);
-- One kill in force per scope.
CREATE UNIQUE INDEX kill_one_in_force ON killswitch.kill (scope_kind, scope_ref) WHERE state <> 'released';
CREATE INDEX kill_project ON killswitch.kill (project_id) WHERE state <> 'released';

-- DM KillReleaseApproval: the distinct people who approved a release. A person approves once.
CREATE TABLE killswitch.release_approval (
  kill_id     uuid        NOT NULL REFERENCES killswitch.kill (kill_id),
  approver    text        NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (kill_id, approver)
);
CREATE TRIGGER release_approval_append_only BEFORE UPDATE OR DELETE ON killswitch.release_approval
  FOR EACH ROW EXECUTE FUNCTION killswitch.reject_mutation();

-- Who may do what, in the kill switch's own words. Factory admins come from its own configuration; the
-- project holders (the admin slot and the kill slot) and the project's tier and two-person setting are
-- PUSHED by core-worker (the kill switch never calls core); delegations are granted here.
CREATE TABLE killswitch.factory_admin (
  principal text PRIMARY KEY
);

CREATE TABLE killswitch.holder (
  project_id text NOT NULL,
  principal  text NOT NULL,
  slot       text NOT NULL CHECK (slot IN ('admin', 'kill')),
  PRIMARY KEY (project_id, principal, slot)
);

CREATE TABLE killswitch.project_policy (
  project_id text        PRIMARY KEY,
  tier       text        CHECK (tier IN ('T0', 'T1', 'T2')),
  two_person boolean     NOT NULL,
  synced_at  timestamptz NOT NULL
);

-- DEC-29: granted by a project admin, until revoked, never the fleet.
CREATE TABLE killswitch.delegation (
  delegation_id uuid        PRIMARY KEY,
  delegate      text        NOT NULL,
  scope_kind    text        NOT NULL CHECK (scope_kind IN ('project', 'lane')),
  scope_ref     text        NOT NULL,
  project_id    text        NOT NULL,
  granted_by    text        NOT NULL,
  granted_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_by    text,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX delegation_delegate ON killswitch.delegation (delegate) WHERE revoked_at IS NULL;
