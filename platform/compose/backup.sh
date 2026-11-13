#!/usr/bin/env bash
# Backup of the local-prod stack (RC-OPS-1; docs/runbooks/backup-restore.md).
#
#   backup.sh <dir>
#
# Run from anywhere, against the stack of COMPOSE_PROJECT_NAME (the compose default when unset). The stack may be
# running (an online backup) or quiesced; Postgres must be up. Writes into <dir> (created, mode 0700):
#
#   postgres/globals.sql         every role and its memberships (pg_dumpall --globals-only --no-role-passwords: the
#                                passwords are the secret files, which db-init re-applies on every up)
#   postgres/<db>.dump           each database (pg_dump -Fc): aisdlc (record, ledger, decisions, config, identity, core,
#                                and the gateway's, sandbox-controller's, verify's, gate-check's, gate-relay's,
#                                notifier's and audit's schemas and roles' grants), notary, witness, killswitch,
#                                keycloak (the sign-in realm, its users and their credentials), and any other database
#                                the cluster holds
#   volumes/objectstore-data.tgz the object store (MinIO) whole: the write-once `evidence-packs` bucket with its
#                                object lock, and every other bucket (taken while the store is paused, so consistent)
#   volumes/kms-state.tgz        key custody's keys (the Notary's, the Witness's, the kill switch's, the step-up and
#                                fingerprint keys). SECRET
#   volumes/vault-data.tgz       Vault's storage (the secrets pasted in the portal, encrypted by Vault; taken while
#                                Vault is paused). Opened only with the unseal key in secrets/vault/<project>/. SECRET
#   secrets.tgz, env             platform/compose/secrets (service tokens, database passwords, the App key, Vault's
#                                unseal key, root token and AppRoles, Keycloak's passwords) and .env. SECRET
#   manifest.json, SHA256SUMS    what was taken, from where, the heads it covers, and a checksum of every file
#
# Order is what makes an online backup restorable: the record database first, then the Notary's, the Witness's and
# the kill switch's (their heads can only be ahead of what the record names: the reconciler and the kill observer
# catch the record up), then the object store (every pack the record names is already stored: write-once, never
# deleted). Caches that are rebuilt from GitHub (codehost-work, knowledge-work) are not backed up.
#
# THE BACKUP HOLDS EVERY KEY AND PASSWORD OF THE FACTORY. Nothing here prints a secret, but the directory is one:
# keep it encrypted at rest (age, gpg, an encrypted bucket) and as tightly held as the keys themselves.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:?usage: backup.sh <dir>}"
umask 077
dc() { docker compose "$@"; }
say() { printf '  %s\n' "$*"; }
die() { printf 'backup: FAILED: %s\n' "$*" >&2; exit 1; }

pg_id="$(dc ps -q postgres 2>/dev/null || true)"
[ -n "$pg_id" ] || die "Postgres of project ${COMPOSE_PROJECT_NAME:-compose} is not running"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$pg_id")"
pg_image="$(docker inspect -f '{{.Image}}' "$pg_id")"
[ -s secrets/pg-superuser ] || die "secrets/pg-superuser is missing (this is not the stack's compose directory?)"
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then die "$out exists and is not empty"; fi
mkdir -p "$out/postgres" "$out/volumes"
chmod 700 "$out"
out="$(cd "$out" && pwd)"
pg() { dc exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres "$@"; }
sql() { pg psql -U postgres -d "${2:-postgres}" -At -c "$1"; }

echo "== backup of project $project into $out"
echo "   it holds every key and password of the factory: keep it encrypted and tightly held"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# what the backup covers, read before anything is taken (a running stack can only be ahead of this)
ledger_head="$(sql 'SELECT coalesce(max(ledger_seq), 0) FROM ledger.ledger_entry' aisdlc)"
checkpoint="$(sql "SELECT coalesce(max(to_ledger_seq), 0) FROM ledger.checkpoint" aisdlc)"
record_head="$(sql 'SELECT coalesce(max(global_seq), 0) FROM record.record_event' aisdlc)"
packs="$(sql 'SELECT count(*) FROM core.evidence_pack' aisdlc 2>/dev/null || echo 0)"

pg pg_dumpall -U postgres --globals-only --no-role-passwords >"$out/postgres/globals.sql"
say "roles: $(grep -c '^CREATE ROLE' "$out/postgres/globals.sql")"
dbs="$(sql "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname = 'aisdlc' DESC, datname")"
for db in $dbs; do
  pg pg_dump -U postgres -Fc -d "$db" >"$out/postgres/$db.dump"
  say "database $db: $(du -h "$out/postgres/$db.dump" | cut -f1)"
done

# a named volume of this project, as a gzipped tar (numeric owners kept: the services run as the factory uid)
volume_of() {
  docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$1"
}
tar_volume() {
  local vol
  vol="$(volume_of "$1")"
  [ -n "$vol" ] || die "no volume $1 in project $project"
  # tar runs as root in the container (it must read a volume of any uid); the archive is then given to the caller,
  # who may not be root, so that the chmod below and the drill can handle it
  docker run --rm --network none -v "$vol:/data:ro" -v "$out/volumes:/backup" "$pg_image" \
    sh -c 'tar --numeric-owner -C /data -czf "/backup/$0.tgz" . && chown "$1" "/backup/$0.tgz"' "$1" "$(id -u):$(id -g)"
  say "volume $1: $(du -h "$out/volumes/$1.tgz" | cut -f1)"
}
os_id="$(dc ps -q object-store 2>/dev/null || true)"
os_running=0
if [ -n "$os_id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$os_id")" = true ]; then os_running=1; fi
[ "$os_running" = 1 ] && docker pause "$os_id" >/dev/null
trap '[ "$os_running" = 1 ] && docker unpause "$os_id" >/dev/null 2>&1 || true' EXIT
tar_volume objectstore-data
[ "$os_running" = 1 ] && docker unpause "$os_id" >/dev/null
os_running=0
tar_volume kms-state
# Vault whole, while it is paused (consistent; the services keep the values they read and refresh after)
v_id="$(dc ps -q vault 2>/dev/null || true)"
v_running=0
if [ -n "$v_id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$v_id")" = true ]; then v_running=1; fi
[ "$v_running" = 1 ] && docker pause "$v_id" >/dev/null
trap '[ "$v_running" = 1 ] && docker unpause "$v_id" >/dev/null 2>&1 || true' EXIT
tar_volume vault-data
[ "$v_running" = 1 ] && docker unpause "$v_id" >/dev/null
v_running=0

tar -czf "$out/secrets.tgz" secrets
[ -e .env ] && cp .env "$out/env"
say "secrets: $(tar -tzf "$out/secrets.tgz" | grep -vc '/$') files (not printed)"

git_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
cat >"$out/manifest.json" <<JSON
{
  "format": "aisdlc-compose-backup/1",
  "project": "$project",
  "started_at": "$started",
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_sha": "$git_sha",
  "databases": [$(printf '"%s",' $dbs | sed 's/,$//')],
  "volumes": ["objectstore-data", "kms-state", "vault-data"],
  "covers": { "record_head": $record_head, "ledger_head": $ledger_head, "checkpoint_to": $checkpoint, "evidence_packs": $packs }
}
JSON
(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
chmod -R go-rwx "$out"
echo "== backup done: record head $record_head, ledger head $ledger_head (checkpoint to $checkpoint), $packs evidence pack(s)"
