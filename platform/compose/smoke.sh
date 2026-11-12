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
#   7. the ledger (M8.0b): core-worker's checkpointer has the Notary sign a tree head and the Witness
#      co-sign it (CHECKPOINT_INTERVAL_MS is 15 s here, 5 min by default); verify-ledger.sh then
#      runs the bundled `verify-ledger` against the record database with the two public keys from
#      kms-local, and it must pass
#   8. the kill switch (M9.6, AR9): a project is killed at the kill switch (its own service, database and
#      key; the operator token, the way a person reaches it when core is down), core-worker's admission
#      probe answers `killed` for that project and `admitted` for another, core-worker records the kill
#      switch's journal as `kill.observed` facts and `kill.event` ledger entries (through the Notary),
#      the release (two factory admins) lifts it, and verify-ledger still passes
#   9. the model gateway (M10): the vendor key is mounted in the gateway and in no other container (nor in
#      any environment or log), the gateway has no route to the trust plane and nobody but it is on its
#      egress network, a fake-provider call through a per-Unit virtual key succeeds and is metered as a
#      ModelCall record event (no text), a D3 call is refused, a spent budget stops the key and raises
#      ET1, and a killed project's calls are refused by the real kill switch
#  10. (M10 follow-ups, M10.4) the gateway's database role is least-privilege (refused on every other context,
#      on UPDATE and DELETE of the record and on DDL; sees only its own events), the GitHub App and the model
#      providers are rows of the integration registry, both the gateway and the codehost reload from it, and
#      core serves the health tiles and the events
#  11. the sandbox plane (M13.2, profile `sandbox`): the two Docker socket proxies are the ONLY containers that mount
#      the socket; one K session and one K-exec run through the coding proxy (K has no NIC, K-exec reaches the
#      package mirror on its per-session internal network and nothing else); a create body with Privileged=true
#      (and host network, host PID, an added capability, the socket as a bind, a root user, exec, build, pull) is
#      refused by the proxy; no sandbox container, network or scratch directory is left behind
#  12. per-service memory (docker stats), then `down -v`, also on failure or Ctrl-C
#
# SMOKE_SKIP_BUILD=1   use the image aisdlc/factory:local as it is (a network that blocks apt or
#                      the npm registry: build it yourself, see README.md)
# SMOKE_KEEP=1         leave the stack running at the end (you remove it with `docker compose down -v`)
set -euo pipefail
cd "$(dirname "$0")"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-smoke}"
# its own subnets (docker-compose.yml: every network has a /24 under this prefix), so it can run beside another stack
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.232}"
# The checkpointer runs every 5 minutes by default; a smoke test cannot wait that long.
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
# core-worker records the kill switch's journal every few seconds; a smoke test cannot wait for the default.
export KILL_OBSERVER_INTERVAL_MS="${KILL_OBSERVER_INTERVAL_MS:-3000}"
export KILL_HOLDERS_INTERVAL_MS="${KILL_HOLDERS_INTERVAL_MS:-5000}"
# The sandbox plane (profile `sandbox`): the daemon socket's group for the two proxies, and a scratch directory the
# sandbox driver writes repo copies to (the same path in the client container and for the daemon).
export DOCKER_GID="${DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock)}"
export SANDBOX_IMAGE="${SANDBOX_IMAGE:-aisdlc/sandbox:local}"
SANDBOX_SCRATCH="${SANDBOX_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-smoke-scratch.XXXXXX")}"
chmod 1777 "$SANDBOX_SCRATCH"
export SANDBOX_SCRATCH
dc() { docker compose --profile fake-github --profile sandbox "$@"; }
dcs() { docker compose --profile fake-github --profile sandbox --profile sandbox-smoke "$@"; }
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
    dcs down -v --remove-orphans >/dev/null 2>&1 || true
    # a failed run must not leave sandboxes behind either
    docker ps -aq --filter "label=aisdlc.sandbox=1" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "label=aisdlc.sandbox=1" | xargs -r docker network rm >/dev/null 2>&1 || true
    rm -rf "$SANDBOX_SCRATCH"
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
# the sandbox image: the pinned node base, a non-root user and the wrapper; nothing is fetched (the base is local)
if [ "${SMOKE_SKIP_BUILD:-0}" = 1 ] && docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  echo "  sandbox image $SANDBOX_IMAGE as it is"
else
  docker build -q -t "$SANDBOX_IMAGE" ../sandbox >/dev/null || fail "the sandbox image did not build"
