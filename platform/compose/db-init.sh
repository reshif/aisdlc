#!/bin/sh
# One-shot database bootstrap (the `db-init` service). Idempotent: run on every `up`, it creates
# what is missing and re-applies the passwords from the secret files, so a rotated file takes effect.
#
#   role aisdlc  -> database aisdlc    record, ledger, decisions, config, identity, directory, bff,
#                                      knowledge and core schemas (everything but the key holders)
#   role notary  -> database notary    the Notary's own database
#   role witness -> database witness   the Witness's own database
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
  -v pw_witness="$(cat /run/secrets/pg-pass-witness)" <<'SQL'
SELECT 'CREATE ROLE aisdlc_app NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aisdlc_app') \gexec

SELECT format('CREATE ROLE %I LOGIN', r)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness']) AS r
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec

-- CREATEROLE: the record migrations create the aisdlc_app group role if it is missing (the
-- permission is checked before the existence). Local-prod runs migrations and services as one
-- owner role (the schemas of core, bff and others migrate at their own start); the cloud target
-- splits migrator and service roles (RV §7).
SELECT format('ALTER ROLE aisdlc CREATEROLE PASSWORD %L', :'pw_aisdlc') \gexec
SELECT format('ALTER ROLE notary PASSWORD %L', :'pw_notary') \gexec
SELECT format('ALTER ROLE witness PASSWORD %L', :'pw_witness') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', d, d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness']) AS d
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = d) \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness']) AS d \gexec
SELECT format('GRANT CONNECT ON DATABASE %1$I TO %1$I', d)
  FROM unnest(ARRAY['aisdlc', 'notary', 'witness']) AS d \gexec
SQL
echo "db-init: roles and databases are in place"
