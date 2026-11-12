#!/usr/bin/env bash
# The load test (PLAN M19; ADR-0003 "Rating", item 2): 3 to 5 projects with 20 to 50 items each, driven through the
# real work engine of the local-prod stack with the fakes behind its ports (the fake GitHub, the gateway's fake
# provider, the deterministic stage ports: CORE_WORKER_STAGE_PORTS=fake, so no sandbox runs), measured from outside.
# Run it as `npm run load:compose` or `platform/compose/load.sh`. Needs Docker with Compose v2; no credentials.
#
#   1. init-secrets, the image (unless LOAD_SKIP_BUILD=1), `up -d --wait` (project aisdlc-load, subnets 10.234)
#   2. `aisdlc-load seed` (the one-shot `load` service): the load projects, their settings through M1, identity binds
#   3. while `aisdlc-load run` submits the items, acts for the people and reads the floor, the fleet and the inbox,
#      this script samples every service's memory (`docker stats`) and Postgres's connections (pg_stat_activity)
#   4. the report: docs/evidence/load-m19.json (everything, with the machine it ran on) and load-m19.md (load-report.mjs)
#   5. `down -v`, also on failure or Ctrl-C (LOAD_KEEP=1 leaves the stack up)
#
# LOAD_PROJECTS (4), LOAD_ITEMS (30 per project), LOAD_CODING_CAP (4), LOAD_CONCURRENCY (8), LOAD_BURST (20),
# WORK_DRIVER_INTERVAL_MS (1000: the driver's poll), LOAD_OUT (docs/evidence/load-m19), LOAD_SKIP_BUILD, LOAD_KEEP,
# LOAD_BUNDLE (a built aisdlc-load.js to run instead of the image's).
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-load}"
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.234}"
export AISDLC_FACTORY_IMAGE="${AISDLC_FACTORY_IMAGE:-aisdlc/factory:local}"
export CORE_WORKER_STAGE_PORTS=fake
export WORK_DRIVER_INTERVAL_MS="${WORK_DRIVER_INTERVAL_MS:-1000}"
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-60000}"
# the published ports move out of the way of another stack on this host (nothing here uses them)
export BFF_HOST_PORT="${BFF_HOST_PORT:-18340}"
export DEV_OIDC_HOST_PORT="${DEV_OIDC_HOST_PORT:-18390}"
out="${LOAD_OUT:-$repo_root/docs/evidence/load-m19}"
work="$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-load.XXXXXX")"
dc() { docker compose --profile fake-github "$@"; }
dcl() { docker compose --profile fake-github --profile load "$@"; }
fail() { echo "load: FAIL: $*" >&2; exit 1; }
sampler_pid=""
# LOAD_BUNDLE: a freshly built services/core/dist/aisdlc-load.js run instead of the image's (iterating on the tool)
bundle_mount=()
[ -n "${LOAD_BUNDLE:-}" ] && bundle_mount=(-v "$(cd "$(dirname "$LOAD_BUNDLE")" && pwd)/$(basename "$LOAD_BUNDLE"):/app/services/core/dist/aisdlc-load.js:ro")

cleanup() {
  local code=$?
  trap - EXIT
  [ -n "$sampler_pid" ] && kill "$sampler_pid" 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    echo; echo "== load FAILED (exit $code): service states, then the tail of each log"
    dc ps -a 2>&1 || true
    dc logs --no-color --tail 30 2>&1 | grep -v 'tick ok' | tail -150 || true
  fi
  if [ "${LOAD_KEEP:-0}" = 1 ]; then
    echo "== LOAD_KEEP=1: stack left running (project $COMPOSE_PROJECT_NAME); remove it with: docker compose --profile fake-github down -v"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    echo "== stack removed (down -v): $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) containers left"
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== init-secrets and image ($AISDLC_FACTORY_IMAGE)"
./init-secrets >/dev/null
if [ "${LOAD_SKIP_BUILD:-0}" = 1 ]; then
  docker image inspect "$AISDLC_FACTORY_IMAGE" >/dev/null 2>&1 || fail "LOAD_SKIP_BUILD=1 but $AISDLC_FACTORY_IMAGE does not exist"
else
  dc build
fi

echo "== up -d --wait (project $COMPOSE_PROJECT_NAME, subnets $AISDLC_SUBNET_PREFIX.*)"
dc up -d --wait --wait-timeout 300

echo "== seed: ${LOAD_PROJECTS:-4} projects"
dcl run --rm --no-deps -T ${bundle_mount[@]+"${bundle_mount[@]}"} load node --enable-source-maps /app/services/core/dist/aisdlc-load.js seed

# the samples, every 5 s: memory per container, Postgres connections per role
pw="$(cat secrets/pg-superuser)"
pg_id="$(dc ps -q postgres)"
(
  while :; do
    t=$(date +%s)
    docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}' \
      $(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") 2>/dev/null |
      sed "s/^/$t|/" >>"$work/mem.txt" || true
    docker exec -e PGPASSWORD="$pw" "$pg_id" psql -U postgres -d postgres -At -c \
      "SELECT coalesce(usename, '(background)'), count(*) FROM pg_stat_activity GROUP BY 1" 2>/dev/null |
      sed "s/^/$t|/" >>"$work/pg.txt" || true
    sleep 5
  done
) &
sampler_pid=$!

echo "== run: ${LOAD_ITEMS:-30} items per project through the engine"
dcl run --rm --no-deps -T ${bundle_mount[@]+"${bundle_mount[@]}"} load >"$work/run.out" 2> >(tee "$work/run.err" >&2) || fail "the load run failed"
kill "$sampler_pid" 2>/dev/null || true
sampler_pid=""
grep '^LOAD_REPORT ' "$work/run.out" | tail -1 | sed 's/^LOAD_REPORT //' >"$work/report.json"
[ -s "$work/report.json" ] || fail "the load run printed no report"

echo "== the report"
LOAD_WORK="$work" LOAD_OUT="$out" \
  LOAD_MACHINE="$(printf '%s|%s|%s|%s|%s' "$(nproc)" "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" \
    "$(awk -F: '/model name/ {print $2; exit}' /proc/cpuinfo | sed 's/^ *//')" "$(uname -r)" \
    "$(docker version --format '{{.Server.Version}}')")" \
  LOAD_SETTINGS="projects=${LOAD_PROJECTS:-4} items=${LOAD_ITEMS:-30} coding_cap=${LOAD_CODING_CAP:-4} concurrency=${LOAD_CONCURRENCY:-8} driver_interval_ms=$WORK_DRIVER_INTERVAL_MS image=$AISDLC_FACTORY_IMAGE commit=$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  node "$repo_root/platform/compose/load-report.mjs"
echo "load: PASS ($out.json, $out.md)"
