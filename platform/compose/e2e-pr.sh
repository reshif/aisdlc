#!/usr/bin/env bash
# Request to merged PR on the local-prod stack, on fakes (RC-E2E-2, RC-E2E-7). Run it as `npm run e2e:pr`.
# Needs Docker with Compose v2, Node 22 with the repo's node_modules (npm ci) and Playwright's Chromium
# (`require('playwright')` must resolve; PW_CHROMIUM names another Chromium binary). No credentials.
#
#   1. images of its own (tag e2e-pr: the factory image, the sandbox base, the W image, the onboarding probe image), so
#      it never replaces another run's
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
# E2E_SKIP_BUILD=1   use the e2e-pr images as they are (each must exist)
# E2E_KEEP=1         leave the stack running (remove it with `docker compose --profile fake-github --profile full down -v`
#                    and the same COMPOSE_PROJECT_NAME and AISDLC_SUBNET_PREFIX)
# E2E_UP_ONLY=1      bring the stack up (with E2E_KEEP implied) and stop before the browser
# RUNTIME_IMAGE=...  a node:22 bookworm-slim base that already has git, where apt is blocked (see README.md)
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-e2e-pr}"
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.236}"
# its own published ports (the portal and the dev IdP), so it runs beside a stack on the default 8340 and 8390
export AISDLC_BFF_PORT="${AISDLC_BFF_PORT:-8640}" AISDLC_OIDC_PORT="${AISDLC_OIDC_PORT:-8690}"
TAG="${E2E_PR_TAG:-e2e-pr}"
export AISDLC_IMAGE="${AISDLC_IMAGE:-aisdlc/factory:$TAG}"
export SANDBOX_IMAGE="${SANDBOX_IMAGE:-aisdlc/sandbox:$TAG}"
export SANDBOX_AGENT_IMAGE="${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:$TAG}"
ONBOARDING_TAG="${ONBOARDING_TAG:-aisdlc/sandbox-onboarding:$TAG}"
[ "${E2E_UP_ONLY:-0}" = 1 ] && export E2E_KEEP=1
# core-worker on the real ports: planning (S1-S5), coding in W sessions through the controller (S6), verify (S7), the
# Evidence Pack (7.6) and the Push Broker (6.6), the gateway's fake answering with the testbed fixtures
export CORE_WORKER_STAGE_PORTS=agents
export CORE_WORKER_SANDBOX_CONTROLLER_URL=http://sandbox-controller:8430
export CORE_WORKER_VERIFY_URL=http://verify:8440
export CORE_WORKER_PUSH_BROKER=1
export CORE_WORKER_PUSH_BROKER_URL=http://push-broker:8350
export CORE_WORKER_FAKE_VERIFY=default
export SEED_FAKE_FIXTURES=testbed
export SEED_EXEC_ALLOWED_REPOS=reshif/asf-factory-testbed
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
export DOCKER_GID="${DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock)}"
SANDBOX_SCRATCH="${SANDBOX_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-e2e-pr-scratch.XXXXXX")}"
chmod 1777 "$SANDBOX_SCRATCH"
export SANDBOX_SCRATCH
evidence_dir=$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-e2e-pr-evidence.XXXXXX")
chmod 755 "$evidence_dir"

dc() { docker compose --profile fake-github --profile full "$@"; }
fail() { echo "e2e-pr: FAIL: $*" >&2; exit 1; }
sql() { dc exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres psql -U postgres -d aisdlc -At -c "$1"; }

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
# the IdP seed names the issuer with its port: on another port, the stack gets its own copy (the identities are the same)
if [ "$AISDLC_OIDC_PORT" != 8390 ]; then
  export AISDLC_IDP_SEED_FILE="$evidence_dir/idp-seed.json"
  sed "s#http://dev-oidc.localhost:8390#http://dev-oidc.localhost:$AISDLC_OIDC_PORT#g" config/idp-seed.json >"$AISDLC_IDP_SEED_FILE"
  chmod 644 "$AISDLC_IDP_SEED_FILE"