fi

# the W (coding session) image: the sandbox image plus the coding runner and the agent harness binary (M13.4)
export SANDBOX_AGENT_IMAGE="${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local}"
if [ "${SMOKE_SKIP_BUILD:-0}" = 1 ] && SANDBOX_IMAGE="$SANDBOX_IMAGE" SANDBOX_AGENT_IMAGE="$SANDBOX_AGENT_IMAGE" bash ../sandbox/build-agent.sh --check 2>/dev/null; then
  echo "  W image $SANDBOX_AGENT_IMAGE as it is"
else
  SANDBOX_IMAGE="$SANDBOX_IMAGE" SANDBOX_AGENT_IMAGE="$SANDBOX_AGENT_IMAGE" bash ../sandbox/build-agent.sh >/dev/null || fail "the W (coding session) image did not build"
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
[ "$services" -ge 16 ] || fail "expected the whole stack, found $services services"

step "the boundaries hold"
# `5432/tcp -> :0` is postgres' EXPOSE, not a published port; a published one reads `-> 127.0.0.1:8340`.
published=$(dc ps --format '{{.Service}}={{.Publishers}}' | grep -E '=.*-> [0-9.]+:[1-9]' | cut -d= -f1 | sort | tr '\n' ' ')
echo "  published ports: ${published:-none}"
[ "$published" = "bff dev-oidc " ] || fail "only bff and dev-oidc may publish ports"
# M13.2: the two sandbox proxies are the only containers that mount the Docker socket (an allow-list in front of it)
sock=$(docker inspect $(dc ps -aq) --format '{{index .Config.Labels "com.docker.compose.service"}} {{range .Mounts}}{{.Source}} {{end}}' | grep 'docker.sock' | cut -d' ' -f1 | sort | tr '\n' ' ')
echo "  containers mounting the Docker socket: ${sock:-none}"
[ "$sock" = "docker-proxy-coding docker-proxy-cvw " ] || fail "only docker-proxy-cvw and docker-proxy-coding may mount the Docker socket (found: ${sock:-none})"
echo "  only the two allow-list proxies mount the Docker socket"
for p in docker-proxy-cvw docker-proxy-coding; do
  id=$(dc ps -q "$p")
  [ "$(docker inspect "$id" --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}')" = "true [ALL] $(sed -n 's/^AISDLC_UID=//p' .env):$(sed -n 's/^AISDLC_GID=//p' .env)" ] || fail "$p is not read-only, cap-dropped and non-root"
done
echo "  both proxies are read-only, drop all capabilities and run as the factory uid" 
others=$(for s in $(dc ps --format '{{.Service}}'); do
  [ "$s" = codehost ] && continue
  dc exec -T "$s" test -e /run/secrets/github-app.pem 2>/dev/null && echo "$s"
done || true)
[ -z "$others" ] || fail "the GitHub App key is mounted in: $others"
dc exec -T codehost test -s /run/secrets/github-app.pem || fail "the codehost has no App key"
echo "  the GitHub App key is mounted in codehost and nowhere else"
# M10.1: the model vendor key is a file only the gateway mounts; no other container can read it, and it
# is in no container's environment.
akey_others=$(for s in $(dc ps --format '{{.Service}}'); do
  [ "$s" = gateway ] && continue
  dc exec -T "$s" test -e /run/secrets/anthropic-api-key 2>/dev/null && echo "$s"
done || true)
[ -z "$akey_others" ] || fail "the vendor key is mounted in: $akey_others"
dc exec -T gateway test -s /run/secrets/anthropic-api-key || fail "the gateway has no vendor key"
akey_value="$(cat secrets/anthropic-api-key)"
[ -n "$akey_value" ] || fail "the vendor key file is empty"
akey_env=$(docker inspect $(dc ps -aq) --format '{{json .Config.Env}}' | grep -cF -- "$akey_value" || true)
[ "$akey_env" = 0 ] || fail "the vendor key is in a container's environment"
echo "  the vendor key is mounted in the gateway and nowhere else, and is in no environment"
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
# AR9: the kill switch is on its own network. It has no route to core (the API with write and command
# routes) or to anything else but its signer and its database, and core, the Notary and the codehost have
# none to it. The one core-side process on its network is core-worker, which it must share a network
# with (it reads and pushes); core-worker's HTTP surface is /healthz, /metrics and /admission, nothing
# writes, and the kill switch has no client that calls it.
refused killswitch http://core:8380/healthz      # no route to core's write or command APIs
refused killswitch http://notary:8310/healthz
refused core http://killswitch:8400/healthz      # core is not on the kill switch's network
refused notary http://killswitch:8400/healthz
refused codehost http://killswitch:8400/healthz
refused bff http://killswitch:8400/healthz
# M10.1: the gateway holds a vendor key and has egress: it has no route to the trust plane or to core, and
# nothing but it is on its egress network. (Its one link into the trust plane is the kill switch's READ
# API, which it must ask before every call.)
# (core-worker is on gateway-api since M12, the work driver being the gateway's caller, so the gateway can read
# its three read-only routes, healthz, metrics and admission; a network is symmetric and core-worker has no
# route that writes. It is not in this list for that reason.)
for t in http://kms-local:8300/healthz http://notary:8310/healthz http://witness:8320/healthz \
         http://identity:8330/healthz http://core:8380/healthz \
         http://codehost:8350/healthz http://knowledge:8370/healthz http://bff:8340/healthz; do
  refused gateway "$t"
