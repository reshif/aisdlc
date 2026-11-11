# syntax=docker/dockerfile:1.7
#
# The sandbox image (PLAN M13.2): what every sandbox container runs. Minimal on purpose: the pinned node base,
# one non-root user, the `aisdlc-run` wrapper and nothing else. No package manager state, no git, no curl, no
# secret, no Docker CLI. Build it with
#
#   docker build -t aisdlc/sandbox:local platform/sandbox
#
# Where the base image is already local (an egress allow-list) this needs no network at all: nothing here is
# fetched or installed. Pinned by digest, the same node 22.23.4 bookworm-slim as the factory image.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE}
RUN groupadd --gid 10002 sandbox \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /work --shell /usr/sbin/nologin sandbox
COPY aisdlc-run /usr/local/bin/aisdlc-run
RUN chmod 0555 /usr/local/bin/aisdlc-run
# A package manager can only reach the mirror (the one peer a build session has); install scripts off where possible.
ENV HOME=/work TMPDIR=/tmp \
    NODE_ENV=test CI=1 \
    npm_config_registry=http://package-mirror:8420/ \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_cache=/tmp/.npm \
    PIP_INDEX_URL=http://package-mirror:8420/simple/ \
    PIP_DISABLE_PIP_VERSION_CHECK=1
USER 10002:10002
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/aisdlc-run"]
CMD ["node", "--version"]
