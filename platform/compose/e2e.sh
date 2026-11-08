#!/usr/bin/env bash
# Browser smoke test of the portal on the local-prod stack, on the fake GitHub (PLAN M8.1, M8.2).
# Needs Docker with Compose v2 and Playwright with Chromium (`require('playwright')` must resolve;
# set PW_CHROMIUM to a Chromium binary if the default one is not installed). No credentials.
# Run it as `npm run e2e:compose` or `platform/compose/e2e.sh`.
#
#   1. init-secrets, build the image (the web bundle is built inside it), `up -d --wait`
#   2. e2e-portal.mjs drives a real Chromium: sign in as alice through the dev IdP, request the
#      onboarding of reshif/asf-factory-testbed in the wizard, watch the S0 page until step 0.1 is
#      `card` with card C1 listed; one screenshot (deviceScaleFactor 2) of that page
#   3. `down -v`, also on failure or Ctrl-C
#
# E2E_SKIP_BUILD=1    use the image aisdlc/factory:local as it is (see README.md for building it
#                     where apt or the npm registry are blocked)
# E2E_KEEP=1          leave the stack running (remove it with `docker compose --profile fake-github down -v`)
# E2E_SCREENSHOT=path where to write the screenshot (default: docs/screenshots/m8-s0.png)
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-e2e}"
dc() { docker compose --profile fake-github "$@"; }
fail() { echo "e2e: FAIL: $*" >&2; exit 1; }

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    echo; echo "== e2e FAILED (exit $code): service states, then the tail of each log"
    dc ps -a 2>&1 || true
    dc logs --no-color --tail 40 2>&1 | grep -v 'tick ok' | tail -200 || true
  fi
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "== E2E_KEEP=1: stack left running (project $COMPOSE_PROJECT_NAME); remove it with: docker compose --profile fake-github down -v"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    echo "== stack removed (down -v): $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) containers, $(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) volumes left"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== init-secrets and image"
./init-secrets
for p in 8340 8390; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use on this host (another stack?)"; fi
done
if [ "${E2E_SKIP_BUILD:-0}" = 1 ]; then
  docker image inspect aisdlc/factory:local >/dev/null 2>&1 || fail "E2E_SKIP_BUILD=1 but the image aisdlc/factory:local does not exist"
else
  dc build
fi

echo "== up -d --wait"
dc up -d --wait --wait-timeout 300

echo "== the browser test"
E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:8340}" \
E2E_SCREENSHOT="${E2E_SCREENSHOT:-$repo_root/docs/screenshots/m8-s0.png}" \
  node "$repo_root/platform/compose/e2e-portal.mjs"
echo "e2e: PASS"