done
for from in core identity knowledge codehost bff notary witness kms-local; do
  refused "$from" http://gateway:8410/healthz     # nobody calls the gateway but the work driver's process (M11, M12) and later a sandbox (M13), on gateway-api
done
# M12: core-worker runs the work driver, which mints each agent run's key and calls /v1/messages under it
dc exec -T core-worker node -e "fetch('http://gateway:8410/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || fail "core-worker cannot reach the gateway it mints agent keys at"
echo "  core-worker (the work driver) is the one service on gateway-api"
gw_api=$(docker network inspect "${COMPOSE_PROJECT_NAME}_gateway-api" --format '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | sed "s/^${COMPOSE_PROJECT_NAME}-//; s/-1$//" | grep -v '^$' | sort | tr '\n' ' ')
[ "$gw_api" = "core-worker gateway " ] || fail "unexpected services on the gateway's API network: $gw_api"
dc exec -T gateway node -e "fetch('http://killswitch:8400/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || fail "the gateway cannot reach the kill switch it must ask"
echo "  gateway can reach the kill switch (its read link), nothing else of the stack"
gw_nets=$(docker inspect "$(dc ps -q gateway)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed "s/^${COMPOSE_PROJECT_NAME}_//" | grep -v '^$' | sort | tr '\n' ' ')
echo "  gateway networks: $gw_nets"
[ "$gw_nets" = "data-gateway gateway-api gateway-egress killswitch-gateway " ] || fail "the gateway is on unexpected networks: $gw_nets"
on_egress=$(docker network inspect "${COMPOSE_PROJECT_NAME}_gateway-egress" --format '{{range .Containers}}{{.Name}} {{end}}')
[ "$(printf '%s' "$on_egress" | wc -w)" = 1 ] || fail "something else is on the gateway's egress network: $on_egress"
echo "  nothing but the gateway is on gateway-egress"
if dc exec -T killswitch sh -c 'test -e /run/secrets/db-url-aisdlc || test -e /run/secrets/tok-core-notary || ls /run/secrets | grep -q "^tok-.*-core$"' 2>/dev/null; then
  fail "the kill switch holds a secret of core's"
fi
echo "  the kill switch mounts only its own database URL and tokens (no core, no record database)"

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
jar=$(mktemp); trap 'rc=$?; rm -f "$jar"; (exit "$rc"); cleanup' EXIT
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

step "the kill switch: kill a project, admission refused, observed and ledgered, release, admitted"
# The operator token reaches the kill switch directly (the path a person has when core is down); alice
# and bob are the factory admins it is configured with. core-worker's admission probe asks the kill switch
# the way the work driver does before it dispatches a stage command.
ksnode() { dc exec -T -e TOKEN="$(cat secrets/tok-operator-killswitch)" killswitch node -e "$1"; }
cwnode() { dc exec -T core-worker node -e "$1"; }
admission() { # project -> prints "<http status> <json>"
  cwnode "fetch('http://127.0.0.1:8360/admission?project_id=$1&lane=L3').then(async r=>console.log(r.status, await r.text()))"
}
a0=$(admission testbed); echo "  before the kill: testbed $a0"
case "$a0" in 200*) ;; *) fail "admission was not given before any kill: $a0" ;; esac
kid=$(ksnode '
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const r = await fetch("http://127.0.0.1:8400/v1/kills", { method: "POST", headers: h,
  body: JSON.stringify({ on_behalf_of: "alice", scope: { kind: "project", ref: "testbed" }, reason: "smoke test" }) });
const k = await r.json();
if (r.status !== 201) { console.error(JSON.stringify(k)); process.exit(1); }
console.log(k.kill_id);
') || fail "the kill was refused"
echo "  killed project testbed at the kill switch: $kid"
a1=$(admission testbed); echo "  after the kill:  testbed $a1"
case "$a1" in 423*killed*) ;; *) fail "admission was not refused for the killed project: $a1" ;; esac
a2=$(admission other-project); echo "  another project: $a2"
case "$a2" in 200*) ;; *) fail "a project with no kill was refused: $a2" ;; esac
# a person who holds nothing cannot release it; two factory admins can
ksnode '
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const rel = async (who) => { const r = await fetch("http://127.0.0.1:8400/v1/kills/'"$kid"'/release", { method: "POST", headers: h, body: JSON.stringify({ on_behalf_of: who }) }); return [r.status, await r.json()]; };
const [s0] = await rel("mallory");
if (s0 !== 403) { console.error("a stranger released it", s0); process.exit(1); }
let [, k] = await rel("alice");
if (k.state === "release_pending") [, k] = await rel("bob");
console.log(k.state, k.release_approvals.join("+"));
if (k.state !== "released") process.exit(1);
' || fail "the release did not work"
a3=$(admission testbed); echo "  after the release: testbed $a3"
case "$a3" in 200*) ;; *) fail "admission was not given after the release: $a3" ;; esac
# core-worker pulled the kill switch's journal: facts in the record and entries in the ledger (Notary)
for i in $(seq 1 30); do
  obs=$(PGPW="$(cat secrets/pg-superuser)"; dc exec -T -e PGPASSWORD="$PGPW" postgres psql -U postgres -d aisdlc -At -c "SELECT count(*) FROM record.record_event WHERE type = 'kill.observed'")
  led=$(PGPW="$(cat secrets/pg-superuser)"; dc exec -T -e PGPASSWORD="$PGPW" postgres psql -U postgres -d aisdlc -At -c "SELECT count(*) FROM ledger.ledger_entry WHERE entry_type = 'kill.event'")
  [ "$obs" -ge 3 ] && [ "$led" -ge 3 ] && break
  sleep 2
