#!/usr/bin/env bash
# Smoke test of the local-prod stack, on the fake GitHub (PLAN M8.0). Needs Docker with Compose v2;
# no credentials. Run it as `npm run smoke:compose` or `platform/compose/smoke.sh`.
#
#   1. init-secrets (a no-op when the secrets exist), build the image
#   2. `up -d --wait`: every service healthy, the one-shot jobs (db-init, migrate, seed) exited 0
#   3. the boundaries hold: only bff and dev-oidc publish a port, no Docker socket anywhere, the App
#      key only in codehost, knowledge cannot reach GitHub, the codehost cannot reach the trust plane,
#      the Notary and the Witness cannot reach each other
#   4. the services talk: a factory admin (alice, from the seed) asks core to onboard the fixture
#      repo, and step 0.1 runs codehost -> knowledge -> census until the S0 record waits at `card`
#      with card 1 required; core-worker's cards loop opens that card (no sync call)
#   5. login through the dev IdP reaches the bff, which knows alice as a factory admin
#   6. the fake GitHub's request log: its REST API saw GETs only (plus the App's token mint) and
#      git was only ever fetched from
#   7. per-service memory (docker stats), then `down -v`, also on failure or Ctrl-C
#
# SMOKE_SKIP_BUILD=1   use the image aisdlc/factory:local as it is (a network that blocks apt or
#                      the npm registry: build it yourself, see README.md)
# SMOKE_KEEP=1         leave the stack running at the end (you remove it with `docker compose down -v`)
set -euo pipefail
cd "$(dirname "$0")"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-smoke}"
dc() { docker compose --profile fake-github "$@"; }
T0=$SECONDS
step() { printf '\n== [%3ss] %s\n' $((SECONDS - T0)) "$*"; }
fail() { echo "smoke: FAIL: $*" >&2; exit 1; }

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    echo; echo "== smoke FAILED (exit $code): service states, then the tail of each log"
    dc ps -a 2>&1 || true
    dc logs --no-color --tail 40 2>&1 | grep -v 'tick ok' | tail -200 || true
  fi
  if [ "${SMOKE_KEEP:-0}" = 1 ]; then
    echo "== SMOKE_KEEP=1: stack left running (project $COMPOSE_PROJECT_NAME); remove it with: docker compose --profile fake-github down -v"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    echo "== stack removed (down -v): $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) containers, $(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) volumes left"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "init-secrets and image"
./init-secrets
# A stack of another project holding the two published ports would fail the start late and obscurely.
for p in 8340 8390; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use on this host (another stack?)"; fi
done
if [ "${SMOKE_SKIP_BUILD:-0}" = 1 ]; then
  docker image inspect aisdlc/factory:local >/dev/null 2>&1 || fail "SMOKE_SKIP_BUILD=1 but the image aisdlc/factory:local does not exist"
else
  dc build
fi

step "up -d --wait (db-init, migrate, seed, then every service)"
dc up -d --wait --wait-timeout 300

step "every service is healthy"
bad=0
while IFS='|' read -r svc state health code; do
  case "$svc" in
    db-init|migrate|seed)
      if [ "$state" = exited ] && [ "$code" = 0 ]; then printf '  %-12s exited 0\n' "$svc"; else printf '  %-12s %s (exit %s)  <-- not ok\n' "$svc" "$state" "$code"; bad=1; fi ;;
    *)
      if [ "$state" = running ] && [ "$health" = healthy ]; then printf '  %-12s healthy\n' "$svc"; else printf '  %-12s %s/%s  <-- not ok\n' "$svc" "$state" "$health"; bad=1; fi ;;
  esac
