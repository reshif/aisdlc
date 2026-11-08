#!/usr/bin/env bash
# The first live exit (PLAN M8.5): onboard a real GitHub repository at Census on the local-prod
# stack, with a real GitHub App that holds read-only permissions. Run it on YOUR machine: the App's
# private key stays in platform/compose/secrets/github-app.pem and is mounted into one container
# (codehost). This script never prints, copies or sends it.
#
#   ./live-census.sh                       checks, builds, starts the stack, tells you where to log in
#   ./live-census.sh --wait-for-prr        the same, then waits until the readiness record is active
#                                          (you finish the cards in the browser meanwhile), then reports
#   ./live-census.sh --report              reports on a running stack: what the factory sent to GitHub,
#                                          the App's permissions, the S0 and readiness record, verify-ledger
#   ./live-census.sh --down [--purge]      stops the stack; keeps the database volumes unless --purge
#
# Options
#   --repo owner/name     the repository to onboard (default reshif/asf-factory-testbed)
#   --timeout SECONDS     how long --wait-for-prr waits (default 3600)
#   --skip-build          use the image aisdlc/factory:local as it is (a sandbox or a blocked network,
#                         see README.md); the default builds it, installing git with apt
#   --fake-github         DRY RUN: everything except GitHub, against the in-repo fake GitHub (no
#                         credentials, no App key). Uses its own compose project and refuses to run
#                         over a real App key
#
# Needs: Docker with Compose v2, openssl, curl. For a real run also GITHUB_APP_ID and
# GITHUB_INSTALLATION_ID (in the environment, or already in .env from an earlier run).
# Exit code: 0 all good; 1 a check or an assertion failed; 2 a prerequisite is missing.
set -euo pipefail
cd "$(dirname "$0")"

REPO=reshif/asf-factory-testbed
TIMEOUT=3600
MODE=up
PURGE=0
FAKE=0
SKIP_BUILD="${LIVE_SKIP_BUILD:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --wait-for-prr) MODE=wait ;;
    --report) MODE=report ;;
    --down) MODE=down ;;
    --purge) PURGE=1 ;;
    --fake-github) FAKE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --repo) REPO="${2:?--repo needs owner/name}"; shift ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "live-census: unknown argument $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ "$FAKE" = 1 ]; then
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-live-dry}"
  # A dry run cannot wait five minutes for a checkpoint.
  export CHECKPOINT_INTERVAL_MS="${CHECKPOINT_INTERVAL_MS:-15000}"
else
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc-live}"
fi
# The profile is harmless on a real run (it starts nothing without the fake), and `down` must always
# take the fake along if an earlier dry run left it.
dc() { docker compose --profile fake-github "$@"; }

T0=$SECONDS
step() { printf '\n== [%4ss] %s\n' $((SECONDS - T0)) "$*"; }
note() { printf '   %s\n' "$*"; }
die() { echo "live-census: $1" >&2; exit "${2:-1}"; }
missing() { echo "live-census: PREREQUISITE MISSING: $*" >&2; exit 2; }
PROBLEMS=0
problem() { echo "   PROBLEM: $*" >&2; PROBLEMS=$((PROBLEMS + 1)); }

# ------------------------------------------------------------------ --down
if [ "$MODE" = down ]; then
  step "stopping the stack (project $COMPOSE_PROJECT_NAME)"
  if [ "$PURGE" = 1 ]; then
    dc down -v --remove-orphans
    note "containers, networks AND volumes removed: the database (record, ledger, keys) is gone"
  else
    dc down --remove-orphans
    note "containers and networks removed; the volumes are kept (the ledger, the keys and the record survive)"
    note "to remove them too: ./live-census.sh --down --purge"
  fi
  exit 0
fi

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "the repository must look like owner/name, not: $REPO" 2
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
if [ "$FAKE" = 1 ] && [ "$REPO" != reshif/asf-factory-testbed ]; then
  die "the fake GitHub only has reshif/asf-factory-testbed" 2
fi