done
echo "  kill.observed facts: $obs, kill.event ledger entries: $led (requested, approvals, released)"
[ "$obs" -ge 3 ] && [ "$led" -ge 3 ] || fail "core-worker did not record the kill switch journal"
dc logs --no-log-prefix --no-color core-worker 2>&1 | grep -qi 'kill_observer.*fail' && fail "the kill observer failed"

step "a checkpoint co-signed by the Witness, and verify-ledger passes"
./verify-ledger.sh --wait 150 || fail "the ledger did not verify"
cps=$(PGPW="$(cat secrets/pg-superuser)"; dc exec -T -e PGPASSWORD="$PGPW" postgres psql -U postgres -d aisdlc -At -c 'SELECT count(*) FROM ledger.checkpoint')
echo "  checkpoints stored: $cps"
dc logs --no-log-prefix --no-color core-worker 2>&1 | grep -E 'checkpointer.*checkpoint co-signed' | tail -2 | sed 's/^/  /'

step "the model gateway: a per-Unit key, a fake-provider call metered, D3 refused, a spent budget stops the key and raises ET1, a kill is honoured"
psqlq() { local pw; pw="$(cat secrets/pg-superuser)"; dc exec -T -e PGPASSWORD="$pw" postgres psql -U postgres -d aisdlc -At -c "$1"; }
# The operator token reaches the admin API from inside the gateway (the way a person does until the work
# engine mints keys, M11). Keys are minted for a project, an item and a unit; the secret comes back once.
gwnode() { dc exec -T -e TOKEN="$(cat secrets/tok-operator-gateway)" -e KTOKEN="$(cat secrets/tok-operator-killswitch)" gateway node -e "$1"; }
gwnode '
const base = "http://127.0.0.1:8410";
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const j = async (r) => [r.status, await r.json()];
const must = (c, m) => { if (!c) { console.error("  FAIL: " + m); process.exit(1); } };
const group = async (id, max_tokens) => must((await j(await fetch(base + "/v1/admin/budget-groups", { method: "POST", headers: h, body: JSON.stringify({ group_id: id, max_tokens, max_cost_micro_usd: 1000000 }) })))[0] === 201, "budget group " + id);
const mint = async (over) => {
  const [st, b] = await j(await fetch(base + "/v1/admin/vkeys", { method: "POST", headers: h, body: JSON.stringify({
    scope: { kind: "unit", ref: over.unit }, project_id: over.project ?? "smoke-gw", data_class_max: over.dc ?? "D2",
    models: ["fake-model"], tools: ["read_file"], budget_group: over.group, item_id: over.item ?? "smoke-item", unit_id: over.unit, step: "6.4",
    expires_at: new Date(Date.now() + 3600000).toISOString() }) }));
  must(st === 201 && /^aisk_[0-9a-f]{48}$/.test(b.key), "mint " + st + JSON.stringify(b));
  return b.key;
};
const call = async (key, body, headers = {}) => j(await fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const ask = (text, max_tokens = 20) => ({ model: "claude-sonnet-5-5", max_tokens, messages: [{ role: "user", content: text }] });

await group("smoke-g1", 100000); await group("smoke-g2", 60); await group("smoke-g3", 100000);
const k1 = await mint({ group: "smoke-g1", unit: "smoke-u1" });
const [s1, r1] = await call(k1, ask("smoke prompt one"));
must(s1 === 200 && r1.type === "message" && r1.content[0].text.startsWith("fake reply") && r1.usage.input_tokens > 0, "the fake-provider call: " + s1 + JSON.stringify(r1));
console.log(`  call through the virtual key: ${s1}, "${r1.content[0].text}", usage ${JSON.stringify(r1.usage)}`);
// D3 is never routed, even for a key that says D3
const kd3 = await mint({ group: "smoke-g1", unit: "smoke-u3", dc: "D3" });
const [s3, r3] = await call(kd3, ask("smoke prompt d3"), { "x-aisdlc-data-class": "D3" });
must(s3 === 403 && r3.error.code === "d3_never_routed", "D3 was not refused: " + s3 + JSON.stringify(r3));
console.log(`  D3 call: ${s3} ${r3.error.code}`);
const [sx] = await call("aisk_" + "0".repeat(48), ask("x"));
must(sx === 401, "an unknown key was served");
const [st] = await call(k1, { ...ask("smoke prompt tool"), tools: [{ name: "run_shell", input_schema: { type: "object" } }] });
must(st === 403, "a tool outside the allow-list was served");
console.log(`  unknown key: ${sx}, tool outside the allow-list: ${st}`);
// a spent budget stops the key
const k2 = await mint({ group: "smoke-g2", unit: "smoke-u2", item: "smoke-item-2" });
let spent = 0;
for (let i = 0; i < 8 && spent === 0; i++) { const [s] = await call(k2, ask("smoke prompt budget " + i, 30)); if (s === 429) spent = i + 1; }
must(spent > 0, "the budget never stopped the key");
const [s429, r429] = await call(k2, ask("again"));
must(s429 === 429 && r429.error.code === "budget_exhausted", "a spent key was served");
console.log(`  budget group smoke-g2 (60 tokens) stopped the key at call ${spent}: ${s429} ${r429.error.code}`);
// the real kill switch is honoured
const k3 = await mint({ group: "smoke-g3", unit: "smoke-u4", project: "smoke-gw-killed" });
must((await call(k3, ask("before the kill")))[0] === 200, "pre-kill call");
const kh = { authorization: `Bearer ${process.env.KTOKEN}`, "content-type": "application/json" };
const [ks, kill] = await j(await fetch("http://killswitch:8400/v1/kills", { method: "POST", headers: kh, body: JSON.stringify({ on_behalf_of: "alice", scope: { kind: "project", ref: "smoke-gw-killed" }, reason: "gateway smoke" }) }));
must(ks === 201, "kill " + ks);
const [sk, rk] = await call(k3, ask("after the kill"));
must(sk === 423 && rk.error.code === "killed", "a killed project was served: " + sk + JSON.stringify(rk));
const rel = async (who) => (await j(await fetch(`http://killswitch:8400/v1/kills/${kill.kill_id}/release`, { method: "POST", headers: kh, body: JSON.stringify({ on_behalf_of: who }) })))[1];
let k = await rel("alice"); if (k.state === "release_pending") k = await rel("bob");
must(k.state === "released", "release " + k.state);
must((await call(k3, ask("after the release")))[0] === 200, "a released project was refused");
console.log(`  kill of project smoke-gw-killed: ${sk} ${rk.error.code}; after the release: 200`);
' || fail "the gateway checks failed"
okcalls=$(psqlq "SELECT count(*) FROM record.record_event WHERE type = 'gateway.model_call' AND body->>'outcome' = 'ok'")
refused_calls=$(psqlq "SELECT count(*) FROM record.record_event WHERE type = 'gateway.model_call' AND body->>'outcome' = 'refused'")
d3=$(psqlq "SELECT count(*) FROM record.record_event WHERE type = 'gateway.model_call' AND body->>'refusal' = 'd3_never_routed'")
et1=$(psqlq "SELECT count(*) FROM record.record_event WHERE type = 'gateway.budget_exhausted' AND body->>'budget_group' = 'smoke-g2' AND body->>'trigger' = 'ET1' AND body->>'item_id' = 'smoke-item-2'")
leaked=$(psqlq "SELECT count(*) FROM record.record_event WHERE type LIKE 'gateway.%' AND (body::text LIKE '%fake reply%' OR body::text LIKE '%smoke prompt%' OR body::text LIKE '%aisk_%')")
echo "  ModelCall events: $okcalls ok, $refused_calls refused ($d3 D3); ET1 for smoke-g2: $et1; events holding text or a key: $leaked"
[ "$okcalls" -ge 3 ] || fail "the calls were not metered as ModelCall events"
[ "$d3" -ge 1 ] || fail "the D3 refusal was not recorded"
[ "$et1" = 1 ] || fail "the spent budget did not raise ET1 exactly once"
[ "$leaked" = 0 ] || fail "a gateway record event holds text or a key"
tokens_seen=$(psqlq "SELECT coalesce(sum((body->>'tokens_in')::int + (body->>'tokens_out')::int), 0) FROM record.record_event WHERE type = 'gateway.model_call' AND body->>'budget_group' = 'smoke-g1'")
[ "$tokens_seen" -gt 0 ] || fail "no tokens were metered"
akey_logs=$(dc logs --no-log-prefix --no-color 2>&1 | grep -cF -- "$akey_value" || true)
[ "$akey_logs" = 0 ] || fail "the vendor key is in a container log"
echo "  the vendor key is in no log; $tokens_seen tokens metered for smoke-g1"
dc logs --no-log-prefix --no-color core-worker 2>&1 | grep -qi 'gateway_triggers.*fail' && fail "the gateway trigger loop failed"

step "the gateway's database role is least-privilege; the integration registry, its reload paths and its health tiles (M10.4)"
# The gateway connects as the login role `gateway` (db-init.sh; the gateway migration grants it): its own tables,
# its own `gateway:` record streams (INSERT and SELECT, never UPDATE or DELETE) and the effective-config view.
gwpsql() { local pw; pw="$(cat secrets/pg-pass-gateway)"; dc exec -T -e PGPASSWORD="$pw" postgres psql -h 127.0.0.1 -U gateway -d aisdlc -At -c "$1" 2>&1 || true; }
for q in "SELECT count(*) FROM identity.principal" "SELECT count(*) FROM core.work_item" "SELECT count(*) FROM security_findings.finding" "SELECT count(*) FROM ledger.ledger_entry" "SELECT count(*) FROM config.config_revision" "UPDATE record.record_event SET actor = 'x'" "DELETE FROM record.record_event" "CREATE TABLE gateway.evil (x int)"; do
  out=$(gwpsql "$q")
  printf '%s' "$out" | grep -qi 'permission denied' || fail "the gateway role was not refused: $q -> $out"
done
other_streams=$(gwpsql "SELECT count(*) FROM record.record_event WHERE stream NOT LIKE 'gateway:%'")
[ "$other_streams" = 0 ] || fail "the gateway role can see $other_streams events of other contexts"
mine=$(gwpsql "SELECT count(*) FROM record.record_event WHERE stream LIKE 'gateway:%'")
[ "$mine" -gt 0 ] || fail "the gateway role cannot see its own events ($mine)"
echo "  gateway role: refused on identity, core, security_findings, the ledger and config tables, and on UPDATE, DELETE and DDL; sees only its own $mine record events"
# Reload paths (no restart): the gateway re-reads the published config and rebuilds its adapters, the
# codehost re-reads its row from core. Operator tokens, from inside each container.
gwnode '
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const r = await fetch("http://127.0.0.1:8410/v1/admin/reload", { method: "POST", headers: h, body: "{}" });
const j = await r.json();
if (r.status !== 200) { console.error("reload", r.status, JSON.stringify(j)); process.exit(1); }
const by = Object.fromEntries(j.integrations.map((i) => [i.integration_id, i.state]));
if (by.fake !== "built" || by.anthropic !== "built") { console.error("providers not built", JSON.stringify(j)); process.exit(1); }
console.log(`  gateway reload: revision ${String(j.revision).slice(0, 12)}, providers ${JSON.stringify(by)}`);
' || fail "the gateway reload failed"
ch=$(dc exec -T -e T="$(cat secrets/tok-operator-codehost)" codehost node -e '
const r = await fetch("http://127.0.0.1:8350/v1/admin/reload", { method: "POST", headers: { authorization: `Bearer ${process.env.T}`, "content-type": "application/json" }, body: "{}" });
const j = await r.json();
console.log(r.status + " " + j.state + " " + j.detail);
')
echo "  codehost reload: $ch"
[ "$ch" = "200 serving ok" ] || fail "the codehost is not serving from its registry row: $ch"
coreget() { dc exec -T -e T="$(cat secrets/tok-operator-core)" core node -e "const r = await fetch('http://127.0.0.1:8380$1', { headers: { authorization: 'Bearer ' + process.env.T } }); console.log(await r.text());"; }
tiles=$(coreget /v1/integrations/health)
printf '%s' "$tiles" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const t = JSON.parse(s);
  const by = Object.fromEntries(t.tiles.map((x) => [x.integration_id, x]));
  for (const id of ["github-app", "anthropic", "fake"]) if (!by[id]) { console.error("no tile for " + id); process.exit(1); }
  if (by["github-app"].kind !== "code_host" || by.fake.kind !== "model_provider") { console.error("kinds"); process.exit(1); }
  if (by["github-app"].state === "down" || by.fake.state === "down") { console.error("a tile is down: " + s); process.exit(1); }
  console.log("  health tiles: " + t.tiles.map((x) => `${x.integration_id}=${x.state}(${x.detail_code})`).join(" ") + ` (registry ${String(t.registry_revision).slice(0, 12)})`);
});
' || fail "the health tiles are wrong"
events=$(coreget /v1/integrations/events)
printf '%s' "$events" | grep -q '"github-app"' || fail "no IntegrationEvent for the GitHub App"
echo "  integration events: $(printf '%s' "$events" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length+" ledgered"))')"