done < <(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' | sort)
[ "$bad" = 0 ] || fail "a service is not healthy"
services=$(dc ps -a --format '{{.Service}}' | wc -l)
[ "$services" -ge 15 ] || fail "expected the whole stack, found $services services"

step "the boundaries hold"
# `5432/tcp -> :0` is postgres' EXPOSE, not a published port; a published one reads `-> 127.0.0.1:8340`.
published=$(dc ps --format '{{.Service}}={{.Publishers}}' | grep -E '=.*-> [0-9.]+:[1-9]' | cut -d= -f1 | sort | tr '\n' ' ')
echo "  published ports: ${published:-none}"
[ "$published" = "bff dev-oidc " ] || fail "only bff and dev-oidc may publish ports"
sock=$(docker inspect $(dc ps -aq) --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep -c 'docker.sock' || true)
[ "$sock" = 0 ] || fail "a container mounts the Docker socket"
echo "  no container mounts the Docker socket"
others=$(for s in $(dc ps --format '{{.Service}}'); do
  [ "$s" = codehost ] && continue
  dc exec -T "$s" test -e /run/secrets/github-app.pem 2>/dev/null && echo "$s"
done || true)
[ -z "$others" ] || fail "the GitHub App key is mounted in: $others"
dc exec -T codehost test -s /run/secrets/github-app.pem || fail "the codehost has no App key"
echo "  the GitHub App key is mounted in codehost and nowhere else"
refused() { # service url: the request must fail (no route, no name, refused)
  if dc exec -T "$1" node -e "fetch('$2',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
    fail "$1 reached $2"
  fi
  echo "  $1 cannot reach $2"
}
refused knowledge https://api.github.com/zen    # no route to GitHub (it gets bundles from codehost only)
refused knowledge http://example.com/
refused knowledge http://notary:8310/healthz     # nor to the Notary: it is not on notary-api
refused codehost http://kms-local:8300/healthz   # the credential holder has no route to the trust plane
refused codehost http://notary:8310/healthz
refused codehost http://postgres:5432/
refused notary http://witness:8320/healthz       # the two signers cannot see each other (AR9)
refused witness http://notary:8310/healthz
refused bff http://notary:8310/healthz
refused dev-oidc http://kms-local:8300/healthz

step "onboard the fixture repo through core: 0.1 runs codehost -> knowledge -> census"
# alice is a factory admin (the seed); core takes the operator token (scope onboard) on her behalf.
dc exec -T -e TOKEN="$(cat secrets/tok-operator-core)" core node -e '
const base = "http://127.0.0.1:8380";
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const get = async (p) => { const r = await fetch(base + p, { headers: h }); return [r.status, await r.json()]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = "reshif/asf-factory-testbed";
const r = await fetch(base + "/v1/onboard", { method: "POST", headers: h,
  body: JSON.stringify({ project_id: "testbed", repo, level: "census", on_behalf_of: "alice" }) });
const on = await r.json();
if (r.status !== 201 && r.status !== 200) { console.log("  onboard refused", r.status, JSON.stringify(on)); process.exit(1); }
console.log(`  POST /v1/onboard -> ${r.status}; S0 ${on.s0_id}; bootstrap grantee ${on.bootstrap?.grantee ?? "none"}`);
const end = Date.now() + 240000; let last = "";
for (;;) {
  const [, [s0]] = [0, (await get(`/v1/repos/${repo}/s0`))[1]];
  const status = s0?.record.status; const step = s0?.steps.find((x) => x.step === "0.1")?.state;
  const line = `S0 status=${status} step 0.1=${step}`;
  if (line !== last) { console.log("  " + line); last = line; }
  if (status === "card" && step === "card") break;
  if (Date.now() > end) { console.log("  timed out waiting for the card"); process.exit(1); }
  await sleep(2000);
}
// The cards loop of core-worker opens the card by itself; nobody called the sync route.
for (;;) {
  const [st, cards] = await get(`/v1/s0/${on.s0_id}/cards`);
  const c1 = Array.isArray(cards) && cards.find((c) => c.card === "C1" && c.status === "open");
  if (c1) { console.log(`  card C1 (step ${c1.step}) is ${c1.status}, decided by slot ${c1.slot}, actionable=${c1.actionable}`); break; }
  if (Date.now() > end) { console.log("  timed out waiting for card C1", st, JSON.stringify(cards)); process.exit(1); }
  await sleep(2000);
}
' || fail "the onboarding did not reach card 1"
entries=$(PGPW="$(cat secrets/pg-superuser)"; dc exec -T -e PGPASSWORD="$PGPW" postgres psql -U postgres -d aisdlc -At -c 'SELECT count(*) FROM ledger.ledger_entry')
echo "  ledger entries signed by the Notary: $entries"
[ "$entries" -gt 0 ] || fail "the ledger is empty"

step "login through the dev IdP reaches the bff"
jar=$(mktemp); trap 'rm -f "$jar"; cleanup' EXIT
loc=$(curl -fsS -o /dev/null -D- -c "$jar" http://localhost:8340/auth/login | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
[ -n "$loc" ] || fail "/auth/login did not redirect"
back=$(curl -fsS -o /dev/null -D- --resolve dev-oidc.localhost:8390:127.0.0.1 -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data "${loc#*\?}&dev_user=00000000-0000-4000-8000-000000000001" \
  http://dev-oidc.localhost:8390/authorize | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
[ -n "$back" ] || fail "the dev IdP did not send the browser back"
curl -fsS -o /dev/null -b "$jar" -c "$jar" "$back"
me=$(curl -fsS -b "$jar" http://localhost:8340/api/me)
echo "  /api/me: $(printf '%s' "$me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(`${m.principal.principal_id} (${m.principal.display_name}), fleet actions: ${m.actions.fleet.join(", ")}`)})')"
printf '%s' "$me" | grep -q '"project.onboard"' || fail "alice is not a factory admin through the bff"

step "the fake GitHub's request log"
log=$(dc logs --no-log-prefix --no-color fake-github 2>&1 | grep -E '^fake-github (api|git) ')
api=$(printf '%s\n' "$log" | grep '^fake-github api ' | sed -E 's/^fake-github api \{"method":"([A-Z]+)","path":"([^"]*)".*"status":([0-9]+)\}$/\1 \2 \3/')
gitl=$(printf '%s\n' "$log" | grep '^fake-github git ' | sed -E 's/^fake-github git \{"method":"([A-Z]+)","path":"([^"]*)","query":"([^"]*)","authorized":([a-z]+)\}$/\1 \2\3 authorized=\4/')
echo "  REST API (requests: method, path with ids kept, how often):"
printf '%s\n' "$api" | sed -E 's/ [0-9]+$//' | sort | uniq -c | sed 's/^/    /'
nonget=$(printf '%s\n' "$api" | grep -v '^GET ' | grep -vE '^POST /app/installations/[0-9]+/access_tokens ' || true)
[ -z "$nonget" ] || fail "the factory sent a non-GET resource request to GitHub: $nonget"
echo "  => only GETs on resources (POST is the App minting its read-only installation token)"
echo "  git (smart HTTP fetches):"
printf '%s\n' "$gitl" | sort | uniq -c | sed 's/^/    /'
printf '%s\n' "$gitl" | grep -q 'receive-pack' && fail "something tried to push"
printf '%s\n' "$gitl" | grep -q 'authorized=false' && fail "git was asked without a credential"
echo "  => git was only fetched from (upload-pack), every request with the installation token"

step "memory at idle (docker stats, once)"
docker stats --no-stream --format '  {{printf "%-34s" .Name}} {{.MemUsage}}' $(dc ps -q) | sort
echo
echo "smoke: PASS"