# ------------------------------------------------------------------ prerequisites
if [ "$MODE" != report ]; then
  step "prerequisites"
  command -v docker >/dev/null 2>&1 || missing "docker is not installed (https://docs.docker.com/get-docker/)"
  docker info >/dev/null 2>&1 || missing "docker is installed but not running (start Docker Desktop or the docker service)"
  docker compose version >/dev/null 2>&1 || missing "Docker Compose v2 ('docker compose') is not available; update Docker"
  command -v openssl >/dev/null 2>&1 || missing "openssl is not installed"
  command -v curl >/dev/null 2>&1 || missing "curl is not installed"
  note "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $(docker compose version --short 2>/dev/null || echo '?')"

  if [ "$FAKE" = 1 ]; then
    if [ -s secrets/github-app.pem ] && [ ! -e secrets/.github-app-fake ]; then
      die "secrets/github-app.pem is a real key: a dry run would use it against the fake GitHub. Run the dry run in another checkout, or move the key away first" 2
    fi
    note "DRY RUN against the fake GitHub: no credential is used"
  else
    pem=secrets/github-app.pem
    [ -s "$pem" ] || missing "the App private key is not at $(pwd)/$pem (see docs/runbooks/m8.5-live-census.md, step 2)"
    [ ! -e secrets/.github-app-fake ] || missing "$pem is the throwaway key of an earlier dry run: replace it with your App's key"
    mode_octal=$(stat -c '%a' "$pem" 2>/dev/null || stat -f '%Lp' "$pem")
    [ "$mode_octal" = 600 ] || missing "$pem has mode $mode_octal; it must be 600:  chmod 600 $(pwd)/$pem"
    head -1 "$pem" | grep -qE '^-----BEGIN (RSA )?PRIVATE KEY-----$' || missing "$pem does not look like a PEM private key (GitHub's download is a .pem file starting with -----BEGIN RSA PRIVATE KEY-----)"
    openssl rsa -in "$pem" -check -noout >/dev/null 2>&1 || missing "openssl cannot read $pem as an RSA private key"
    note "App key: present, mode 600, a valid RSA private key (contents never shown)"
    from_env() { sed -n "s/^$1=//p" .env 2>/dev/null | head -1; }
    APP_ID="${GITHUB_APP_ID:-$(from_env GITHUB_APP_ID)}"
    INST_ID="${GITHUB_INSTALLATION_ID:-$(from_env GITHUB_INSTALLATION_ID)}"
    [[ "${APP_ID:-}" =~ ^[0-9]+$ ]] || missing "GITHUB_APP_ID is not set to a number (export GITHUB_APP_ID=<the App ID from the App's settings page>)"
    [[ "${INST_ID:-}" =~ ^[0-9]+$ ]] || missing "GITHUB_INSTALLATION_ID is not set to a number (it is the number at the end of the installation's URL)"
    export GITHUB_APP_ID="$APP_ID" GITHUB_INSTALLATION_ID="$INST_ID"
    note "GITHUB_APP_ID=$APP_ID, GITHUB_INSTALLATION_ID=$INST_ID"
  fi
  note "repository: $REPO"
  if ! grep -q "\"logins\": \[[^]]*\"$OWNER\"" config/idp-seed.json 2>/dev/null; then
    note "WARNING: no person in config/idp-seed.json has the GitHub login \"$OWNER\"; the role map will not find the owner."
    note "         Put it in alice's \"logins\" (see the runbook), then run this script again."
  fi
  if [ -z "$(dc ps -q 2>/dev/null)" ]; then
    for p in 8340 8390; do
      if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
        missing "port $p is already in use on this machine (another program or another stack). Stop it, or run ./live-census.sh --down for an earlier run of this one"
      fi
    done
    note "ports 8340 (portal) and 8390 (sign-in page) are free"
  fi

  # ---------------------------------------------------------------- secrets, image, stack
  step "secrets and image"
  if [ "$FAKE" = 1 ]; then ./init-secrets --fake-github; else ./init-secrets --real-github; fi
  if [ "$SKIP_BUILD" = 1 ]; then
    docker image inspect aisdlc/factory:local >/dev/null 2>&1 || die "--skip-build but the image aisdlc/factory:local does not exist" 2
    note "using the existing image aisdlc/factory:local (build skipped)"
  else
    note "building the image the default way (first build: a few minutes; it installs git with apt)"
    dc build
  fi
  step "starting the stack"
  dc up -d --wait --wait-timeout 300
  note "every service is healthy"
  if [ "$FAKE" = 0 ]; then
    if dc ps --format '{{.Service}}' | grep -qx fake-github; then die "the fake-github container is running in a live run; run ./live-census.sh --down and start again"; fi
  fi
fi

