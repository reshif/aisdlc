#!/bin/sh
# The Vault container's entrypoint (LOCAL PROD ONLY: auto-unseal on the owner's machine). Starts the server, then
# unseals it whenever it is sealed and the unseal key exists (secrets/vault/<project>/unseal-key, written by
# vault-init.sh at the first start): after a restart of the container, of Docker or of the machine, Vault opens again by itself.
# A real deployment never keeps an unseal key beside the server; it uses AWS Secrets Manager (or Vault with a KMS
# seal) instead. Nothing here prints the key.
set -eu
export VAULT_ADDR=http://127.0.0.1:8200
key="${VAULT_UNSEAL_KEY_FILE:?the unseal key's path}"

vault server -config=/vault/config/vault.hcl &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

while kill -0 "$pid" 2>/dev/null; do
  # `vault status` exits 2 when sealed (or not initialized yet), 0 when unsealed, 1 when it cannot answer
  rc=0
  vault status >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 2 ] && [ -s "$key" ] && vault operator init -status >/dev/null 2>&1; then
    if vault operator unseal "$(cat "$key")" >/dev/null 2>&1; then
      echo "vault-entry: unsealed with the local unseal key"
    else
      echo "vault-entry: the unseal key did not open Vault (is $key this Vault's?)"
    fi
  fi
  sleep 2
done
wait "$pid"
