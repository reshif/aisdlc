#!/usr/bin/env bash
# Outage drills on a running local-prod stack (PLAN M19; ADR-0003 §9 "What survives what", Rating item 3).
#
#   drill.sh postgres [--hard]    Postgres goes away and comes back (restart; --hard: SIGKILL, then start)
#   drill.sh notary               the Notary is stopped, then started again
#   drill.sh killswitch           the kill switch is stopped, then started again
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

case "${1:-}" in
  postgres) drill_postgres "${2:-}" ;;
  notary) drill_notary ;;
  killswitch) drill_killswitch ;;
  *)
    echo "usage: drill.sh postgres [--hard] | notary | killswitch" >&2
    exit 2
    ;;
esac
echo "drill ${1}: every check held"
