-- M17: knowledge defects as a re-onboarding trigger (OB §8: "≥3 knowledge defects in 30 d" -> a re-onboarding
-- proposal). `knowledge.defect_recorded` on `kdefect:<repo>` folds into `core.knowledge_defect` (one row per defect,
-- attributed to an area of the governing readiness record, DEC-25); `reonboard.proposed` on `reonboard:<repo>` folds
-- into `core.reonboard_proposal`. Both are rebuilt from the events alone (`rebuildKnowledgeDefects`).

CREATE TABLE core.knowledge_defect (
  defect_id     text        PRIMARY KEY CHECK (defect_id ~ '^[0-9a-f]{64}$'),
  repo          text        NOT NULL,
  project_id    text        NOT NULL,
  area          text        NOT NULL,
  kind          text        NOT NULL,
  path          text        NOT NULL,
  detected_at   timestamptz NOT NULL,
  event_gseq    bigint      NOT NULL
);
CREATE INDEX knowledge_defect_area_idx ON core.knowledge_defect (repo, area, detected_at);

CREATE TABLE core.reonboard_proposal (
  proposal_id   text        PRIMARY KEY CHECK (proposal_id ~ '^[0-9a-f]{64}$'),
  repo          text        NOT NULL,
  project_id    text        NOT NULL,
  area          text        NOT NULL,
  trigger       text        NOT NULL CHECK (trigger IN ('knowledge_defects')),
  status        text        NOT NULL CHECK (status IN ('proposed')),
  body          jsonb       NOT NULL,
  proposed_at   timestamptz NOT NULL,
  event_gseq    bigint      NOT NULL
);
CREATE INDEX reonboard_proposal_repo_idx ON core.reonboard_proposal (repo, area, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.knowledge_defect TO aisdlc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.reonboard_proposal TO aisdlc_app;
