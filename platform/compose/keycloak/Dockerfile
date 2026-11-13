# Keycloak for the local-prod stack (portal v2: sign-in via Keycloak OIDC). The pinned upstream image, built once for
# Postgres with the health endpoints on and the AISDLC sign-in theme baked in, so the container starts with
# `start --optimized` on a read-only root. Built by compose (`docker compose build keycloak`, or on the first `up`).
ARG KEYCLOAK_IMAGE=keycloak/keycloak:26.0.7@sha256:4388e2379b7e870a447adbe7b80bd61f5fbf04e925832b19669fda4957f05a81

FROM ${KEYCLOAK_IMAGE} AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=false KC_CACHE=local
COPY --chown=1000:0 themes/aisdlc /opt/keycloak/themes/aisdlc
COPY --chown=1000:0 themes/aisdlc-enterprise /opt/keycloak/themes/aisdlc-enterprise
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/
COPY --chown=1000:0 --chmod=0755 keycloak-entry.sh /opt/keycloak/bin/aisdlc-entry.sh
ENTRYPOINT ["/opt/keycloak/bin/aisdlc-entry.sh"]
