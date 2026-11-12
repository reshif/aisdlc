-- The floor's live read model (PLAN M19, DM §3.10 ItemPosition and FlowWindow). Needs the record schema and 0003_work.
--
-- A pure fold of the `item:` streams through the lifecycle interpreter under each item's pinned catalogue
-- (`floorProjection`, services/core/src/floor.ts): dropping both tables and refolding gives the same rows. Never
-- read on a write path. Content-free but for `title` (the first line of the request, secret-scanned), which the
-- readers cut by data class.

-- One row per item: where it is on the floor.
CREATE TABLE core.floor_position (
  item_id           uuid        PRIMARY KEY,
  project_id        text        NOT NULL,
  lane              text        NOT NULL,
  lane_bound        boolean     NOT NULL,
  -- `station:S3`, `gate:G0+G1`, `room:HOLD`
  node              text        NOT NULL,
  stage             text,
  step              text,
  phase             text        NOT NULL,
  status            text        NOT NULL
    CHECK (status IN ('working', 'waiting', 'held', 'stuck', 'done', 'declined')),
  waiting           text,
  waiting_gates     jsonb       NOT NULL,
  holds             jsonb       NOT NULL,
  in_session        boolean     NOT NULL,
  route             jsonb       NOT NULL,
  requester         text        NOT NULL,
  title             text,
  -- What the fold has seen so far, to tell a back-edge or a re-lane at the next event (`rework.by_edge`, re-lanes).
  rework            jsonb       NOT NULL,
  relanes           integer     NOT NULL CHECK (relanes >= 0),
  catalogue_version text        NOT NULL,
  pin_unavailable   boolean     NOT NULL,
  seq               integer     NOT NULL CHECK (seq >= 1),
  updated_at        timestamptz NOT NULL
);
CREATE INDEX floor_position_project_idx ON core.floor_position (project_id);

-- The moves the fold saw: F forward (the node changed), B a back-edge, R a re-lane. The floor counts them per hour
-- (FlowWindow) and lists the recent back-edges.
CREATE TABLE core.floor_move (
  item_id     uuid        NOT NULL,
  seq         integer     NOT NULL,
  ord         integer     NOT NULL,
  project_id  text        NOT NULL,
  lane        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('F', 'B', 'R')),
  edge        text,
  from_node   text,
  to_node     text,
  at          timestamptz NOT NULL,
  PRIMARY KEY (item_id, seq, ord)
);
CREATE INDEX floor_move_project_idx ON core.floor_move (project_id, at);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.floor_position, core.floor_move TO aisdlc_app;
