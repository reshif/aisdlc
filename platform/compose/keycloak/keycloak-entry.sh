#!/bin/bash
# Keycloak's entrypoint in the local-prod stack: the secrets are FILES (compose secrets, written by init-secrets) and
# Keycloak reads them from its environment, so this script reads each file into the variable the realm import's
# placeholders and Keycloak's own settings name, then runs Keycloak. Nothing is printed.
#
# The realm import (`--import-realm`) runs only while the realm `aisdlc` does not exist yet: the passwords and the
# client secret below seed it once; later changes are made in Keycloak (its admin console or API), not here.
set -euo pipefail
secret() { local v; v="$(cat "/run/secrets/$1")"; printf '%s' "${v%$'\n'}"; }

KC_DB_PASSWORD="$(secret pg-pass-keycloak)"
KC_BOOTSTRAP_ADMIN_PASSWORD="$(secret keycloak-bootstrap-admin)"
KC_PERSONA_PASSWORD="$(secret keycloak-persona-password)"
KC_FACTORY_ADMIN_PASSWORD="$(secret keycloak-factory-admin-password)"
KC_BFF_CLIENT_SECRET="$(secret bff-oidc-client-secret)"
export KC_DB_PASSWORD KC_BOOTSTRAP_ADMIN_PASSWORD KC_PERSONA_PASSWORD KC_FACTORY_ADMIN_PASSWORD KC_BFF_CLIENT_SECRET
export KC_BOOTSTRAP_ADMIN_USERNAME="${KC_BOOTSTRAP_ADMIN_USERNAME:-kc-admin}"

exec /opt/keycloak/bin/kc.sh start --optimized --import-realm "$@"