fi
# E2E_REUSE=1: the ports are this project's own stack (left by E2E_KEEP), brought up again
for p in "$AISDLC_BFF_PORT" "$AISDLC_OIDC_PORT"; do
  [ "${E2E_REUSE:-0}" = 1 ] && break
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use on this host (another stack?)"; fi
done

echo "== images ($TAG)"
if [ "${E2E_SKIP_BUILD:-0}" = 1 ]; then
  for i in "$AISDLC_IMAGE" "$SANDBOX_IMAGE" "$SANDBOX_AGENT_IMAGE" "$ONBOARDING_TAG"; do
    docker image inspect "$i" >/dev/null 2>&1 || fail "E2E_SKIP_BUILD=1 but the image $i does not exist"
  done
else
  dc build migrate
  docker build -q -t "$SANDBOX_IMAGE" ../sandbox >/dev/null
  bash ../sandbox/build-agent.sh
  bash ../sandbox/onboarding/build.sh --tag "$ONBOARDING_TAG" >/dev/null
fi
# by digest: the W image (LF4's worker_image and the controller's check), the probe image and its pin lock
SANDBOX_AGENT_IMAGE_ID=$(docker image inspect "$SANDBOX_AGENT_IMAGE" --format '{{.Id}}')
SANDBOX_ONBOARDING_IMAGE=$(docker image inspect "$ONBOARDING_TAG" --format '{{.Id}}')
SANDBOX_ONBOARDING_LOCK_SHA256=$(sha256sum ../sandbox/onboarding/pins.json | cut -d' ' -f1)
label=$(docker image inspect "$ONBOARDING_TAG" --format '{{index .Config.Labels "aisdlc.onboarding.lock.sha256"}}')
[ "$label" = "$SANDBOX_ONBOARDING_LOCK_SHA256" ] || fail "the probe image was built from another pin lock ($label)"
export SANDBOX_AGENT_IMAGE_ID SANDBOX_ONBOARDING_IMAGE SANDBOX_ONBOARDING_LOCK_SHA256
echo "  W image $SANDBOX_AGENT_IMAGE_ID, probe image $SANDBOX_ONBOARDING_IMAGE"

echo "== SP-STD-1 on the W image (LF4's evidence)"
# the report is written before the test's own leftover check (a sandbox of another run on a shared daemon may fail
# that); core computes the verdict itself from the report when it is posted, so a failing report gives no LF4
(cd "$repo_root" && SP_STD_1_EVIDENCE_DIR="$evidence_dir" npx vitest run --project coding-runner isolation >"$evidence_dir/sp-std-1.log" 2>&1) ||
  echo "  (the isolation test exited non-zero; its report is checked by core: $(grep -E 'Tests ' "$evidence_dir/sp-std-1.log" | tr -s ' '))"
[ -s "$evidence_dir/sp-std-1.json" ] || { tail -40 "$evidence_dir/sp-std-1.log"; fail "SP-STD-1 wrote no report"; }
grep -q "\"worker_image\": \"$SANDBOX_AGENT_IMAGE_ID\"" "$evidence_dir/sp-std-1.json" || fail "the SP-STD-1 report is not about $SANDBOX_AGENT_IMAGE_ID"

echo "== up -d --wait"
dc up -d --wait --wait-timeout 420

echo "== the operator posts the SP-STD-1 report (core computes the verdict against onboarding.light_tests)"
node -e 'process.stdout.write(JSON.stringify({kind:"sp-std-1",report:JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}))' "$evidence_dir/sp-std-1.json" |
  dc exec -T core node -e '
    let b = ""; process.stdin.on("data", (d) => (b += d)).on("end", async () => {
      const tok = require("fs").readFileSync("/run/secrets/tok-operator-core", "utf8").trim();
      const r = await fetch("http://127.0.0.1:8380/v1/onboarding/spikes", { method: "POST", body: b,
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
      const j = await r.json(); console.log(`  ${r.status} verdict ${JSON.stringify(j.verdict ?? j)}`);
      process.exit(r.status === 201 && j.verdict?.passed === true ? 0 : 1);
    });' || fail "the SP-STD-1 report was not recorded as passing"

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
