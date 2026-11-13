# shellcheck shell=bash
# The sign-in profile of the stack (sourced by the Makefile's `up`, up-full.sh and full-env.sh; defines a function, runs
# nothing):
#
#   idp_profile <local|enterprise>   exports what docker-compose.yml reads, so one name picks the whole set
#
#   local       Keycloak's realm has the 13 TEST PEOPLE (alice, bob, the design personas) and the break-glass
#               `factory-admin`; the sign-in page lists them. What the smoke, the e2e runs, the demo and the load test
#               sign in as. The default of a bare `docker compose up`.
#   enterprise  ONE system administrator `admin` (default password `admin`, temporary: Keycloak forces a new one at the
#               first sign-in), no test people, a plain sign-in page. Everyone else is added through the portal.
#
# Keycloak imports its realm only when it does not exist yet, so the profile takes effect on a NEW Keycloak database;
# an existing stack keeps its realm (platform/compose/README.md, "Switching a running stack's sign-in profile").
idp_profile() {
  case "${1:-local}" in
    local)
      unset AISDLC_KEYCLOAK_REALM_FILE AISDLC_IDP_SEED_FILE AISDLC_SEED_ADMIN AISDLC_SEED_PERSONAS AISDLC_KILLSWITCH_ADMINS
      ;;
    enterprise)
      export AISDLC_KEYCLOAK_REALM_FILE=./keycloak/realm-aisdlc-enterprise.json
      export AISDLC_IDP_SEED_FILE=./config/keycloak-idp-seed-enterprise.json
      export AISDLC_SEED_ADMIN=admin AISDLC_SEED_PERSONAS=0
      export AISDLC_KILLSWITCH_ADMINS='["admin"]'
      ;;
    *) echo "the sign-in profile is local or enterprise, not '${1:-}'" >&2; return 1 ;;
  esac
  export AISDLC_IDP_PROFILE="${1:-local}"
}
