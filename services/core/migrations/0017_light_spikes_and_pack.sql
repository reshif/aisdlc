-- Core: the Light spikes and the affirmed pack's git projection (PLAN M16; onboarding-roadmap §10 SP-STD-1, SP-STD-3,
-- §4.1 item 7, R2b; DEC-12(a) record-first).
--
-- READ MODELS. The authority is the record:
--   `spike.recorded` on `spike:<kind>` (a report as it was posted, its hash, the thresholds in force and the verdict
--   core computed) folds into `core.light_spike`; LF4 reads the latest SP-STD-1 row for the worker image in use;
--   `pack.rendered` and `pack.x2_opened` on `pack:<s0_id>` fold into `core.onboarding_pack`; the push itself is a push
--   intent and receipt on `push:<s0_id>` like every push (`core.push_receipt`, `core.pull_request`).
-- Both are rebuilt from the events alone (`rebuildSpikes`, `rebuildPacks`).

CREATE TABLE core.light_spike (
  report_hash   text        PRIMARY KEY CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  kind          text        NOT NULL CHECK (kind IN ('sp-std-1', 'sp-std-3')),
  -- sp-std-1: the worker image by digest; sp-std-3: the lint revision and secret rules version
  subject       text        NOT NULL,
  passed        boolean     NOT NULL,
  verdict       jsonb       NOT NULL,
  recorded_at   timestamptz NOT NULL,
  event_gseq    bigint      NOT NULL
);
CREATE INDEX light_spike_subject_idx ON core.light_spike (kind, subject, event_gseq);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.light_spike TO aisdlc_app;

CREATE TABLE core.onboarding_pack (
  patch_hash      text        NOT NULL CHECK (patch_hash ~ '^[0-9a-f]{64}$'),
  s0_id           uuid        NOT NULL,
  project_id      text        NOT NULL,
  repo            text        NOT NULL,
  base_sha        text        NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  c2_card_id      uuid        NOT NULL,
  files           jsonb       NOT NULL,
  x2_card_id      uuid,
  x2_gate_instance_id text,
  rendered_at     timestamptz NOT NULL,
  event_gseq      bigint      NOT NULL,
  PRIMARY KEY (s0_id, patch_hash)
);
CREATE INDEX onboarding_pack_s0_idx ON core.onboarding_pack (s0_id, event_gseq);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.onboarding_pack TO aisdlc_app;
