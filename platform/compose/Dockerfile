# syntax=docker/dockerfile:1.7
#
# One image for every service of the local-prod stack ("image x config", RV §5.2): each service is
# this image with a different command and environment. Build context is the repository root
# (docker-compose.yml sets it); Dockerfile.dockerignore keeps node_modules, dist and .git out.
#
#   builder   npm ci + npm run build: every service bundle, aisdlc-migrate, verify-ledger
#   runtime   node:22 slim + git (codehost and knowledge run git), a non-root user, and ONLY the
#             built bundles (dist/), each service's migrations/ and the Cedar wasm that sits next
#             to its bundle. No sources, no node_modules, no dev tooling, no secrets.
#
# Pinned by digest; bump both lines together (node 22.23.4, bookworm-slim).
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# The runtime base. Default: the same image, with git installed from apt below. Where apt is not
# reachable (an egress allow-list), build a base that already has git and pass it here: the step
# below is skipped when `git` exists.
ARG RUNTIME_IMAGE=${NODE_IMAGE}

FROM ${NODE_IMAGE} AS builder
WORKDIR /src
COPY . .
# Behind a TLS-inspecting proxy, hand the CA to the install:
#   docker build --secret id=extra_ca,src=/path/ca.pem --build-arg HTTPS_PROXY=... -f platform/compose/Dockerfile .
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
RUN npm run build
# Stage exactly what ships, under the same relative paths (a bundle finds `../migrations` and its
# `cedar_wasm_bg.wasm` relative to itself).
RUN set -eu; mkdir /out; \
    for d in services/*/dist services/*/migrations packages/migrate/dist; do \
      [ -d "$d" ] && cp -r --parents "$d" /out; \
    done; \
    mkdir -p /out/packages/ledger/dist; \
    cp packages/ledger/dist/verify-ledger.js* /out/packages/ledger/dist/

FROM ${RUNTIME_IMAGE} AS runtime
RUN command -v git >/dev/null 2>&1 || ( \
      apt-get update \
      && apt-get install -y --no-install-recommends git ca-certificates \
      && rm -rf /var/lib/apt/lists/* )
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin aisdlc
COPY --from=builder /out /app
COPY platform/compose/healthcheck.mjs /app/healthcheck.mjs
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
# State directories a named volume takes its ownership from: the key store of kms-local and the
# scratch space of codehost and knowledge (git clones). Everything else is read-only.
RUN mkdir /kms /work && chown 10001:10001 /kms /work
USER 10001:10001
# No default command: the compose file names the bundle each service runs.
CMD ["node", "-e", "console.error('give this image a command: node /app/services/<service>/dist/main.js'); process.exit(2)"]
