#!/usr/bin/env bash
# Outage drills on a running local-prod stack (PLAN M19; ADR-0003 §9 "What survives what", Rating item 3).
#
#   drill.sh postgres [--hard]    Postgres goes away and comes back (restart; --hard: SIGKILL, then start)
#   drill.sh notary               the Notary is stopped, then started again
#   drill.sh killswitch           the kill switch is stopped, then started again
#   drill.sh runner               a coding (W) session's container is killed mid-session, then the sandbox-controller
#                                 itself is killed mid-session and started again (needs `--profile sandbox`)
#
# Each drill takes the stack as it is (`docker compose up -d --wait` first, in this directory, with the same
# COMPOSE_PROJECT_NAME), breaks one thing, checks what must hold while it is broken, repairs it and checks the
# recovery. It exits 0 only if every check held. The runbooks are docs/runbooks/drill-*.md; they say what each check
# means and what to do when one fails.
#
# What every drill checks after recovery: no factory container restarted (its pools and loops survived), core-worker's
# health is ok again, and the ledger still verifies offline (verify-ledger.sh): no decision was lost or forged.
set -euo pipefail
cd "$(dirname "$0")"

dc() { docker compose "$@"; }
say() { printf '  %s\n' "$*"; }
fail() {
  printf 'drill: FAILED: %s\n' "$*" >&2
  exit 1
}
psql_one() {
  local pw
  pw="$(cat secrets/pg-superuser)"
  dc exec -T -e PGPASSWORD="$pw" postgres psql -U postgres -d aisdlc -At -c "$1"
}
# GET a path on a service from inside core-worker (the services publish no port); prints the status code.
status_of() {
  dc exec -T core-worker node -e '
    fetch(process.argv[1], { signal: AbortSignal.timeout(4000) })
      .then((r) => { console.log(r.status); })
      .catch(() => { console.log(0); });' "$1"
}
# Waits until `status_of URL` prints the expected code, or fails after SECONDS.
wait_status() {
  local url="$1" want="$2" secs="$3" got=""
  local deadline=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$deadline" ]; do
    got="$(status_of "$url" 2>/dev/null || echo 0)"
    if [ "$got" = "$want" ]; then return 0; fi
    sleep 2
  done
  fail "$url answered $got, not $want, within ${secs}s"
}
FACTORY="core core-worker identity knowledge codehost bff notary witness killswitch gateway"
restarts() {
  local s id
  for s in $FACTORY; do
    id="$(dc ps -q "$s" 2>/dev/null || true)"
    [ -n "$id" ] && printf '%s=%s ' "$s" "$(docker inspect -f '{{.RestartCount}}' "$id")"
  done
}
tile() { psql_one "SELECT state FROM core.health_snapshot WHERE tile_id = 'service.$1'" 2>/dev/null || true; }
wait_tile() {
  local svc="$1" want="$2" secs="$3"
  local deadline=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(tile "$svc")" = "$want" ]; then return 0; fi
    sleep 3
  done
  fail "the health tile of $svc did not read $want within ${secs}s (it reads '$(tile "$svc")')"
}
ledger_head() { psql_one 'SELECT coalesce(max(ledger_seq), 0) FROM ledger.ledger_entry'; }
pending_ops() {
  psql_one "SELECT count(*) FROM record.record_event a WHERE a.type = 'ops.action'
              AND NOT EXISTS (SELECT 1 FROM record.record_event l WHERE l.stream = a.stream AND l.type = 'ops.ledgered')"
}
recovered() {
  local before="$1"
  say "core-worker is healthy again"
  wait_status http://127.0.0.1:8360/healthz 200 180
  local after
  after="$(restarts)"
  [ "$after" = "$before" ] || fail "a factory container restarted during the drill: before [$before] after [$after]"
  say "no factory container restarted ($after)"
  say "the ledger verifies offline"
  ./verify-ledger.sh --wait 400
}

