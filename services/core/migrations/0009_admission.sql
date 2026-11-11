-- Core: Lease and AdmissionGrant (PLAN M13.1; DM §3.6 Lease, §6.4 Unit, §8 gap 14). Needs 0008_units.
--
-- READ MODELS. The authority is the event stream `unit:<item>` (`unit.admitted`, `unit.lease_changed`,
-- `unit.grant_released`, `unit.wait_entered`, `unit.state_changed`) together with the plan's `units.planned` on
-- `planning:<item>`; core folds each event into these rows in the transaction that wrote it and can rebuild them
-- from the events alone (`rebuildUnits`). The Unit is the single owner of its lease epoch (gap 14): `unit.lease_epoch`
-- is the lease's epoch, written in the same fold, and everything that wants the epoch reads it from there.

-- The implicit Unit of an item no plan made (L0 hotfix: the lane profile's envelope) has no base commit.
ALTER TABLE core.unit ALTER COLUMN base_sha DROP NOT NULL;

CREATE TABLE core.lease (
  unit_id      text        PRIMARY KEY REFERENCES core.unit (unit_id) ON DELETE CASCADE,
  item_id      uuid        NOT NULL,
  branch       text        NOT NULL,
  -- only ever increases: a stale writer's epoch is smaller than this
  epoch        integer     NOT NULL CHECK (epoch >= 1),
  holder_kind  text        NOT NULL CHECK (holder_kind IN ('agent', 'human')),
  holder_ref   text,
  status       text        NOT NULL CHECK (status IN ('held', 'released')),
  changed_at   timestamptz NOT NULL,
  -- the global_seq of the event that last changed it: the item's current Unit is the one changed last
  event_gseq   bigint      NOT NULL
);
CREATE INDEX lease_item_idx ON core.lease (item_id, event_gseq);

-- The epoch never goes down, whoever writes (the fold, a repair, a stray UPDATE).
CREATE FUNCTION core.lease_epoch_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch < OLD.epoch THEN
    RAISE EXCEPTION 'stale lease epoch % < % for unit %', NEW.epoch, OLD.epoch, OLD.unit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lease_epoch_monotonic BEFORE UPDATE ON core.lease
  FOR EACH ROW EXECUTE FUNCTION core.lease_epoch_monotonic();

-- DM §3.6 `Lease.history`: append only, one row per change.
CREATE TABLE core.lease_history (
  unit_id      text        NOT NULL,
  n            integer     NOT NULL,
  epoch        integer     NOT NULL CHECK (epoch >= 1),
  holder_kind  text        NOT NULL,
  holder_ref   text,
  status       text        NOT NULL,
  cause        text        NOT NULL,
  at           timestamptz NOT NULL,
  PRIMARY KEY (unit_id, n)
);

CREATE TABLE core.admission_grant (
  grant_id          text        PRIMARY KEY,
  item_id           uuid        NOT NULL,
  unit_id           text        NOT NULL,
  project_id        text        NOT NULL,
  lease_epoch       integer     NOT NULL CHECK (lease_epoch >= 1),
  slot              jsonb       NOT NULL,
  envelope          jsonb       NOT NULL,
  status            text        NOT NULL CHECK (status IN ('active', 'waiting', 'released')),
  release_cause     text,
  granted_at        timestamptz NOT NULL,
  released_at       timestamptz,
  snapshot_ref      text,
  paused_ms         bigint      NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
  paused_since      timestamptz,
  resumes_grant_id  text
);
CREATE INDEX admission_grant_item_idx ON core.admission_grant (item_id, status);
CREATE INDEX admission_grant_status_idx ON core.admission_grant (status);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.lease, core.lease_history, core.admission_grant TO aisdlc_app;
