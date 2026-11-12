-- The floor's liveness (PLAN M19, DM §3.6 SessionEvent and Heartbeat, §3.10 SessionActivity). Needs 0018_floor.
--
-- `core.session_activity` is a fold of the record alone (`sessionActivityProjection`, services/core/src/floor-live.ts):
-- `session.heartbeat` on `session:<item>` (posted by a session's reporter, recorded first), the gateway's
-- `gateway.model_call` of the item, and core's own `agent.run_dispatched`. One row per item: its newest activity.
-- Whether an item is STUCK is not stored: silence is a function of the read time, worked out when the floor is read.

CREATE TABLE core.session_activity (
  item_id      uuid        PRIMARY KEY,
  project_id   text        NOT NULL,
  last_at      timestamptz NOT NULL,
  source       text        NOT NULL CHECK (source IN ('heartbeat', 'model_call', 'dispatch')),
  session_id   text,
  beats        integer     NOT NULL CHECK (beats >= 1),
  last_seq     bigint      NOT NULL
);
CREATE INDEX session_activity_project_idx ON core.session_activity (project_id);

-- When the item entered the session it is in (the silence clock starts there); `null` while it is in none.
ALTER TABLE core.floor_position ADD COLUMN in_session_since timestamptz;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.session_activity TO aisdlc_app;
