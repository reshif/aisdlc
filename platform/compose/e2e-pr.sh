#!/usr/bin/env bash
# Request to merged PR on the local-prod stack, on fakes (RC-E2E-2, RC-E2E-7). Run it as `npm run e2e:pr`.
# Needs Docker with Compose v2, Node 22 with the repo's node_modules (npm ci) and Playwright's Chromium
# (`require('playwright')` must resolve; PW_CHROMIUM names another Chromium binary). No credentials.
#
#   1. images of its own (tag e2e-pr: the factory image, the sandbox base, the W image, the onboarding probe image), so
#      it never replaces another run's (build-images.sh)
#   2. SP-STD-1 (the planted-instruction isolation test) on that W image: the report LF4 needs, posted later
#   3. the stack with the fake GitHub and profile `full` (the Push Broker, the sandbox-controller and both Docker
#      proxies, verify, gate-check), core-worker on the real planning, coding, verify, evidence and push ports, the
#      gateway's fake provider on the `testbed` fixtures, and the seed publishing DEC-18's allow-list (the testbed), the
#      probe image and the W image (also the controller's SANDBOX_AGENT_IMAGE_ID)
#   4. e2e-pr.mjs: a real Chromium, every gate decided in the browser by its slot holder (the design personas): the
#      Light onboarding of reshif/asf-factory-testbed, a request typed in the portal, S1 to G3, S6 in W sessions, S7 in
#      the verify service, the signed Evidence Pack, the Push Broker's Draft PR on agent/<item>/<unit>, gate-check's
#      `aisdlc/gate`, G4, a person merging on the fake GitHub, the item closed; the record and the ledger checked
#   5. verify-ledger, then `down -v` (also on failure or Ctrl-C), and the run's sandboxes, networks and scratch removed
#
# Steps 1 to 3 are full-env.sh, the same code `make up-full` (up-full.sh) runs for the owner's stack; this script
# chooses only what a test needs: a throwaway project on its own ports, the fake GitHub and the testbed fixtures.
#
# E2E_SKIP_BUILD=1   use the e2e-pr images as they are (each must exist)
# E2E_KEEP=1         leave the stack running (remove it with `docker compose --profile fake-github --profile full down -v`
#                    and the same COMPOSE_PROJECT_NAME and AISDLC_SUBNET_PREFIX)
# E2E_UP_ONLY=1      bring the stack up (with E2E_KEEP implied) and stop before the browser
# E2E_ATTACH=1       steps 4 and the ledger check only, against a stack ALREADY running and left running: the owner's
#                    `make up-full REPO=reshif/asf-factory-testbed GITHUB=fake` started with SEED_FAKE_FIXTURES=testbed
#                    (COMPOSE_PROJECT_NAME default aisdlc, AISDLC_BFF_PORT default 8340). Nothing is built, started,
#                    stopped or removed; the stack must be fresh (the journey onboards the testbed from the start)
# E2E_APPS=two      (the default) the GitHub Apps as ./setup-github-apps writes them (docs/getting-started.md §4): ONE
#                    factory App for the codehost and the Push Broker (the same id, installation and key, its grant the
#                    union), gate-check's own App, and gate-check recognising agent PRs by the factory App's bot
# E2E_APPS=split    the Push Broker on an App of its own (the optional stricter setup)
# RUNTIME_IMAGE=..., EXTRA_CA=..., BUILD_PROXY=1, BUILD_NETWORK=host   the image build's options (build-images.sh)
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"
FULL_WHO=e2e-pr
# shellcheck source=full-env.sh
. ./full-env.sh
fail() { echo "e2e-pr: FAIL: $*" >&2; exit 1; }

if [ "${E2E_ATTACH:-0}" = 1 ]; then
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc}"
  export AISDLC_BFF_PORT="${AISDLC_BFF_PORT:-8340}"
  echo "== attach: the running stack of project $COMPOSE_PROJECT_NAME (portal on $AISDLC_BFF_PORT); nothing is started or removed"
  [ -n "$(docker compose ps -q bff 2>/dev/null)" ] || fail "project $COMPOSE_PROJECT_NAME has no running bff (start it with make up-full)"
  [ -n "$(docker compose --profile fake-github ps -q fake-github 2>/dev/null)" ] || fail "the journey needs the fake GitHub (GITHUB=fake)"
  wired=$(docker compose exec -T core-worker node -p 'const e=process.env;[e.CORE_WORKER_STAGE_PORTS,e.CORE_WORKER_SANDBOX_CONTROLLER_URL,e.CORE_WORKER_VERIFY_URL,e.CORE_WORKER_PUSH_BROKER,e.CORE_WORKER_FAKE_VERIFY].join(" ")')
  [ "$wired" = "agents http://sandbox-controller:8430 http://verify:8440 1 default" ] ||
    fail "core-worker is not on the real ports with real verify ($wired)"
  fixtures=$(docker compose exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres psql -U postgres -d aisdlc -At -c "
    SELECT x->'config'->>'fixtures' FROM (SELECT r.doc FROM config.config_published p JOIN config.config_revision r USING (rev_hash)
      WHERE r.layer = 'factory' ORDER BY p.global_seq DESC LIMIT 1) d, jsonb_array_elements(d.doc->'integrations.registry') x
    WHERE x->>'integration_id' = 'fake'")
  [ "$fixtures" = testbed ] || fail "the fake provider answers with fixtures '$fixtures': start the stack with SEED_FAKE_FIXTURES=testbed for this test"
  E2E_BROKER_LOGIN=$(docker compose --profile full exec -T push-broker node -p 'process.env.CODEHOST_COMMITTER_NAME')
  export E2E_BROKER_LOGIN
  echo "  core-worker: $wired; fake provider fixtures: $fixtures; the Push Broker commits as $E2E_BROKER_LOGIN"
  echo "== the browser: request to merged PR"
  E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:$AISDLC_BFF_PORT}" node "$repo_root/platform/compose/e2e-pr.mjs"
  echo "== the ledger: a checkpoint co-signed by the Witness, verify-ledger"
  ./verify-ledger.sh --wait "${E2E_LEDGER_WAIT:-360}" || fail "the ledger did not verify"
  echo "e2e-pr: PASS (attached to project $COMPOSE_PROJECT_NAME)"
  exit 0
