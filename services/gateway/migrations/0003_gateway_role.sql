-- Least privilege for the model gateway (PLAN M10 follow-up). The gateway used to connect as `aisdlc`,
-- a role that reads the whole record database. It now connects as the login role `gateway` (created by
-- db-init, a member of the NOLOGIN group role below) which can do exactly this:
--
--   gateway.*                   SELECT, INSERT, UPDATE on its own tables (never DELETE)
--   record.record_event         SELECT and INSERT, and only of `gateway:%` streams (row-level security),
--                               never UPDATE or DELETE. SELECT is what the append path needs: the stream's
--                               head and its idempotency keys
--   record.global_counter       SELECT and UPDATE: every append locks this one row and moves it forward
--   config.genuine_publish      SELECT: the effective config, with the ledger join done by the view's
--                               owner. NOT config's tables, NOT the ledger
--   integrations.integration_health   SELECT, INSERT, UPDATE: the gateway reports its own health
--
-- and nothing else: no identity, core, knowledge, bff, decisions, ledger or killswitch table, no
-- outbox, no projection state, no DDL (the `migrate` job owns the schema; the gateway no longer
-- migrates at start). The grants on config and integrations apply when those schemas exist
-- (`aisdlc-migrate` applies them first, in plan order).

DO $$
BEGIN
  CREATE ROLE aisdlc_gateway NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA gateway, record TO aisdlc_gateway;
GRANT SELECT, INSERT, UPDATE ON gateway.budget_group, gateway.vkey, gateway.reservation TO aisdlc_gateway;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_gateway;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_gateway;

-- Row-level security on the record: the owner and superusers bypass it (the migrate job, the services
-- that connect as the owner today), `aisdlc_app` members keep what they had, and the gateway sees and
-- writes only its own streams.
ALTER TABLE record.record_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_event_app ON record.record_event
  FOR ALL TO aisdlc_app USING (true) WITH CHECK (true);
CREATE POLICY record_event_gateway_read ON record.record_event
  FOR SELECT TO aisdlc_gateway USING (stream LIKE 'gateway:%');
CREATE POLICY record_event_gateway_append ON record.record_event
  FOR INSERT TO aisdlc_gateway WITH CHECK (stream LIKE 'gateway:%');

DO $$
BEGIN
  IF to_regclass('config.genuine_publish') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA config TO aisdlc_gateway;
    GRANT SELECT ON config.genuine_publish TO aisdlc_gateway;
  END IF;
  IF to_regclass('integrations.integration_health') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA integrations TO aisdlc_gateway;
    GRANT SELECT, INSERT, UPDATE ON integrations.integration_health TO aisdlc_gateway;
  END IF;
END
$$;