# ------------------------------------------------------------------ helpers to read the stack
# One line of key=value pairs about the S0 record and the readiness record of $REPO, read from core.
core_status() {
  dc exec -T -e TOKEN="$(cat secrets/tok-operator-core)" -e REPO="$REPO" core node -e '
const base = "http://127.0.0.1:8380";
const h = { authorization: `Bearer ${process.env.TOKEN}` };
const get = async (p) => { const r = await fetch(base + p, { headers: h }); return r.status === 200 ? await r.json() : null; };
const out = { s0: "none", step01: "-", project: "-", prr: "none", level: "-", hash: "-", version: "-", plan: "-" };
const list = await get(`/v1/repos/${process.env.REPO}/s0`);
const s0 = Array.isArray(list) ? list[0] : undefined;
if (s0) {
  out.s0 = s0.record.status; out.project = s0.record.project_id;
  out.step01 = (s0.steps.find((x) => x.step === "0.1") ?? {}).state ?? "-";
  const prr = await get(`/v1/projects/${s0.record.project_id}/prr`);
  const g = prr?.repos?.find((r) => r.repo.toLowerCase() === process.env.REPO.toLowerCase())?.governing;
  if (g) { out.prr = g.effective_status; out.version = g.version; out.level = g.record.level.signed; out.hash = g.record.record_hash; out.plan = g.record.repo.plan; }
}
console.log(Object.entries(out).map(([k, v]) => `${k}=${v}`).join(" "));
' 2>/dev/null || echo "s0=unreadable"
}
field() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }

