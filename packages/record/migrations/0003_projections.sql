-- Rebuild harness (PLAN M2.5): one checkpoint row per projection, and the sample projection.

CREATE TABLE record.projection_checkpoint (
  name            text        PRIMARY KEY CHECK (name <> ''),
  version         integer     NOT NULL CHECK (version >= 1),
  last_global_seq bigint      NOT NULL CHECK (last_global_seq >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON record.projection_checkpoint TO aisdlc_app;

-- Sample projection `stream_type_counts`: events per stream type (the part of the stream before ':').
CREATE TABLE record.stream_type_counts (
  stream_type text   PRIMARY KEY,
  event_count bigint NOT NULL CHECK (event_count >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON record.stream_type_counts TO aisdlc_app;
