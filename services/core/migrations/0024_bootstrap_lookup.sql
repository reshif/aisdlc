-- M19, the load test (docs/evidence/load-m19.md): `liveBootstrap` (packages/onboarding/src/live.ts) is asked on every
-- PDP decision about a project resource (`BootstrapPdpEntities`), and found the project's bootstrap grants with a scan
-- of the whole record (`type = 's0.bootstrap_granted' AND body ->> 'project_id' = $2`, no index). A partial index makes
-- it a lookup of the project's few grants, whatever the size of the record. An index only: nothing reads differently.

CREATE INDEX core_s0_bootstrap_project_idx ON record.record_event ((body ->> 'project_id'))
  WHERE type = 's0.bootstrap_granted';
