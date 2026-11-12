-- S7 Verify (PLAN M14.3; docs/specs/verify-api.md): the results of the checks 7.1 to 7.5, as a read model of the
-- `verify.check_recorded` events on the `verify:<item>` record streams. Rebuildable from the record alone
-- (`rebuildCheckResults`): the event carries the whole result and its hash.
--
-- Least privilege: the verify service connects as the login role `verify` (db-init), a member of the NOLOGIN group
-- role below, which can do exactly this:
--
--   verify.check_result         SELECT and INSERT (a result is written once, by its command key; never UPDATE or DELETE)
--   record.record_event         SELECT and INSERT of `verify:%` streams only (row-level security), never UPDATE or DELETE
--   record.global_counter       SELECT and UPDATE: every append locks this one row and moves it forward
--
-- and nothing else: no core, identity, knowledge, config, decisions or ledger table, no DDL.

CREATE SCHEMA IF NOT EXISTS verify;

CREATE TABLE verify.check_result (
  command_key    text        PRIMARY KEY,
  result_sha256  text        NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  item_id        uuid        NOT NULL,
  unit_key       text        NOT NULL,
  step           text        NOT NULL CHECK (step IN ('7.1', '7.2', '7.3', '7.4', '7.5')),
  base_sha       text        NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha       text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  verdict        text        NOT NULL CHECK (verdict IN ('passed', 'failed', 'unknown')),
  -- `X2`, `E2` or `ET10`: what the check raised through core
  raised         text,
  result         jsonb       NOT NULL,
  -- the global_seq of the event that recorded it: the order results happened in
  event_gseq     bigint      NOT NULL,
  recorded_at    timestamptz NOT NULL
);
CREATE INDEX check_result_head_idx ON verify.check_result (item_id, head_sha, event_gseq);
CREATE INDEX check_result_hash_idx ON verify.check_result (result_sha256);

DO $$
BEGIN
  CREATE ROLE aisdlc_verify NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA verify, record TO aisdlc_verify;
GRANT SELECT, INSERT ON verify.check_result TO aisdlc_verify;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_verify;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_verify;

-- The record's row-level security (enabled by the gateway migration, which runs before this one in the plan): the
-- verify role sees and writes only its own streams.
CREATE POLICY record_event_verify_read ON record.record_event
  FOR SELECT TO aisdlc_verify USING (stream LIKE 'verify:%');
CREATE POLICY record_event_verify_append ON record.record_event
  FOR INSERT TO aisdlc_verify WITH CHECK (stream LIKE 'verify:%');

