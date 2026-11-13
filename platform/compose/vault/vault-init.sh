#!/bin/sh
# Vault's init job (every `up`, idempotent). LOCAL PROD ONLY: the unseal key and the root token are kept as files.
#
#   1. the first time: `vault operator init` with ONE key share; the unseal key and the root token are written to
#      secrets/vault/<compose project>/unseal-key and .../root-token (mode 0600, the owner's uid: one pair per stack,
#      so two stacks on one checkout never share a key). The vault container unseals itself with that key from then on
#      (vault-entry.sh). A key pair left by a stack whose volume is gone (`down -v`) opens nothing: it is moved aside
#      (`*.orphaned-<time>`), never deleted, and a new Vault is initialised.
#   2. waits until Vault is unsealed.
#   3. with the root token: the KV v2 engine at `aisdlc/`, AppRole auth, an audit device on stdout (Vault's audit log
#      HMACs every secret value: no value is ever logged), one policy per service (policies/*.hcl) and one AppRole per
#      service whose role_id and secret_id are the ones init-secrets wrote (secrets/vault/approle-<service>).
#      A service reads only its own folder; core writes values (never reads one back); nobody else writes.
#
# Nothing here prints a key, a token or a secret id.
set -eu
export VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
keys="${VAULT_KEYS_DIR:?the directory of this stack's unseal key and root token}"
roles=/vault/keys
mkdir -p "$keys"
chmod 700 "$keys"
say() { printf 'vault-init: %s\n' "$*"; }

# 0. Vault answers (sealed or not)
i=0
until vault status >/dev/null 2>&1 || [ "$?" = 2 ]; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { say "Vault does not answer"; exit 1; }
  sleep 1
done

# 1. initialise once
if ! vault operator init -status >/dev/null 2>&1; then
  if [ -e "$keys/unseal-key" ] || [ -e "$keys/root-token" ]; then
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    for f in unseal-key root-token; do [ ! -e "$keys/$f" ] || mv "$keys/$f" "$keys/$f.orphaned-$stamp"; done
    say "Vault is empty (a new vault-data volume) but an old unseal key was there: moved aside as *.orphaned-$stamp"
  fi
  umask 077
  out="$(vault operator init -key-shares=1 -key-threshold=1)"
  printf '%s\n' "$out" | sed -n 's/^Unseal Key 1: *//p' >"$keys/unseal-key.tmp"
  printf '%s\n' "$out" | sed -n 's/^Initial Root Token: *//p' >"$keys/root-token.tmp"
  [ -s "$keys/unseal-key.tmp" ] && [ -s "$keys/root-token.tmp" ] || { say "init gave no key"; exit 1; }
  chmod 600 "$keys/unseal-key.tmp" "$keys/root-token.tmp"
  mv "$keys/unseal-key.tmp" "$keys/unseal-key"
  mv "$keys/root-token.tmp" "$keys/root-token"
  say "initialised: one key share; unseal key and root token written to secrets/vault/$(basename "$keys")/ (mode 0600)"
fi

# 2. unsealed (the vault container does it; this job does too, so the first start does not wait for its loop)
i=0
while :; do
  rc=0; vault status >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] && break
  if [ "$rc" = 2 ] && [ -s "$keys/unseal-key" ]; then vault operator unseal "$(cat "$keys/unseal-key")" >/dev/null 2>&1 || true; fi
  i=$((i + 1)); [ "$i" -lt 90 ] || { say "Vault stays sealed"; exit 1; }
  sleep 1
done
say "unsealed"

# 3. configuration, as root
VAULT_TOKEN="$(cat "$keys/root-token")"
export VAULT_TOKEN
vault secrets list -format=json | grep -q '"aisdlc/"' || vault secrets enable -path=aisdlc -version=2 kv >/dev/null
vault auth list -format=json | grep -q '"approle/"' || vault auth enable approle >/dev/null
vault audit list -format=json 2>/dev/null | grep -q '"stdout/"' || vault audit enable -path=stdout file file_path=stdout >/dev/null

for f in /vault/policies/*.hcl; do
  svc="$(basename "$f" .hcl)"
  vault policy write "$svc" "$f" >/dev/null
  cred="$roles/approle-$svc"
  [ -s "$cred" ] || { say "no AppRole credential for $svc (run ./init-secrets)"; exit 1; }
  role_id="$(sed -n 's/.*"role_id" *: *"\([^"]*\)".*/\1/p' "$cred")"
  secret_id="$(sed -n 's/.*"secret_id" *: *"\([^"]*\)".*/\1/p' "$cred")"
  [ -n "$role_id" ] && [ -n "$secret_id" ] || { say "$cred is not {role_id, secret_id}"; exit 1; }
  # tokens live an hour (a service logs in again on its own), secret ids do not expire (local prod)
  vault write "auth/approle/role/$svc" token_policies="$svc" token_ttl=1h token_max_ttl=24h \
    secret_id_ttl=0 secret_id_num_uses=0 token_no_default_policy=true >/dev/null
  vault write "auth/approle/role/$svc/role-id" role_id="$role_id" >/dev/null
  if ! vault write -format=json "auth/approle/role/$svc/secret-id/lookup" secret_id="$secret_id" 2>/dev/null | grep -q '"secret_id_accessor"'; then
    vault write "auth/approle/role/$svc/custom-secret-id" secret_id="$secret_id" >/dev/null
  fi
  say "policy and AppRole: $svc"
done
say "done"
