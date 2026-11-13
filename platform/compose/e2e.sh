#!/usr/bin/env bash
# Browser test of the portal on the local-prod stack, on the fake GitHub (PLAN M8.1 to M8.4).
# Needs Docker with Compose v2 and Playwright with Chromium (`require('playwright')` must resolve;
# set PW_CHROMIUM to a Chromium binary if the default one is not installed). No credentials.
# Run it as `npm run e2e:compose` or `platform/compose/e2e.sh`.
#
#   1. init-secrets, build the image (the web bundle is built inside it), `up -d --wait`
#   2. e2e-portal.mjs drives a real Chromium through the whole Census onboarding of
#      reshif/asf-factory-testbed as alice: request in the wizard, card 1 (gaps, T0, regulatory,
#      criticality), card 4 (attestations, role map, two-person off), the settings revision card 4
#      proposed (decided and published), card 5 with a step-up re-login at the dev IdP, then the
#      readiness record (active, level census), S0 done, and the ledger page with every entry.
#      Screenshots at deviceScaleFactor 2 in docs/screenshots/ (inbox, C1, C4, C5, PRR, ledger, S0)
#   3. the fake GitHub's request log: its REST API saw GETs only (plus the App's token mint) and git
#      was only fetched from, the whole way through
#   4. `down -v`, also on failure or Ctrl-C
#
# E2E_SKIP_BUILD=1    use the image aisdlc/factory:local as it is (see README.md for building it
#                     where apt or the npm registry are blocked)
# E2E_KEEP=1          leave the stack running (remove it with `docker compose --profile fake-github down -v`)
# E2E_SCREENSHOT_DIR=dir where to write the screenshots (default: docs/screenshots)
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-e2e}"
# its own subnets (docker-compose.yml: every network has a /24 under this prefix), so it can run beside another stack
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.233}"
# M12: the work driver runs the real planning port (S1 to S5); the gateway's local fake provider answers with
# canned outputs and the knowledge token carries the `search` scope (see docker-compose.yml, core-worker).
export CORE_WORKER_STAGE_PORTS="${CORE_WORKER_STAGE_PORTS:-agents}"
# M14.6: S7 over the fakes, scripted to raise the exception gates the browser decides (Q1/SECT, X2, E2, E6).
export CORE_WORKER_FAKE_VERIFY="${CORE_WORKER_FAKE_VERIFY:-exceptions}"
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
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
  docker image inspect "${AISDLC_FACTORY_IMAGE:-aisdlc/factory:local}" >/dev/null 2>&1 || fail "E2E_SKIP_BUILD=1 but the image ${AISDLC_FACTORY_IMAGE:-aisdlc/factory:local} does not exist"
else
  dc build
fi

echo "== up -d --wait"
dc up -d --wait --wait-timeout 300

echo "== the browser test"
E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:8340}" \
E2E_SCREENSHOT_DIR="${E2E_SCREENSHOT_DIR:-$repo_root/docs/screenshots}" \
  node "$repo_root/platform/compose/e2e-portal.mjs"
echo "== S1 ran through the real planning port: artefacts, agent runs, and no model call but the gateway's fake"
sql() { dc exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres psql -U postgres -d aisdlc -At -c "$1"; }
arts=$(sql "SELECT string_agg(type, ',' ORDER BY type) FROM core.artefact" | tr -d '[:space:]')
echo "  artefacts: $arts"
case ",$arts," in *,classification,*) ;; *) fail "no classification artefact: S1 did not run through the planning port";; esac
case ",$arts," in *,intent_block,*) ;; *) fail "no intent block artefact";; esac
echo "== M12.5: the Ready decision made in the browser is one event in the item's stream, allowed by the PDP"
ready=$(sql "SELECT count(*) FROM record.record_event WHERE type = 'item.ready_decided'" | tr -d '[:space:]')
# M14.6: two items (the first decided Ready in the browser, the second through the same route by API)
[ "$ready" = "2" ] || fail "expected two item.ready_decided events, found $ready"
pdp=$(sql "SELECT count(*) FROM record.record_event WHERE type = 'pdp.decision' AND body ->> 'action' = 'item.ready' AND body ->> 'decision' = 'allow'" | tr -d '[:space:]')
[ "$pdp" -ge 1 ] || fail "the PDP's allow of item.ready was not logged"
echo "== M14.6: S7's exception gates decided in the browser, D5 allowed by the PDP"
d5=$(sql "SELECT count(*) FROM record.record_event WHERE type = 'pdp.decision' AND body ->> 'action' = 'item.human_done' AND body ->> 'decision' = 'allow'" | tr -d '[:space:]')
[ "$d5" -ge 3 ] || fail "expected three D5 allows of item.human_done, found $d5"
for g in SECT:reject X2:approve E2:approve E6:reject; do
  n=$(sql "SELECT count(*) FROM record.record_event WHERE type = 'item.gate_decided' AND body::text LIKE '%\"gate\": \"${g%%:*}\"%' AND body::text LIKE '%${g#*:}%'" | tr -d '[:space:]')
  [ "$n" -ge 1 ] || fail "no ${g%%:*} decided ${g#*:} in the record"
  echo "  ${g%%:*}: ${g#*:} ($n)"
done
echo "== the fake GitHub's request log after the whole onboarding"
log=$(dc logs --no-log-prefix --no-color fake-github 2>&1 | grep -E '^fake-github (api|git) ' || true)
api=$(printf '%s\n' "$log" | grep '^fake-github api ' | sed -E 's/^fake-github api \{"method":"([A-Z]+)","path":"([^"]*)".*"status":([0-9]+)\}$/\1 \2 \3/')
gitl=$(printf '%s\n' "$log" | grep '^fake-github git ' | sed -E 's/^fake-github git \{"method":"([A-Z]+)","path":"([^"]*)","query":"([^"]*)","authorized":([a-z]+)\}$/\1 \2\3 authorized=\4/')
[ -n "$api" ] || fail "the fake GitHub saw no REST request at all (is the log readable?)"
echo "  REST API (method, path, how often):"
printf '%s\n' "$api" | sed -E 's/ [0-9]+$//' | sort | uniq -c | sed 's/^/    /'
nonget=$(printf '%s\n' "$api" | grep -v '^GET ' | grep -vE '^POST /app/installations/[0-9]+/access_tokens ' || true)
[ -z "$nonget" ] || fail "the factory sent a non-GET resource request to GitHub: $nonget"
echo "  => only GETs on resources (POST is the App minting its read-only installation token)"
printf '%s\n' "$gitl" | grep -q 'receive-pack' && fail "something tried to push"
printf '%s\n' "$gitl" | grep -q 'authorized=false' && fail "git was asked without a credential"
echo "  => git was only fetched from (upload-pack), every request with the installation token"
echo "== the ledger: a checkpoint co-signed by the Witness, verify-ledger"
./verify-ledger.sh --wait 150 || fail "the ledger did not verify"
echo "e2e: PASS"
