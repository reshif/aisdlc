#!/bin/sh
# One-shot database bootstrap (the `db-init` service). Idempotent: run on every `up`, it creates
# what is missing and re-applies the passwords from the secret files, so a rotated file takes effect.
#
#   role aisdlc  -> database aisdlc    record, ledger, decisions, config, identity, directory, bff,
#                                      knowledge and core schemas (everything but the key holders)
#   role notary  -> database notary    the Notary's own database
#   role witness -> database witness   the Witness's own database
#   role killswitch -> database killswitch  the kill switch's own database (AR9)
#   role gateway -> database aisdlc    NOT the owner: a login role in the group role `aisdlc_gateway`, which
#                                      the gateway migration grants exactly the gateway's own tables, INSERT
#                                      and SELECT of its own `gateway:` record streams, and the effective-config
#                                      view (never identity, core, knowledge, the ledger, or any UPDATE or DELETE
#                                      of the record). The gateway holds the vendor keys, so it holds the least
#                                      database right that works.
#   role sandbox_controller -> database aisdlc   NOT the owner either (M14.2): a login role in the group role
#                                      `aisdlc_sandbox_controller`, which the config and core migrations grant
#                                      SELECT on the effective-config view and on `core.admission_grant`, nothing else.
#
# Each role owns only its database and nobody else may connect to it, so a compromised record
# service cannot read the Notary's or the Witness's state. Same server for all three: a declared
# local-prod difference (cloud: separate clusters, RV §7). `aisdlc_app` is the NOLOGIN group role the
# record migrations grant to.
set -eu
export PGHOST="${PGHOST:-postgres}" PGUSER=postgres PGDATABASE=postgres
PGPASSWORD="$(cat /run/secrets/pg-superuser)"
export PGPASSWORD

psql -v ON_ERROR_STOP=1 \
  -v pw_aisdlc="$(cat /run/secrets/pg-pass-aisdlc)" \
  -v pw_notary="$(cat /run/secrets/pg-pass-notary)" \
  -v pw_witness="$(cat /run/secrets/pg-pass-witness)" \
  -v pw_killswitch="$(cat /run/secrets/pg-pass-killswitch)" \
  -v pw_gateway="$(cat /run/secrets/pg-pass-gateway)" \
  -v pw_sandbox_controller="$(cat /run/secrets/pg-pass-sandbox-controller)" <<'SQL'
SELECT 'CREATE ROLE aisdlc_app NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aisdlc_app') \gexec

-- The gateway's group role (its privileges are granted by the gateway migration) and its login role.
SELECT 'CREATE ROLE aisdlc_gateway NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aisdlc_gateway') \gexec
SELECT 'CREATE ROLE gateway LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway') \gexec
SELECT format('ALTER ROLE gateway PASSWORD %L', :'pw_gateway') \gexec
GRANT aisdlc_gateway TO gateway;

-- The sandbox-controller's group role (its two grants are the config and core migrations') and its login role.
SELECT 'CREATE ROLE aisdlc_sandbox_controller NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aisdlc_sandbox_controller') \gexec
SELECT 'CREATE ROLE sandbox_controller LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sandbox_controller') \gexec
SELECT format('ALTER ROLE sandbox_controller PASSWORD %L', :'pw_sandbox_controller') \gexec
GRANT aisdlc_sandbox_controller TO sandbox_controller;

SELECT format('CREATE ROLE %I LOGIN', r)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness', 'killswitch']) AS r
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec

-- CREATEROLE: the record migrations create the aisdlc_app group role if it is missing (the
-- permission is checked before the existence). Local-prod runs migrations and services as one
-- owner role (the schemas of core, bff and others migrate at their own start); the cloud target
-- splits migrator and service roles (RV §7).
SELECT format('ALTER ROLE aisdlc CREATEROLE PASSWORD %L', :'pw_aisdlc') \gexec
SELECT format('ALTER ROLE notary PASSWORD %L', :'pw_notary') \gexec
SELECT format('ALTER ROLE witness PASSWORD %L', :'pw_witness') \gexec
SELECT format('ALTER ROLE killswitch PASSWORD %L', :'pw_killswitch') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', d, d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness', 'killswitch']) AS d
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = d) \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness', 'killswitch']) AS d \gexec
SELECT format('GRANT CONNECT ON DATABASE %1$I TO %1$I', d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness', 'killswitch']) AS d \gexec
GRANT CONNECT ON DATABASE aisdlc TO gateway;
GRANT CONNECT ON DATABASE aisdlc TO sandbox_controller;
SQL
echo "db-init: roles and databases are in place"