step "the sandbox plane: one K and one K-exec session through the coding proxy, a privileged create refused, nothing left behind (M13.2)"
# the coding proxy and the mirror are healthy (up --wait did that); run the client on the coding proxy's network
dcs run --rm --no-deps -T sandbox-smoke || fail "the sandbox smoke client failed"
left=$(docker ps -aq --filter "label=aisdlc.sandbox=1" | wc -l)
nets=$(docker network ls -q --filter "label=aisdlc.sandbox=1" | wc -l)
dirs=$(find "$SANDBOX_SCRATCH" -mindepth 1 -maxdepth 1 | wc -l)
echo "  left behind: $left sandbox containers, $nets session networks, $dirs scratch directories"
[ "$left" = 0 ] && [ "$nets" = 0 ] && [ "$dirs" = 0 ] || fail "the sandbox plane left something behind"
# the peers are back to their own network only (the session networks are gone)
mirror_nets=$(docker inspect "$(dc ps -q package-mirror)" --format '{{len .NetworkSettings.Networks}}')
[ "$mirror_nets" = 1 ] || fail "the package mirror is still attached to $mirror_nets networks"
echo "  the package mirror is on its own network only again"

step "memory at idle (docker stats, once)"
docker stats --no-stream --format '  {{printf "%-34s" .Name}} {{.MemUsage}}' $(dc ps -q) | sort
echo
echo "smoke: PASS"
