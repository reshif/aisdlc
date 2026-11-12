-- The sandbox-controller starts only sessions core granted (PLAN M14.2; ADR-0003 §6): before a session it reads
-- the admission grant core recorded (`core.admission_grant`, a read model of the `unit.admitted` events) and
-- refuses one that is not active at exactly the lease epoch it was named with. SELECT on that one table and
-- nothing else of core. The group role is created by the config migration; it is created here too when missing
-- so that the order of the two cannot fail the plan.

DO $$
BEGIN
  CREATE ROLE aisdlc_sandbox_controller NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA core TO aisdlc_sandbox_controller;
GRANT SELECT ON core.admission_grant TO aisdlc_sandbox_controller;
