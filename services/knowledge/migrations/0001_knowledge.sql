-- Knowledge (PLAN M6.1, M6.2). Needs the record schema (events are appended to `kjob:<id>` and
-- `finding:<id>` streams).
--
-- Two schemas, two audiences:
--
--   knowledge           the job read model: a pure fold of the `kjob:` streams on the record
--                       (drop `knowledge_job`, refold, same rows). Counts only: no finding, no
--                       fingerprint, no rule, no secret path ever lands here.
--   security_findings   the SECURITY-ONLY store (OB §5.3 item 10, R-SEC-X1): secret findings with
--                       their HMAC fingerprints and locations. It is authoritative for the fields
--                       the record must not hold (fingerprint, locations, the human's reason); the
--                       record carries only the events (detected, state changed) without them.
--
-- ROLE GRANTS. `aisdlc_app` is the group role of every service that writes the record (see the
-- record migration); it is granted the `knowledge` schema and NOTHING on `security_findings`.
-- `aisdlc_security` is the only role granted on `security_findings`. A deployment makes the
-- knowledge service's login role a member of both; no other service's login role is a member of
-- `aisdlc_security`, so none of them can read or write a finding. The knowledge index and every
-- pack are built from `knowledge` alone.

CREATE SCHEMA knowledge;
CREATE SCHEMA security_findings;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
DO $$
BEGIN
  CREATE ROLE aisdlc_security NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA knowledge TO aisdlc_app;

CREATE TABLE knowledge.knowledge_job (
  job_id              uuid        PRIMARY KEY,
  kind                text        NOT NULL CHECK (kind IN ('census_intake')),
  repo                text        NOT NULL,
  state               text        NOT NULL CHECK (state IN ('queued', 'running', 'done', 'error')),
  refs_requested      text        NOT NULL CHECK (refs_requested IN ('all', 'default_only')),
  base_sha_requested  text,
  created_at          timestamptz NOT NULL,
  started_at          timestamptz,
  finished_at         timestamptz,
  error               text,
  result              jsonb,
  result_sha256       text,
  CHECK ((state = 'done') = (result IS NOT NULL)),
  CHECK ((state = 'done') = (result_sha256 IS NOT NULL))
);
CREATE INDEX knowledge_job_repo_idx ON knowledge.knowledge_job (repo, created_at DESC);
CREATE INDEX knowledge_job_state_idx ON knowledge.knowledge_job (state);
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.knowledge_job TO aisdlc_app;

REVOKE ALL ON SCHEMA security_findings FROM PUBLIC;
GRANT USAGE ON SCHEMA security_findings TO aisdlc_security;

-- One row per secret: (repo, rule, fingerprint). The same secret in many blobs is one finding with
-- many locations, and a rescan finds the same row again, so a human's decision survives rescans.
CREATE TABLE security_findings.finding (
  finding_id        uuid        PRIMARY KEY,
  repo              text        NOT NULL,
  rule_id           text        NOT NULL,
  fingerprint       text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  state             text        NOT NULL CHECK (state IN ('open', 'rotated', 'false_positive', 'accepted_test_fixture')),
  first_job_id      uuid        NOT NULL,
  first_commit      text,
  detected_at       timestamptz NOT NULL,
  state_changed_by  text,
  state_changed_at  timestamptz,
  state_reason      text,
  UNIQUE (repo, rule_id, fingerprint),
  CHECK ((state = 'open') = (state_changed_by IS NULL))
);
CREATE INDEX finding_repo_state_idx ON security_findings.finding (repo, state);

CREATE TABLE security_findings.finding_location (
  finding_id   uuid    NOT NULL REFERENCES security_findings.finding (finding_id),
  blob_id      text    NOT NULL,
  line         integer NOT NULL CHECK (line >= 1),
  paths        jsonb   NOT NULL,
  first_commit text,
  job_id       uuid    NOT NULL,
  PRIMARY KEY (finding_id, blob_id, line)
);

REVOKE ALL ON ALL TABLES IN SCHEMA security_findings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON security_findings.finding, security_findings.finding_location
  TO aisdlc_security;
