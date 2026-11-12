# syntax=docker/dockerfile:1.7
#
# The onboarding probe image (PLAN M16; DEC-17 refined; ADR-0003 §7 K-exec). What a K-exec session runs: the repo's
# own `setup` and `test`, with the mirror as its only peer and no internet. Everything in it is pinned in `pins.json`:
# the two base images by digest, and every wheel at an exact version and sha256. The wheels are fetched and checked
# on the HOST by `build.sh` (nothing is fetched here), checked AGAIN here (`sha256sum -c`) and installed by pip in
# hash-checking mode from the build context only (`--no-index --require-hashes`). Build it with
#
#   platform/sandbox/onboarding/build.sh          -> aisdlc/sandbox-onboarding:local, prints the image digest
#
# The digest it prints is what `onboarding.sandbox_image` names (an M1 change); the image carries the sha256 of the
# lock it was built from as the label `aisdlc.onboarding.lock.sha256`. Same user (10002), entrypoint (`aisdlc-run`)
# and package-manager settings as the sandbox image; plus python3, pip, the pinned libraries and scanner, and the
# probe's step runner `aisdlc-probe`. No git, no curl, no secret, no Docker CLI.
ARG PYTHON_IMAGE=python:3.12.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS node
FROM ${PYTHON_IMAGE} AS python

# The python base's files, without its configuration: its environment carries build-time names (GPG_KEY, the
# source sha) that a sandbox must not hold (the driver refuses a credential-shaped name in a container's env).
FROM scratch
COPY --from=python / /
ENV PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version >/dev/null \
 && groupadd --gid 10002 sandbox \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /work --shell /usr/sbin/nologin sandbox
COPY pins.json pins.sha256 requirements.txt /opt/onboarding/
# verify every wheel against the lock, then install from the context only, in pip's hash-checking mode
RUN --mount=type=bind,source=wheels,target=/tmp/wheels \
    cd /tmp/wheels && sha256sum --strict -c /opt/onboarding/pins.sha256 --quiet \
 && test "$(ls | wc -l)" = "$(wc -l < /opt/onboarding/pins.sha256)" \
 && pip install --no-index --find-links /tmp/wheels --require-hashes --only-binary :all: \
      --no-cache-dir --disable-pip-version-check -r /opt/onboarding/requirements.txt \
 && pytest --version && bandit --version >/dev/null \
 && find /usr/local/lib/python3.12 -name '__pycache__' -prune -exec rm -rf {} + \
 && chmod -R a-w /opt/onboarding
COPY --chmod=0555 aisdlc-run aisdlc-probe /usr/local/bin/
# A package manager can only reach the mirror (the one peer a K-exec session has); install scripts off where
# possible; a repo's own Python dependencies go to the user site under /work (the root file system is read-only).
ENV HOME=/work TMPDIR=/tmp \
    NODE_ENV=test CI=1 \
    npm_config_registry=http://package-mirror:8420/ \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_cache=/work/.npm \
    PIP_INDEX_URL=http://package-mirror:8420/simple/ \
    PIP_TRUSTED_HOST=package-mirror \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_USER=1 \
    PYTHONUSERBASE=/work/.local \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/work/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ARG LOCK_SHA256=unknown
LABEL aisdlc.onboarding.lock.sha256=$LOCK_SHA256 \
      org.opencontainers.image.title="aisdlc onboarding probe image" \
      org.opencontainers.image.description="K-exec: the repo's own setup and test, mirror only, pinned scanners and libraries"
USER 10002:10002
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/aisdlc-run"]
CMD ["python3", "--version"]
