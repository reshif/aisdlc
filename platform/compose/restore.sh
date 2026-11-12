#!/usr/bin/env bash
# Restore of the local-prod stack from a backup.sh directory onto a fresh host (RC-OPS-1;
# docs/runbooks/backup-restore.md).
#
#   restore.sh <dir>
#
# Against COMPOSE_PROJECT_NAME (the compose default when unset), from platform/compose, onto NOTHING: the project
# must have no Postgres volume (a fresh host, or `docker compose down -v` first) and secrets/ must be absent or hold
# exactly the backup's files. The image (AISDLC_IMAGE, default aisdlc/factory:local) must exist: build it from the
# commit in manifest.json.
#
#   1. every file is checked against SHA256SUMS (a damaged backup is refused, nothing is touched)
#   2. secrets/ and .env come back as they were (the passwords, tokens and the App key)
#   3. the object store's and key custody's volumes come back whole (numeric owners kept)
#   4. Postgres starts empty with the restored superuser password; the roles, then every database, are restored
#      (pg_restore --exit-on-error: a single error stops the restore)
#   5. db-init re-applies the role passwords from the secret files (the backup holds none)
#
# It starts nothing else: bring the stack up with your usual `docker compose [--profile ...] up -d --wait` (migrate
# finds every migration applied), then run the checks of the runbook (verify-ledger.sh, drill-restore.sh's list).
set -euo pipefail
cd "$(dirname "$0")"
src="${1:?usage: restore.sh <dir>}"
src="$(cd "$src" && pwd)"
dc() { docker compose "$@"; }
say() { printf '  %s\n' "$*"; }
die() { printf 'restore: FAILED: %s\n' "$*" >&2; exit 1; }

[ -s "$src/manifest.json" ] && [ -s "$src/SHA256SUMS" ] || die "$src is not a backup.sh directory"
echo "== checking the backup's checksums"
(cd "$src" && sha256sum --quiet -c SHA256SUMS) || die "a file of the backup does not match SHA256SUMS"
say "every file matches"

echo "== secrets and settings"
if [ -d secrets ] && [ -n "$(ls -A secrets 2>/dev/null)" ]; then
  tmp="$(mktemp -d)"
  tar -xzf "$src/secrets.tgz" -C "$tmp"
  diff -rq "$tmp/secrets" secrets >/dev/null || { rm -rf "$tmp"; die "secrets/ exists and differs from the backup's: move it away first"; }
  rm -rf "$tmp"
  say "secrets/ already holds exactly the backup's files"
else
  umask 077
  tar -xzf "$src/secrets.tgz"
  chmod 700 secrets
  say "secrets/ restored ($(find secrets -type f | wc -l) files, not printed)"
fi
if [ -e "$src/env" ]; then
  if [ -e .env ] && ! cmp -s "$src/env" .env; then die ".env exists and differs from the backup's: move it away first"; fi
  cp "$src/env" .env
fi
# compose interpolates the uid and the subnets from .env and the environment
set -a
# shellcheck disable=SC1091
[ -e .env ] && . ./.env
set +a

project="$(dc config --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).name))')"
volume_of() {
  docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$1"
}
[ -z "$(volume_of pgdata)" ] || die "project $project already has a Postgres volume: restore onto a fresh stack (docker compose down -v)"

echo "== volumes (project $project)"
dc up -d --no-deps --wait postgres >/dev/null
pg_image="$(docker inspect -f '{{.Image}}' "$(dc ps -q postgres)")"
dc create --no-build object-store kms-local >/dev/null
for v in objectstore-data kms-state; do
  vol="$(volume_of "$v")"
  [ -n "$vol" ] || die "compose did not create the volume $v"
  # a fresh volume holds what the image had at its mount point: replaced by the backup's whole
  docker run --rm --network none -v "$vol:/data" -v "$src/volumes:/backup:ro" "$pg_image" \
    sh -c 'find /data -mindepth 1 -delete && tar --numeric-owner -C /data -xzpf "/backup/$0.tgz"' "$v" \
    || die "volume $v did not restore"
  say "volume $v restored"
done

echo "== Postgres"
pg() { dc exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres "$@"; }
# the roles (postgres itself exists already); then each database with its owner, as dumped
grep -v '^CREATE ROLE postgres;$' "$src/postgres/globals.sql" | pg psql -q -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null
say "roles: $(grep -c '^CREATE ROLE' "$src/postgres/globals.sql")"
for f in "$src"/postgres/*.dump; do
  db="$(basename "$f" .dump)"
  pg pg_restore -U postgres --create --exit-on-error -d postgres <"$f"
  say "database $db: restored"
done
dc run --rm --no-deps db-init >/dev/null
say "db-init re-applied the role passwords from the secret files"
echo "== restore done; bring the stack up (docker compose [--profile ...] up -d --wait), then run the runbook's checks"
