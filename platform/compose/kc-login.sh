# shellcheck shell=bash
# Signs a person in to the portal through Keycloak with curl, the way a browser does (sourced by smoke.sh and
# drill-restore.sh; Playwright drives a real browser in the e2e runs):
#
#   kc_login <bff port> <idp port> <username> <password file> <cookie jar>
#
# GET the bff's /auth/login (the attempt's binder cookie in the jar), follow it to Keycloak's login page, post the
# username and password to the form's action, and follow Keycloak's redirect back to the bff's /auth/callback (the
# session cookie lands in the jar). Keycloak's own cookies are `Secure`: a browser keeps them on http://*.localhost (a
# secure context), curl does not store them from plain http, so they are carried by hand between the two Keycloak
# requests. The password is read from its file and never printed. Returns non-zero with a message on any failure.
kc_login() {
  local bff="$1" idp="$2" user="$3" pwfile="$4" jar="$5"
  local resolve="--resolve keycloak.localhost:$idp:127.0.0.1" tmp loc page action kc back
  tmp="$(mktemp -d)"
  loc=$(curl -fsS -o /dev/null -D- -c "$jar" -b "$jar" "http://localhost:$bff/auth/login" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  [ -n "$loc" ] || { echo "kc_login: /auth/login did not redirect" >&2; rm -rf "$tmp"; return 1; }
  case "$loc" in "http://keycloak.localhost:$idp/"*) ;; *) echo "kc_login: /auth/login sent the browser to $loc, not Keycloak" >&2; rm -rf "$tmp"; return 1 ;; esac
  # shellcheck disable=SC2086
  curl -fsS $resolve -D "$tmp/h" -o "$tmp/page" "$loc" || { echo "kc_login: Keycloak's login page did not load" >&2; rm -rf "$tmp"; return 1; }
  kc=$(grep -i '^set-cookie:' "$tmp/h" | sed 's/^[Ss]et-[Cc]ookie: *//; s/;.*//' | tr -d '\r' | paste -sd ';' -)
  action=$(grep -o 'id="kc-form-login" action="[^"]*"' "$tmp/page" | sed 's/.*action="//; s/"$//; s/&amp;/\&/g')
  [ -n "$action" ] || { echo "kc_login: no login form on Keycloak's page" >&2; rm -rf "$tmp"; return 1; }
  # shellcheck disable=SC2086
  back=$(curl -sS $resolve -o "$tmp/after" -D- -H "Cookie: $kc" --data-urlencode "username=$user" \
    --data-urlencode "password@$pwfile" "$action" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  case "$back" in
    "http://localhost:$bff/auth/callback?"*) ;;
    *) echo "kc_login: Keycloak did not sign $user in (no redirect to the portal)" >&2; rm -rf "$tmp"; return 1 ;;
  esac
  curl -fsS -o /dev/null -b "$jar" -c "$jar" "$back" || { echo "kc_login: the bff refused the callback" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}
