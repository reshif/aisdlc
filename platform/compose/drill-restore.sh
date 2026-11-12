#!/usr/bin/env bash
# The restore drill (RC-OPS-1; docs/runbooks/backup-restore.md). `npm run drill:restore`.
#
#   1. a stack with data: the browser e2e (an onboarding, S1 to S7 with evidence packs, decisions, the ledger) when
#      Playwright resolves (DRILL_DATA=e2e), else an onboarding through core (DRILL_DATA=seed); then a kill that stays
#      engaged and a kill released by two people
#   2. quiesce (every factory service stopped, Postgres and the object store up) and record what must survive: every
#      table of every database (count and hash), every read model's digest, the Notary's and the Witness's heads,
#      the kill switch's kills, the evidence packs
#   3. backup.sh, then the host is destroyed: `down -v` and secrets/ and .env moved away
#   4. restore.sh into a fresh stack, then prove:
#        - every table of every database equals what was backed up
#        - every read model is the same, and rebuilt from the record alone it is the same again
#        - the Notary's journal agrees with the ledger and the Witness's newest checkpoint is the ledger's
#        - the stack comes up and verify-ledger passes (every entry, every checkpoint, both keys)
#        - the kill still kills (admission refused for its project) and the released one stays released
#        - every evidence pack the record names is read back and verifies offline (aisdlc-verify-pack)
#        - the restored factory keeps working: the engaged kill is released by two people, the restored Notary signs
#          the new entries and the restored Witness co-signs a new checkpoint, and verify-ledger passes again
#   5. `down -v`, the moved secrets put back, the backup deleted (DRILL_KEEP=1 keeps the stack, DRILL_BACKUP_DIR the
#      backup), also on failure
#
# DRILL_SKIP_BUILD=1 uses the image AISDLC_IMAGE (default aisdlc/factory:local) as it is. Its own project and subnets
# (COMPOSE_PROJECT_NAME aisdlc-drill, AISDLC_SUBNET_PREFIX 10.237), so it runs beside another stack; it needs ports
# 8340 and 8390 free. Exit 0 only if every check held. The summary goes to DRILL_REPORT (default: stdout only).
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd)"
repo_root="$(cd ../.. && pwd)"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-drill}"
export AISDLC_SUBNET_PREFIX="${AISDLC_SUBNET_PREFIX:-10.237}"
export AISDLC_IMAGE="${AISDLC_IMAGE:-aisdlc/factory:local}"
export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
export KILL_OBSERVER_INTERVAL_MS="${KILL_OBSERVER_INTERVAL_MS:-3000}"
export CORE_WORKER_STAGE_PORTS="${CORE_WORKER_STAGE_PORTS:-agents}"
export CORE_WORKER_FAKE_VERIFY="${CORE_WORKER_FAKE_VERIFY:-exceptions}"
PROFILES=(--profile fake-github)
dc() { docker compose "${PROFILES[@]}" "$@"; }
T0=$SECONDS
step() { printf '\n== [%4ss] %s\n' $((SECONDS - T0)) "$*"; }
say() { printf '  %s\n' "$*"; }
fail() { printf 'drill-restore: FAILED: %s\n' "$*" >&2; exit 1; }
summary=()
held() { summary+=("PASS  $*"); say "PASS: $*"; }