fi

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-e2e-pr}"
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.236}"
# its own published ports (the portal and Keycloak), so it runs beside a stack on the default 8340 and 8390
export AISDLC_BFF_PORT="${AISDLC_BFF_PORT:-8640}" AISDLC_OIDC_PORT="${AISDLC_OIDC_PORT:-8690}"
export AISDLC_IMAGE_TAG="${AISDLC_IMAGE_TAG:-${E2E_PR_TAG:-e2e-pr}}"
[ -n "${ONBOARDING_TAG:-}" ] && export SANDBOX_ONBOARDING_TAG="$ONBOARDING_TAG"
full_images
[ "${E2E_UP_ONLY:-0}" = 1 ] && export E2E_KEEP=1
# core-worker on the real ports (full-env.sh), the testbed allow-listed; the gateway's fake answers with the testbed
# fixtures (they script the coding sessions and the reviews for the fake testbed: a test's choice, never the owner's)
full_wiring reshif/asf-factory-testbed
export SEED_FAKE_FIXTURES=testbed
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
# portal v2: the factory App's key is read from Vault, where the browser run pastes it first (the registry row and the
# codehost name the Vault field; E2E_APP_KEY_FILE=1 keeps the mounted file instead)
[ "${E2E_APP_KEY_FILE:-0}" = 1 ] || export AISDLC_GITHUB_APP_KEY_REF='vault:codehost/github-app-key#value'
full_scratch "${SANDBOX_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-e2e-pr-scratch.XXXXXX")}"
evidence_dir=$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-e2e-pr-evidence.XXXXXX")
chmod 755 "$evidence_dir"

dc() { docker compose --profile fake-github --profile full "$@"; }

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    echo; echo "== e2e-pr FAILED (exit $code): service states, then the tail of each log"
    dc ps -a 2>&1 || true
    dc logs --no-color --tail 60 2>&1 | grep -v 'tick ok' | tail -300 || true
  fi
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "== E2E_KEEP=1: stack left running (project $COMPOSE_PROJECT_NAME, subnets $AISDLC_SUBNET_PREFIX, scratch $SANDBOX_SCRATCH)"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    # the run's own sandboxes, if a session outlived the controller: the ones whose repo copy is under this run's scratch
    for c in $(docker ps -aq --filter label=aisdlc.sandbox=1); do
      if docker inspect "$c" --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep -q "$SANDBOX_SCRATCH"; then
        docker rm -f "$c" >/dev/null 2>&1 || true
      fi
    done
    rm -rf "$SANDBOX_SCRATCH" "$evidence_dir" 2>/dev/null || true
    echo "== stack removed (down -v): $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) containers, $(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) volumes left"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== init-secrets"
./init-secrets
full_fake_apps "${E2E_APPS:-two}"
export E2E_BROKER_LOGIN="${PUSH_BROKER_LOGIN:-aisdlc[bot]}"
full_idp_seed "$evidence_dir"
# E2E_REUSE=1: the ports are this project's own stack (left by E2E_KEEP), brought up again
[ "${E2E_REUSE:-0}" = 1 ] || full_ports_free

echo "== images ($AISDLC_IMAGE_TAG)"
if [ "${E2E_SKIP_BUILD:-0}" = 1 ]; then
  full_require_images
else
  full_build_images
fi
full_pin_images

echo "== SP-STD-1 on the W image (LF4's evidence)"
full_sp_std_1 "$evidence_dir"

echo "== up -d --wait"
dc up -d --wait --wait-timeout 420

echo "== the operator posts the SP-STD-1 report (core computes the verdict against onboarding.light_tests)"
full_post_sp_std_1 "$evidence_dir/sp-std-1.json"

if [ "${E2E_UP_ONLY:-0}" = 1 ]; then
  echo "== E2E_UP_ONLY=1: the stack is up; run the browser with:"
  echo "   COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME AISDLC_SUBNET_PREFIX=$AISDLC_SUBNET_PREFIX node platform/compose/e2e-pr.mjs"
  exit 0
fi

echo "== the browser: request to merged PR"
E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:$AISDLC_BFF_PORT}" node "$repo_root/platform/compose/e2e-pr.mjs"

echo "== the ledger: a checkpoint co-signed by the Witness, verify-ledger"
./verify-ledger.sh --wait 150 || fail "the ledger did not verify"
echo "e2e-pr: PASS"