drill_postgres() {
  local hard="${1:-}" before head0 head1
  before="$(restarts)"
  head0="$(ledger_head)"
  say "ledger head $head0; restart counts: $before"
  if [ "$hard" = "--hard" ]; then
    say "Postgres: SIGKILL (no clean shutdown), then start"
    dc kill -s SIGKILL postgres
    sleep 3
    dc start postgres
  else
    say "Postgres: restart (every connection dropped)"
    dc restart postgres
  fi
  say "while it comes back: the services stay up and the kill switch answers (its own database is the same server here)"
  local deadline=$((SECONDS + 120))
  until dc exec -T postgres pg_isready -q -U postgres; do
    [ "$SECONDS" -lt "$deadline" ] || fail "Postgres did not come back within 120s"
    sleep 2
  done
  recovered "$before"
  head1="$(ledger_head)"
  [ "$head1" -ge "$head0" ] || fail "the ledger head went back from $head0 to $head1"
  say "the ledger head is $head1 (was $head0): nothing lost"
}

drill_notary() {
  local before head0 pend
  before="$(restarts)"
  head0="$(ledger_head)"
  say "the Notary: stop"
  dc stop notary
  say "while it is down: its tile reads down, the ledger does not move (decisions are refused, not taken)"
  wait_tile notary down 120
  sleep 20
  [ "$(ledger_head)" = "$head0" ] || fail "the ledger moved while the Notary was down"
  pend="$(pending_ops)"
  say "operator actions waiting for the backfill: $pend"
  say "the Notary: start"
  dc start notary
  wait_tile notary ok 120
  say "the backfill ledgers what waited (core-worker's ops_backfill loop, every 60 s)"
  local deadline=$((SECONDS + 180))
  until [ "$(pending_ops)" = "0" ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "$(pending_ops) operator action(s) still not ledgered after 180s"
    sleep 5
  done
  # a stop and a start are not restarts by the restart policy: every count, the Notary's too, must be unchanged
  recovered "$before"
}

drill_killswitch() {
  local before project
  before="$(restarts)"
  project="$(psql_one 'SELECT project_id FROM core.s0_record ORDER BY created_at LIMIT 1' 2>/dev/null || true)"
  project="${project:-drill-project}"
  say "admission for $project before: $(status_of "http://127.0.0.1:8360/admission?project_id=$project")"
  say "the kill switch: stop"
  dc stop killswitch
  say "while it is unreachable: admission answers 423 (unreachable reads killed, AR9)"
  wait_status "http://127.0.0.1:8360/admission?project_id=$project" 423 60
  say "the kill switch: start"
  dc start killswitch
  wait_status "http://127.0.0.1:8360/admission?project_id=$project" 200 120
  say "admission is open again"
  recovered "$before"
}

# ------------------------------------------------------------------ runner killed mid-session (M19)

# The session the drill places, as core-worker's HttpSandbox would: from inside core-worker (its token for the
# sandbox-controller, its network), under the drill item's active admission grant. Prints "<http status> <run status
# or error code>" when the controller answers, "0 <message>" when it does not (the call was cut).
place_session() {
  dc exec -T core-worker node -e '
    const fs = require("node:fs");
    const [grant, sid, secs] = [JSON.parse(process.argv[1]), process.argv[2], Number(process.argv[3])];
    const token = fs.readFileSync("/run/secrets/tok-core-worker-sandbox-controller", "utf8").trim();
    const body = {
      grant,
      spec: {
        session_id: sid,
        class: "W",
        command: secs > 0 ? ["sleep", String(secs)] : ["true"],
        repo: [{ path: "README.md", encoding: "utf8", data: "the runner drill\n" }],
        repo_full_name: "load-org/load-1",
        gateway_key: "aisk_" + "0123456789abcdef".repeat(3),
        limits: { time_s: 900 },
      },
    };
    fetch("http://sandbox-controller:8430/v1/sessions", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_200_000),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        console.log(r.status + " " + (j.status ?? j.error?.code ?? "?"));
      })
      .catch((e) => console.log("0 " + String(e.cause?.code ?? e.message).replace(/\s+/g, "_")));
  ' "$1" "$2" "$3"
}
# "<used in all> <free W>" at the controller
slots_used() {
  dc exec -T core-worker node -e '
    const t = require("node:fs").readFileSync("/run/secrets/tok-core-worker-sandbox-controller", "utf8").trim();
    fetch("http://sandbox-controller:8430/v1/slots", { headers: { authorization: "Bearer " + t } })
      .then((r) => r.json()).then((j) => console.log(j.used_total + " " + j.free.W))
      .catch(() => console.log("? ?"));'
}
# "<containers> <networks> <scratch dirs>" a session left
session_left() {
  local sid="$1" scratch="$2" c n d=0
  c=$(docker ps -aq --filter "name=^aisdlc-sbx-${sid}\$" | wc -l)
  n=$(docker network ls -q --filter "name=^aisdlc-sbx-net-${sid}\$" | wc -l)
  [ -e "$scratch/$sid" ] && d=1
  echo "$c $n $d"
}
wait_running() {
  local sid="$1" deadline=$((SECONDS + 90))
  until [ "$(docker ps -q --filter "name=^aisdlc-sbx-${sid}\$" --filter status=running | wc -l)" = 1 ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "the W session $sid never ran"
    sleep 1
  done
}
json_field() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
grant_state() { psql_one "SELECT status || ' ' || lease_epoch FROM core.admission_grant WHERE grant_id = '$1'"; }
lease_epoch() { psql_one "SELECT epoch FROM core.lease WHERE unit_id = '$1'"; }
item_events() { psql_one "SELECT count(*) FROM record.record_event WHERE stream = 'item:$1'"; }
loadjob() { COMPOSE_PROFILES="$COMPOSE_PROFILES,load" docker compose run --rm --no-deps -T load node /app/services/core/dist/aisdlc-load.js "$@"; }

drill_runner() {
  local before scratch line item grant gid unit epoch epoch0 ev0 sid out work slots0
  # the sandbox plane is a profile: every compose call of this drill sees it
  export COMPOSE_PROFILES="${COMPOSE_PROFILES:-sandbox,fake-github}"
  [ -n "$(dc ps -q sandbox-controller 2>/dev/null)" ] || fail "the sandbox-controller is not running: start the stack with --profile sandbox"
  scratch="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(dc ps -q sandbox-controller)" | sed -n 's/^SANDBOX_CONTROLLER_SCRATCH=//p')"
  [ -d "$scratch" ] || fail "the scratch directory $scratch is not on this host"
  work="$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-drill.XXXXXX")"
  say "the drill item: a load project (aisdlc-load seed), one item whose Unit holds an active grant (it waits at G4)"
  loadjob seed >/dev/null 2>&1 || fail "aisdlc-load seed failed"
  line="$(loadjob item 2>/dev/null | sed -n 's/^LOAD_ITEM //p')"
  [ -n "$line" ] || fail "aisdlc-load item gave no item"
  item="$(printf '%s' "$line" | json_field item_id)"
  grant="$(printf '%s' "$line" | json_field grant)"
  gid="$(printf '%s' "$grant" | json_field grant_id)"
  unit="$(printf '%s' "$grant" | json_field unit_id)"
  epoch="$(printf '%s' "$grant" | json_field lease_epoch)"
  epoch0="$(lease_epoch "$unit")"
  ev0="$(item_events "$item")"
  slots0="$(slots_used)"
  [ "${slots0%% *}" = 0 ] || fail "the runner host is not idle (slots used, free W: $slots0)"
  say "item $item, grant $gid ($(grant_state "$gid")), lease epoch $epoch0, $ev0 item events; slots (used, free W): $slots0"
  before="$(restarts)"

  # 1. the session's container dies (the runner host kills it, the OOM killer, a crashed daemon shim)
  sid="drill-w-$(date +%s)"
  say "1. a W session ($sid, sleep 600) under the grant; its container is killed mid-session"
  place_session "$grant" "$sid" 600 >"$work/one.out" &
  wait_running "$sid"
  say "   running; slots (used, free W): $(slots_used)"
  docker kill "aisdlc-sbx-$sid" >/dev/null
  wait
  out="$(cat "$work/one.out")"
  say "   the controller answered: $out (a void run: no outcome, never a pass)"
  [ "$out" = "200 killed" ] || fail "a killed session answered '$out', not '200 killed'"
  [ "$(slots_used)" = "$slots0" ] || fail "the slot was not freed: slots (used, free W) $(slots_used)"
  [ "$(session_left "$sid" "$scratch")" = "0 0 0" ] ||
    fail "the killed session left something behind (container network scratch: $(session_left "$sid" "$scratch"))"
  say "   the slot is free and nothing of the session is left (container, network, repo copy)"

  # 2. the controller itself dies mid-session: the session's container outlives it
  sid="drill-w-$(($(date +%s) + 1))"
  say "2. a W session ($sid) under the grant; the sandbox-controller is SIGKILLed mid-session"
  place_session "$grant" "$sid" 600 >"$work/two.out" &
  wait_running "$sid"
  dc kill -s SIGKILL sandbox-controller >/dev/null 2>&1
  wait
  out="$(cat "$work/two.out")"
  say "   core's call: $out (cut: the stage command is not answered and is delivered again, same key)"
  case "$out" in 0\ *) ;; *) fail "the call to a killed controller answered '$out'" ;; esac
  say "   left while it is down (container network scratch): $(session_left "$sid" "$scratch")"
  [ "$(session_left "$sid" "$scratch" | cut -d' ' -f1)" = 1 ] || fail "the orphan was expected to outlive the controller"
  dc start sandbox-controller >/dev/null 2>&1
  local deadline=$((SECONDS + 120))
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q sandbox-controller)")" = healthy ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "the sandbox-controller did not come back healthy"
    sleep 2
  done
  say "   the controller is back: $(dc logs --no-log-prefix --since 3m sandbox-controller 2>&1 | grep 'sweep (boot)' | tail -1)"
  [ "$(session_left "$sid" "$scratch")" = "0 0 0" ] ||
    fail "the boot sweep left the dead session behind (container network scratch: $(session_left "$sid" "$scratch"))"
  [ "$(slots_used)" = "$slots0" ] || fail "slots after the restart: $(slots_used)"
  say "   its sweep removed the orphan's container, network and repo copy; slots (used, free W): $(slots_used)"

  # 3. the recovery path: the Unit's grant and lease epoch are what they were, nothing was answered for the item,
  #    and the next session under the same grant (the redelivered command's) starts and ends
  [ "$(grant_state "$gid")" = "active $epoch" ] || fail "the grant is not active at epoch $epoch any more: $(grant_state "$gid")"
  [ "$(lease_epoch "$unit")" = "$epoch0" ] || fail "the lease epoch moved: $epoch0 -> $(lease_epoch "$unit")"
  [ "$(item_events "$item")" = "$ev0" ] || fail "the item's stream moved ($ev0 -> $(item_events "$item") events): something answered for it"
  say "3. the grant is still $(grant_state "$gid"), the lease epoch still $epoch0, the item's stream unchanged ($ev0 events)"
  out="$(place_session "$grant" "drill-w-again-$(date +%s)" 0)"
  [ "$out" = "200 exited" ] || fail "the next session under the grant answered '$out'"
  say "   the next session under the same grant runs to its end ($out): the redelivered command's session starts"
  rm -rf "$work"
  # the controller was killed on purpose: it is not in the restart count; every other container must be unchanged
  recovered "$before"
}

case "${1:-}" in
  postgres) drill_postgres "${2:-}" ;;
  notary) drill_notary ;;
  killswitch) drill_killswitch ;;
  runner) drill_runner ;;
  *)
    echo "usage: drill.sh postgres [--hard] | notary | killswitch | runner" >&2
    exit 2
    ;;
esac
echo "drill ${1}: every check held"
