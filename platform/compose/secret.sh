#!/usr/bin/env bash
# Put a secret into the local factory's Vault, or list what is set, the way the portal does it (portal v2 N15):
#
#   secret.sh put <name> [file]  reads the value from the terminal without echoing it (or from <file>, for a
#                                multi-line value like a GitHub App's .pem), PUTs it to /api/secrets/<name>
#   secret.sh list           names and metadata only (a value is never shown again once saved)
#
# It signs in through Keycloak as the break-glass factory admin `factory-admin` (password in
# secrets/keycloak-factory-admin-password; `make secret` runs on the owner's machine), takes the session's CSRF token
# from /api/me, and calls the bff: bff -> core -> Vault, the PDP decides `config.propose` on the fleet, the record keeps
# {name, version, by, at} only. The value goes to curl through a 0600 file that is removed at exit: never on a command
# line or in shell history. Names are the fixed list in contracts (`SECRET_NAMES`).
#
# Run from platform/compose against a running stack (`make up` or `make up-full`).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=kc-login.sh
. ./kc-login.sh

envv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# the ports compose used: the environment first (as compose reads it), then .env, then compose's defaults
bff="${AISDLC_BFF_PORT:-$(envv AISDLC_BFF_PORT)}"; bff="${bff:-8340}"
idp="${AISDLC_OIDC_PORT:-$(envv AISDLC_OIDC_PORT)}"; idp="${idp:-8390}"
pw=secrets/keycloak-factory-admin-password
[ -s "$pw" ] || { echo "secret: $pw is missing: run make secrets, then make up" >&2; exit 1; }

tmp="$(mktemp -d)"; chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT
jar="$tmp/jar"

curl -fsS -o /dev/null "http://localhost:$bff/healthz" 2>/dev/null ||
  { echo "secret: the portal does not answer on http://localhost:$bff: start the stack first (make up or make up-full)" >&2; exit 1; }
kc_login "$bff" "$idp" factory-admin "$pw" "$jar" ||
  { echo "secret: could not sign in as factory-admin through Keycloak (http://keycloak.localhost:$idp)" >&2; exit 1; }
csrf="$(curl -fsS -b "$jar" "http://localhost:$bff/api/me" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).csrf_token??""))')"
[ -n "$csrf" ] || { echo "secret: no CSRF token from /api/me" >&2; exit 1; }

list() {
  curl -fsS -b "$jar" "http://localhost:$bff/api/secrets" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s);
  if (!j.store_reachable) console.log("  Vault did not answer: every row below is unknown");
  for (const r of j.secrets ?? []) {
    const state = !j.store_reachable ? "unknown" : r.set ? `set      version ${r.version}  ${r.updated_at ?? ""}  by ${r.updated_by ?? "outside the portal"}` : "not set";
    console.log(`  ${r.name.padEnd(20)} ${state}`);
  }
});'
}

case "${1:-}" in
  list) list ;;
  put)
    name="${2:-}"
    [ -n "$name" ] || { echo "secret: name the secret: make secret NAME=anthropic-api-key" >&2; exit 1; }
    umask 077
    if [ -n "${3:-}" ]; then
      [ -r "$3" ] || { echo "secret: cannot read $3" >&2; exit 1; }
      node -e 'process.stdout.write(JSON.stringify({ value: require("fs").readFileSync(process.argv[1], "utf8") }))' "$3" >"$tmp/body"
    else
      if [ -t 0 ]; then printf 'Value for %s (not shown): ' "$name" >&2; IFS= read -rs value || true; echo >&2; else IFS= read -r value || true; fi
      [ -n "$value" ] || { echo "secret: empty value, nothing saved" >&2; exit 1; }
      VALUE="$value" node -e 'process.stdout.write(JSON.stringify({ value: process.env.VALUE }))' >"$tmp/body"
      unset value
    fi
    code=$(curl -sS -o "$tmp/out" -w '%{http_code}' -b "$jar" -X PUT -H 'content-type: application/json' \
      -H "x-csrf-token: $csrf" --data-binary "@$tmp/body" "http://localhost:$bff/api/secrets/$name")
    rm -f "$tmp/body"
    if [ "$code" = 200 ]; then
      node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`secret: ${r.name} saved in Vault, version ${r.version} (the value is never shown again)`)' "$tmp/out"
    else
      echo "secret: the portal refused ($code): $(head -c 300 "$tmp/out")" >&2; exit 1
    fi
    ;;
  *) echo "usage: secret.sh put <name> [file] | list" >&2; exit 2 ;;
esac