# ------------------------------------------------------------------ what to do in the browser
if [ "$MODE" != report ]; then
  step "the portal is up"
  cat <<TXT
   Open:       http://localhost:8340
   Sign in:    you are sent to the stand-in sign-in page (http://dev-oidc.localhost:8390);
               pick  alice  ("Alice Example (factory admin)"). Nobody else can onboard.
   Onboard:    repository  $REPO,  level  Census.
   Then decide cards 1, 4 and 5 (the runbook says what to choose), decide and publish the settings
   revision card 4 proposes, and sign card 5 with the step-up.
   Runbook:    docs/runbooks/m8.5-live-census.md
TXT
fi

if [ "$MODE" = up ]; then
  cat <<TXT

   When the readiness record is active (or at any point to see where it is), run:
       platform/compose/live-census.sh --report
   To stop:   platform/compose/live-census.sh --down
TXT
  exit 0
fi

if [ "$MODE" = wait ]; then
  step "waiting for the readiness record to become active (up to ${TIMEOUT}s)"
  last=""
  end=$((SECONDS + TIMEOUT))
  while :; do
    st=$(core_status)
    line="S0 $(field "$st" s0), step 0.1 $(field "$st" step01), readiness record $(field "$st" prr)"
    if [ "$line" != "$last" ]; then note "$line"; last="$line"; fi
    [ "$(field "$st" prr)" = active ] && break
    [ "$SECONDS" -lt "$end" ] || die "the readiness record is not active after ${TIMEOUT}s (last: $line). Finish the cards in the browser, then run --report"
    sleep 5
  done
fi

# ------------------------------------------------------------------ the report
step "1. what the factory sent to GitHub (the codehost's request log)"
raw=$(dc logs --no-log-prefix --no-color codehost 2>&1 | grep -E '^codehost: ghreq ' || true)
if [ -z "$raw" ]; then
  problem "the codehost logged no request to GitHub: has the onboarding started?"
else
  # codehost: ghreq {"method":"GET","path":"/repos/{owner}/{repo}/contents/{path}","status":200,"auth":"hub"}
  rows=$(printf '%s\n' "$raw" | sed -E 's/^codehost: ghreq \{"method":"([A-Z_]+)","path":"([^"]*)","status":([0-9]+),"auth":"([a-z]+)"\}$/\1 \2 \3/' | grep -E '^[A-Z_]+ /' || true)
  gets=$(printf '%s\n' "$rows" | grep '^GET ' || true)
  mints=$(printf '%s\n' "$rows" | grep '^POST ' || true)
  gitf=$(printf '%s\n' "$rows" | grep '^GIT_FETCH ' || true)
  other=$(printf '%s\n' "$rows" | grep -vE '^(GET|POST|GIT_FETCH) ' || true)
  echo "   resource requests (method, path template, status, how many):"
  if [ -n "$gets" ]; then printf '%s\n' "$gets" | sort | uniq -c | sed 's/^/     /'; else echo "     none"; fi
  echo "   token mints (the App asking GitHub for a read-only installation token; listed apart):"
  if [ -n "$mints" ]; then printf '%s\n' "$mints" | sort | uniq -c | sed 's/^/     /'; else echo "     none"; fi
  echo "   git fetches (read-only smart-HTTP upload-pack, status 200 = ok):"
  if [ -n "$gitf" ]; then printf '%s\n' "$gitf" | sort | uniq -c | sed 's/^/     /'; else echo "     none"; fi
  non_get_resource=$(printf '%s\n' "$mints" | grep -vE '^POST /app/installations/\{installation_id\}/access_tokens ' | grep . || true)
  if [ -n "$other" ] || [ -n "$non_get_resource" ]; then
    problem "a request that is not a GET on a resource and not the token mint: ${other:-}${non_get_resource:-}"
  else
    echo "   => ASSERTED: every resource request is a GET; the only POST is the token mint; git was only fetched from"
  fi
fi

step "2. the App installation's permissions, as GitHub reports them"
inst=$(dc exec -T core-worker node -e '
const t = require("node:fs").readFileSync("/run/secrets/tok-core-worker-codehost", "utf8").trim();
fetch("http://codehost:8350/v1/installation", { headers: { authorization: `Bearer ${t}` } })
  .then((r) => r.json()).then((j) => {
    const v = j.value ?? j;
    if (!v || typeof v.permissions !== "object") { console.log("UNREADABLE " + JSON.stringify(j).slice(0, 200)); return; }
    console.log("selection=" + v.repository_selection + " suspended=" + v.suspended + " account=" + v.account_login);
    for (const [k, l] of Object.entries(v.permissions).sort()) console.log("perm " + k + "=" + l);
  }).catch((e) => console.log("UNREADABLE " + e.message));
' 2>/dev/null || echo "UNREADABLE")
if printf '%s\n' "$inst" | grep -q '^UNREADABLE'; then
  problem "the installation could not be read through the codehost: $inst"
else
  printf '%s\n' "$inst" | grep -v '^perm ' | sed 's/^/   /'
  printf '%s\n' "$inst" | grep '^perm ' | sed 's/^perm /   permission: /'
  if printf '%s\n' "$inst" | grep -q '^perm statuses='; then
    problem "the App still has the 'statuses' permission (DEC-7 removed it): remove it in the App's settings (Permissions and events), then accept the new permissions on the installation"
  else
    echo "   => ASSERTED: 'statuses' is absent"
  fi
  loud=$(printf '%s\n' "$inst" | grep '^perm ' | grep -vE '=read$' || true)
  [ -z "$loud" ] || problem "the App has permissions above read: $loud"
  printf '%s\n' "$inst" | grep -q '^selection=selected' || problem "the App is installed on ALL repositories; it should be installed on selected repositories only"
fi

step "3. S0 and the readiness record (PRR)"
st=$(core_status)
echo "   repository:        $REPO"
echo "   S0 status:         $(field "$st" s0)   (step 0.1: $(field "$st" step01))"
echo "   PRR status:        $(field "$st" prr)"
echo "   PRR level:         $(field "$st" level)"
echo "   PRR version:       $(field "$st" version)"
echo "   PRR record_hash:   $(field "$st" hash)"
echo "   PRR owner's plan:  $(field "$st" plan)   (what you attested on card 4; GitHub does not tell the factory)"
[ "$(field "$st" s0)" = done ] || problem "the S0 record is not done (status $(field "$st" s0))"
[ "$(field "$st" prr)" = active ] || problem "the readiness record is not active (status $(field "$st" prr))"
[ "$(field "$st" level)" = census ] || problem "the readiness record is not at level census (level $(field "$st" level))"

step "4. verify-ledger (the ledger checked offline, with the Notary's and the Witness's public keys from kms-local)"
# A checkpoint is made every CHECKPOINT_INTERVAL_MS (5 minutes unless you set it); wait for one that covers the head.
if ./verify-ledger.sh --wait 420; then
  echo "   => ASSERTED: the ledger verifies"
else
  problem "verify-ledger did not pass"
fi

echo
if [ "$PROBLEMS" = 0 ]; then
  echo "live-census: PASS (the request log, the permissions, S0, the readiness record and the ledger all check out)"
  [ "$FAKE" = 1 ] && echo "live-census: this was a DRY RUN on the fake GitHub; the real exit needs your App"
  exit 0
fi
echo "live-census: $PROBLEMS problem(s) above" >&2
exit 1
