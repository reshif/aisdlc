#!/usr/bin/env bash
# Verify the stack's ledger offline with the bundled `verify-ledger` (PLAN M8.0b, M8.5).
#
#   verify-ledger.sh [--wait SECONDS]
#
# Waits (up to SECONDS, default 120) until the newest checkpoint, co-signed by the Witness, covers
# the ledger head, then runs `verify-ledger` inside the core-worker container against the record
# database with the two public keys (dev:notary, dev:witness) fetched from kms-local. Nothing is
# written: the CLI's session is read-only and the keys are public. Exit 0 only if it verified.
# Uses the compose project of the caller (COMPOSE_PROJECT_NAME), run from this directory.
set -euo pipefail
cd "$(dirname "$0")"

wait_s=120
if [ "${1:-}" = "--wait" ]; then wait_s="${2:?--wait needs a number of seconds}"; fi
dc() { docker compose "$@"; }
psql_one() {
  local pw
  pw="$(cat secrets/pg-superuser)"
  dc exec -T -e PGPASSWORD="$pw" postgres psql -U postgres -d aisdlc -At -c "$1"
}

deadline=$((SECONDS + wait_s))
while :; do
  head_seq=$(psql_one 'SELECT coalesce(max(ledger_seq),0) FROM ledger.ledger_entry')
  cp_row=$(psql_one 'SELECT cp_seq, to_ledger_seq FROM ledger.checkpoint ORDER BY cp_seq DESC LIMIT 1' || true)
  cp_seq=${cp_row%%|*}
  cp_to=${cp_row##*|}
  if [ -n "$cp_row" ] && [ "$cp_to" = "$head_seq" ]; then break; fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "verify-ledger: no checkpoint covers the ledger head ($head_seq) after ${wait_s}s (latest: ${cp_row:-none})" >&2
    exit 1
  fi
  sleep 3
done
echo "  checkpoint $cp_seq co-signed by the Witness covers ledger entries 1..$cp_to (the head is $head_seq)"

dc exec -T core-worker node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
(async () => {
  const token = readFileSync("/run/secrets/tok-core-worker-kms", "utf8").trim();
  for (const [name, id] of [["notary", "dev:notary"], ["witness", "dev:witness"]]) {
    const r = await fetch(`${process.env.KMS_URL}/v1/keys/${encodeURIComponent(id)}/public`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.status !== 200) { console.error(`kms-local refused the public key ${id}: HTTP ${r.status}`); process.exit(2); }
    writeFileSync(`/tmp/${name}.jwk`, await r.text());
    console.log(`  public key ${id} fetched from kms-local`);
  }
  const url = readFileSync("/run/secrets/db-url-aisdlc", "utf8").trim();
  const p = spawnSync("node", ["/app/packages/ledger/dist/verify-ledger.js", "--notary-key", "/tmp/notary.jwk", "--witness-key", "/tmp/witness.jwk"],
    { env: { ...process.env, AISDLC_LEDGER_DB_URL: url }, encoding: "utf8" });
  for (const l of (p.stdout + p.stderr).split("\n")) if (l) console.log("  " + l);
  process.exit(p.status ?? 2);
})();
'
