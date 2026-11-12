-- The sandbox-controller's database role (PLAN M14.2; ADR-0003 §6, §7). The controller reads the published
-- sandbox caps (`sandbox.caps`) and nothing else of config: like the gateway it is granted the effective-config
-- view (the ledger join is done by the view's owner) and none of config's tables, none of the ledger.
-- Its login role `sandbox_controller` is created by db-init and made a member of this NOLOGIN group role.
-- The core migration that follows grants it the one core read model it checks a session against (the grant).

DO $$
BEGIN
  CREATE ROLE aisdlc_sandbox_controller NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA config TO aisdlc_sandbox_controller;
GRANT SELECT ON config.genuine_publish TO aisdlc_sandbox_controller;