if [ -z "${DRILL_DATA:-}" ]; then
  if NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null)}" node -e "require('playwright')" 2>/dev/null; then DRILL_DATA=e2e; else DRILL_DATA=seed; fi
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/aisdlc-drill.XXXXXX")"
chmod 700 "$work"
backup="${DRILL_BACKUP_DIR:-$work/backup}"
moved=0

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    echo; echo "== drill FAILED (exit $code): service states, then the tail of each log"
    dc ps -a 2>&1 || true
    dc logs --no-color --tail 30 2>&1 | grep -v 'tick ok' | tail -150 || true
  fi
  if [ "${DRILL_KEEP:-0}" = 1 ]; then
    echo "== DRILL_KEEP=1: stack left running (project $COMPOSE_PROJECT_NAME); remove it with: docker compose ${PROFILES[*]} down -v"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    echo "== stack removed (down -v): $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) containers, $(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l) volumes left"
  fi
  # the secrets this drill moved away come back, whatever happened (the restored copy is the backup's)
  if [ "$moved" = 1 ] && [ -d "$work/orig/secrets" ]; then
    rm -rf "$here/secrets" "$here/.env"
    mv "$work/orig/secrets" "$here/secrets"
    [ -e "$work/orig/env" ] && mv "$work/orig/env" "$here/.env"
  fi
  if [ -z "${DRILL_BACKUP_DIR:-}" ]; then rm -rf "$work"; else rm -rf "$work/orig" "$work"/*.before "$work"/*.after; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pgw() { dc exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres "$@"; }
sql() { pgw psql -U postgres -d "${2:-aisdlc}" -At -c "$1"; }
# every table of a database: "schema.table|rows|md5 of the rows as text, sorted"
tables_of() {
  pgw psql -U postgres -d "$1" -At -F'|' -c "
    SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, chr(10) ORDER BY t::text), %L)) FROM %I.%I t',
                  n.nspname || '.' || c.relname, '', n.nspname, c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1" | pgw psql -U postgres -d "$1" -At -F'|'
}
facts() { # what must survive, into $work/<name>.$1
  local db
  for db in aisdlc notary witness killswitch; do tables_of "$db" >"$work/tables-$db.$1"; done
  dc run --rm --no-deps -T migrate node /app/services/core/dist/aisdlc-rebuild-check.js >"$work/models.$1"
  {
    echo "ledger $(sql 'SELECT count(*), coalesce(max(ledger_seq),0), md5(coalesce(string_agg(ledger_seq || chr(58) || entry_hash, chr(10) ORDER BY ledger_seq), chr(0))) FROM ledger.ledger_entry')"
    echo "checkpoint $(sql 'SELECT cp_seq, to_ledger_seq, root_hash, head_hash FROM ledger.checkpoint ORDER BY cp_seq DESC LIMIT 1')"
    echo "notary-state $(sql 'SELECT last_seq FROM notary.state' notary)"
    echo "notary-committed $(sql "SELECT count(*), coalesce(max(ledger_seq),0), md5(coalesce(string_agg(ledger_seq || chr(58) || entry_hash, chr(10) ORDER BY ledger_seq), chr(0))) FROM notary.journal WHERE status = 'committed'" notary)"
    echo "witness $(sql 'SELECT cp_seq, to_ledger_seq, root_hash, head_hash FROM witness.cosigned ORDER BY cp_seq DESC LIMIT 1' witness)"
    echo "kills $(sql "SELECT string_agg(kill_id || chr(58) || state, ',' ORDER BY kill_id) FROM killswitch.kill" killswitch)"
    echo "packs $(sql 'SELECT count(*) FROM core.evidence_pack')"
  } >"$work/heads.$1"
}
fact() { grep "^$1 " "$work/heads.$2" | cut -d' ' -f2-; }

# ---------------------------------------------------------------- the people's acts (as smoke.sh does them)
ksnode() { dc exec -T -e TOKEN="$(cat secrets/tok-operator-killswitch)" -e P1="${P1:-}" -e P2="${P2:-}" killswitch node --input-type=module -e "$1"; }
kproof() { dc exec -T -e PRINCIPAL="$1" -e ACT="$2" bff node --input-type=module -e "$(cat kill-proof.mjs)"; }
admission() { dc exec -T core-worker node -e "fetch('http://127.0.0.1:8360/admission?project_id=$1&lane=L3').then(async r=>console.log(r.status))"; }
kill_project() { # project reason -> kill id
  local p
  p="$(kproof alice '{"action":"kill.request","scope":{"kind":"project","ref":"'"$1"'"},"reason":"'"$2"'"}')"
  P1="$p" ksnode '
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const r = await fetch("http://127.0.0.1:8400/v1/kills", { method: "POST", headers: h,
  body: JSON.stringify({ step_up: { proof: process.env.P1 }, scope: { kind: "project", ref: "'"$1"'" }, reason: "'"$2"'" }) });
const k = await r.json();
if (r.status !== 201) { console.error(JSON.stringify(k)); process.exit(1); }
console.log(k.kill_id);'
}
release_kill() { # kill id: alice then bob, each with their own step-up
  local act='{"action":"kill.release","kill_id":"'"$1"'"}'
  P1="$(kproof alice "$act")" P2="$(kproof bob "$act")" ksnode '
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const rel = async (p) => { const r = await fetch("http://127.0.0.1:8400/v1/kills/'"$1"'/release", { method: "POST", headers: h, body: JSON.stringify({ step_up: { proof: p } }) }); return [r.status, await r.json()]; };
let [s, k] = await rel(process.env.P1);
if (s === 200 && k.state === "release_pending") [s, k] = await rel(process.env.P2);
if (k.state !== "released") { console.error(s, JSON.stringify(k)); process.exit(1); }
console.log(k.release_approvals.join("+"));'
}
wait_observed() { # n: kill.observed facts in the record
  local i obs
  for i in $(seq 1 60); do
    obs="$(sql "SELECT count(*) FROM record.record_event WHERE type = 'kill.observed'")"
    [ "$obs" -ge "$1" ] && return 0
    sleep 2
  done
  fail "core-worker recorded only $obs of $1 kill switch journal entries"
}

# ---------------------------------------------------------------- 1. a stack with data
for p in 8340 8390; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then fail "port $p is already in use on this host (another stack?)"; fi
done
if [ "${DRILL_SKIP_BUILD:-0}" = 1 ]; then
  docker image inspect "$AISDLC_IMAGE" >/dev/null 2>&1 || fail "DRILL_SKIP_BUILD=1 but the image $AISDLC_IMAGE does not exist"
fi
if [ "$DRILL_DATA" = e2e ]; then
  step "a stack with data: the browser e2e (onboarding, S1 to S7, decisions, evidence packs), left running"
  E2E_KEEP=1 E2E_SKIP_BUILD="${DRILL_SKIP_BUILD:-0}" E2E_SCREENSHOT_DIR="$work/screenshots" \
    NODE_PATH="${NODE_PATH:-$(npm root -g)}" PW_CHROMIUM="${PW_CHROMIUM:-}" ./e2e.sh
else
  step "a stack with data: up, then an onboarding through core"
  ./init-secrets
  [ "${DRILL_SKIP_BUILD:-0}" = 1 ] || dc build
  dc up -d --wait --wait-timeout 300
  dc exec -T -e TOKEN="$(cat secrets/tok-operator-core)" core node -e '
const base = "http://127.0.0.1:8380";
const h = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
const r = await fetch(base + "/v1/onboard", { method: "POST", headers: h,
  body: JSON.stringify({ project_id: "testbed", repo: "reshif/asf-factory-testbed", level: "census", on_behalf_of: "alice" }) });
if (r.status !== 201 && r.status !== 200) { console.log("onboard refused", r.status, await r.text()); process.exit(1); }
const end = Date.now() + 240000;
for (;;) {
  const s0 = (await (await fetch(base + "/v1/repos/reshif/asf-factory-testbed/s0", { headers: h })).json())[0];
  if (s0?.record.status === "card") break;
  if (Date.now() > end) { console.log("the onboarding did not reach its first card"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("  onboarded testbed to card 1");' || fail "the onboarding did not reach card 1"
fi
step "the kill switch: one kill engaged (testbed), one released by two people (drill-other)"
obs0="$(sql "SELECT count(*) FROM record.record_event WHERE type = 'kill.observed'")"
kill_kept="$(kill_project testbed 'restore drill: stays engaged')" || fail "the kill was refused"
kill_gone="$(kill_project drill-other 'restore drill: released')" || fail "the second kill was refused"
say "released by $(release_kill "$kill_gone")"
wait_observed $((obs0 + 5))
case "$(admission testbed)" in 423*) ;; *) fail "admission was not refused for the killed project" ;; esac
say "kill $kill_kept engages testbed; kill $kill_gone is released; core-worker recorded the journal"
./verify-ledger.sh --wait 200 >/dev/null || fail "the ledger did not verify before the backup"
say "a checkpoint co-signed by the Witness covers the ledger head, and the ledger verifies"

# ---------------------------------------------------------------- 2. quiesce and record
step "quiesce: every factory service stopped (Postgres and the object store stay up)"
mapfile -t services < <(dc config --services)
stop=()
for s in "${services[@]}"; do case "$s" in postgres | object-store) ;; *) stop+=("$s") ;; esac; done
dc stop "${stop[@]}" >/dev/null 2>&1
facts before
say "$(cat "$work"/tables-*.before | wc -l) tables in 4 databases, $(grep -o '"rows"' "$work/models.before" | wc -l) read models"
say "ledger: $(fact ledger before | cut -d'|' -f1-2 | tr '|' ' ') entries/head; checkpoint $(fact checkpoint before | cut -d'|' -f1-2 | tr '|' ' '); packs $(fact packs before)"
[ "$DRILL_DATA" = seed ] || [ "$(fact packs before)" -ge 1 ] || fail "the e2e left no evidence pack to check"

# ---------------------------------------------------------------- 3. backup, then the host is lost
step "backup.sh"
t_backup=$SECONDS
./backup.sh "$backup"
t_backup=$((SECONDS - t_backup))
held "backup taken in ${t_backup}s ($(du -sh "$backup" | cut -f1))"
step "the host is lost: down -v, secrets/ and .env gone"
dc down -v --remove-orphans >/dev/null 2>&1
mkdir -p "$work/orig"
mv secrets "$work/orig/secrets"
[ -e .env ] && mv .env "$work/orig/env"
moved=1
say "volumes left: $(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | wc -l); secrets/ present: $([ -d secrets ] && echo yes || echo no)"

# ---------------------------------------------------------------- 4. restore and prove
step "restore.sh into a fresh stack"
t_restore=$SECONDS
./restore.sh "$backup"
facts after
for db in aisdlc notary witness killswitch; do
  diff -u "$work/tables-$db.before" "$work/tables-$db.after" >&2 || fail "database $db differs from the backup"
done
held "every table of aisdlc, notary, witness and killswitch equals the backup ($(cat "$work"/tables-*.after | wc -l) tables, rows and hashes)"
cmp -s "$work/models.before" "$work/models.after" || fail "a read model differs after the restore"
dc run --rm --no-deps -T migrate node /app/services/core/dist/aisdlc-rebuild-check.js --rebuild >"$work/models.rebuilt"
cmp -s "$work/models.before" "$work/models.rebuilt" || {
  node -e 'const [a,b]=process.argv.slice(1).map(f=>JSON.parse(require("fs").readFileSync(f,"utf8")).read_models);for(const k of Object.keys(a))if(JSON.stringify(a[k])!==JSON.stringify(b[k]))console.error("  differs:",k,JSON.stringify(a[k]),JSON.stringify(b[k]))' "$work/models.before" "$work/models.rebuilt"
  fail "a read model rebuilt from the record differs from the one backed up"
}
held "every read model rebuilt from the restored record alone equals the one backed up ($(grep -o '"rows"' "$work/models.rebuilt" | wc -l) read models)"
for k in ledger checkpoint notary-state notary-committed witness kills packs; do
  [ "$(fact "$k" before)" = "$(fact "$k" after)" ] || fail "$k differs: before [$(fact "$k" before)] after [$(fact "$k" after)]"
done
ledger_n="$(fact ledger after | cut -d'|' -f2)"
[ "$(fact notary-state after)" = "$ledger_n" ] || fail "the Notary's head ($(fact notary-state after)) is not the ledger head ($ledger_n)"
[ "$(fact notary-committed after | cut -d'|' -f3)" = "$(fact ledger after | cut -d'|' -f3)" ] || fail "the Notary's committed journal does not hash like the ledger"
held "the Notary's journal agrees with the ledger (head $ledger_n, every entry hash)"
[ "$(fact witness after)" = "$(fact checkpoint after)" ] || fail "the Witness's newest checkpoint is not the ledger's"
held "the Witness's newest co-signed checkpoint is the ledger's ($(fact checkpoint after | cut -d'|' -f1-2 | tr '|' ' '))"

step "the restored stack comes up"
dc up -d --wait --wait-timeout 300
t_restore=$((SECONDS - t_restore))
./verify-ledger.sh --wait 200 || fail "the restored ledger did not verify"
held "verify-ledger passes on the restored ledger (Notary and Witness keys)"
case "$(admission testbed)" in 423*) ;; *) fail "the restored kill switch does not kill testbed" ;; esac
case "$(admission drill-other)" in 200*) ;; *) fail "the released kill came back" ;; esac
held "the kill switch state survived: testbed is killed (423), drill-other stays released"

dc exec -T core node -e '
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
(async () => {
  const token = readFileSync("/run/secrets/tok-core-kms", "utf8").trim();
  const r = await fetch(`${process.env.KMS_URL ?? "http://kms-local:8300"}/v1/keys/${encodeURIComponent("dev:notary")}/public`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 200) { console.error("kms-local refused the Notary public key", r.status); process.exit(2); }
  writeFileSync("/tmp/notary.jwk", await r.text());
  const ex = spawnSync("node", ["/app/services/core/dist/aisdlc-export-packs.js", "--out", "/tmp/packs"], { encoding: "utf8" });
  process.stdout.write("  " + ex.stdout); if (ex.status !== 0) { console.error(ex.stderr); process.exit(1); }
  let n = 0;
  for (const line of readFileSync("/tmp/packs/packs.tsv", "utf8").split("\n").filter(Boolean)) {
    const [key, item, head] = line.split("\t");
    const v = spawnSync("node", ["/app/packages/verify/dist/verify-pack.js", "--pack", `/tmp/packs/${key}.pack`, "--notary-key", "/tmp/notary.jwk",
      "--head", head, "--item", item, "--object-key", key, "--allow-not-passing"], { encoding: "utf8" });
    if (v.status !== 0) { console.error(`  pack ${key}: ${v.stdout}${v.stderr}`); process.exit(1); }
    n += 1;
  }
  console.log(`  ${n} pack(s) verified offline`);
})();' >"$work/packs.out" || { cat "$work/packs.out"; fail "an evidence pack did not verify after the restore"; }
cat "$work/packs.out"
grep -q "^  $(fact packs before) pack(s) verified offline" "$work/packs.out" || fail "not every evidence pack the record names was verified"
held "every evidence pack the record names ($(fact packs before)) is read back from the restored store and verifies offline (aisdlc-verify-pack)"

step "the restored factory keeps working: release the kept kill, new entries signed and checkpointed"
head0="$ledger_n"
obs1="$(sql "SELECT count(*) FROM record.record_event WHERE type = 'kill.observed'")"
say "released by $(release_kill "$kill_kept")"
wait_observed $((obs1 + 2))
case "$(admission testbed)" in 200*) ;; *) fail "testbed is still killed after the release" ;; esac
./verify-ledger.sh --wait 200 || fail "the ledger did not verify after new entries"
head1="$(sql 'SELECT max(ledger_seq) FROM ledger.ledger_entry')"
[ "$head1" -gt "$head0" ] || fail "no new ledger entry after the restore"
held "the restored Notary signed entries $((head0 + 1))..$head1 and the restored Witness co-signed a checkpoint over them"

step "summary (data: $DRILL_DATA)"
summary+=("RPO   the moment the backup is taken: an online backup.sh run, nothing after it (taken ${t_backup}s)")
summary+=("RTO   ${t_restore}s from restore.sh to a healthy stack (this host, image present)")
printf '  %s\n' "${summary[@]}" | tee "${DRILL_REPORT:-/dev/null}"
echo "drill-restore: PASS"
