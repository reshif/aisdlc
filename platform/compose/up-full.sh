#!/usr/bin/env bash
# The owner's factory: the full stack, persistent, wired for real work on ONE repository (`make up-full`).
#
#   platform/compose/up-full.sh --repo owner/name [--github fake|real]
#
# What it does (the setup is full-env.sh, the same code e2e-pr.sh runs, so the owner's stack and the tested one cannot
# drift):
#   1. checks the secrets and the GitHub side: `real` needs the two Apps (./setup-github-apps: their ids in .env, their
#      keys in secrets/, none a throwaway); `fake` needs the fake GitHub's .env (init-secrets --fake-github)
#   2. checks the four images (`make images`) and pins the W image and the probe image by digest
#   3. SP-STD-1 on the W image (LF4's isolation report; once per image, kept under the state directory)
#   4. `docker compose --profile full [--profile fake-github] up -d --wait` with core-worker on the real ports (planning,
#      coding in W sessions, verify, the Evidence Pack, the Push Broker) and the seed publishing, each through its own
#      M1 revision, `sandbox.exec_allowed_repos = [REPO]` (DEC-18: a repository you own), the probe image and the W image
#   5. posts the SP-STD-1 report, then prints the portal's address and what is real and what is fake
#
# It runs again safely: the volumes (the record, the ledger, the keys) are kept, and so is every M1 decision (the seed
# never reverts the model routes the owner pointed at Claude). `make down` stops it, `make reset` deletes it.
#
# Environment (all optional):
#   COMPOSE_PROJECT_NAME    default aisdlc
#   AISDLC_SUBNET_PREFIX    default 10.231 (every network a /24 under it)
#   AISDLC_BFF_PORT, AISDLC_OIDC_PORT   default 8340 and 8390
#   AISDLC_IMAGE_TAG        default local (the tag `make images` built)
#   AISDLC_STATE_DIR        default platform/compose/.scratch/<project>: the sandbox scratch (repo copies the sessions
#                           read) and the SP-STD-1 report. A host path: the daemon binds from it
#   SEED_FAKE_FIXTURES      the fake model provider's canned answers: `planning` (default) or `testbed` (scripts the
#                           coding sessions and the reviews for the fake testbed; the e2e only)
#   CHECKPOINT_INTERVAL_MS  the ledger checkpointer's period (default 5 minutes)
#   UP_FULL_SKIP_SP_STD_1=1 do not run or post SP-STD-1 (LF4 then stays unknown: no Light)
set -euo pipefail
cd "$(dirname "$0")"
FULL_WHO=up-full
# shellcheck source=full-env.sh
. ./full-env.sh

REPO="" GITHUB=fake
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --github) GITHUB="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) full_fail "unknown argument $1 (--repo owner/name [--github fake|real])" ;;
  esac
done
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || full_fail "name the repository agents may work on: --repo owner/name (make up-full REPO=owner/name)"
case "$GITHUB" in fake | real) ;; *) full_fail "--github is fake or real, not '$GITHUB'" ;; esac

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aisdlc}"
export AISDLC_BFF_PORT="${AISDLC_BFF_PORT:-8340}" AISDLC_OIDC_PORT="${AISDLC_OIDC_PORT:-8390}"
state="${AISDLC_STATE_DIR:-.scratch/$COMPOSE_PROJECT_NAME}"
profiles=(--profile full)
[ "$GITHUB" = fake ] && profiles+=(--profile fake-github)
dc() { docker compose "${profiles[@]}" "$@"; }

echo "== secrets and GitHub ($GITHUB)"
if [ "$GITHUB" = fake ]; then
  [ -e .env ] || ./init-secrets --fake-github >/dev/null
  full_check_fake_env
  ./init-secrets
  full_fake_apps two
  [ "$REPO" = reshif/asf-factory-testbed ] ||
    echo "  note: the fake GitHub serves one repository, reshif/asf-factory-testbed; $REPO is allow-listed but cannot be onboarded on it"
else
  [ -e .env ] || full_fail "no .env: run \`make secrets\` then \`make github-apps\` (docs/getting-started.md §4.1)"
  ./init-secrets
  full_check_real_github
  echo "  factory App $(sed -n 's/^GITHUB_APP_ID=//p' .env | tail -1) (pushes as $(sed -n 's/^PUSH_BROKER_LOGIN=//p' .env | tail -1)), gate-check App $(sed -n 's/^GATE_CHECK_APP_ID=//p' .env | tail -1)"
fi

echo "== images (${AISDLC_IMAGE_TAG:-local})"
full_images
full_require_images
full_pin_images

full_wiring "$REPO"
mkdir -p "$state/evidence"
chmod 755 "$state" "$state/evidence"
full_scratch "$state/sandbox"
full_idp_seed "$state/evidence"
full_ports_free

if [ "${UP_FULL_SKIP_SP_STD_1:-0}" != 1 ]; then
  echo "== SP-STD-1 on the W image (LF4's evidence; real W sessions on this daemon, a few minutes the first time)"
  full_sp_std_1 "$state/evidence"
fi

echo "== up -d --wait (project $COMPOSE_PROJECT_NAME)"
dc up -d --wait --wait-timeout 420

if [ "${UP_FULL_SKIP_SP_STD_1:-0}" != 1 ]; then
  echo "== the operator posts the SP-STD-1 report (core computes the verdict against onboarding.light_tests)"
  full_post_sp_std_1 "$state/evidence/sp-std-1.json"
fi

# What the gateway routes to now (the effective factory revision) and whether a vendor key is in place
routes=$(docker compose exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres psql -U postgres -d aisdlc -At -c "
  SELECT string_agg((x->>'data_class') || '->' || (x->>'model_id'), ', ' ORDER BY x->>'data_class')
  FROM (SELECT r.doc FROM config.config_published p JOIN config.config_revision r USING (rev_hash)
        WHERE r.layer = 'factory' ORDER BY p.global_seq DESC LIMIT 1) d,
       jsonb_array_elements(d.doc->'gateway.routes') x WHERE x->>'environment' = 'local'" 2>/dev/null || true)
# the vendor key: in Vault when the registry names the Vault field (the default), else the mounted file
key_ref="${AISDLC_ANTHROPIC_KEY_REF:-vault:gateway/anthropic-api-key#value}"
if [ "${key_ref#vault:}" != "$key_ref" ]; then
  vault_key=$(docker compose exec -T -e TOKEN="$(cat secrets/tok-operator-core)" core node -e '
fetch("http://127.0.0.1:8380/v1/secrets?on_behalf_of=alice", { headers: { authorization: `Bearer ${process.env.TOKEN}` } })
  .then((r) => r.json()).then((j) => { const s = (j.secrets ?? []).find((x) => x.name === "anthropic-api-key");
    console.log(s?.set ? `in Vault (version ${s.version}, ${s.updated_at})` : "not set yet: paste it in the portal (Integrations, or PUT /api/secrets/anthropic-api-key)"); })
  .catch(() => console.log("unknown (core did not answer)"));' 2>/dev/null || echo unknown)
  key="$vault_key"
elif [ -e secrets/.anthropic-key-placeholder ]; then key="placeholder (no vendor key)"; else key="set (secrets/anthropic-api-key, mounted in the gateway only)"; fi
case "$routes" in
  *claude*) models="routed to Claude where shown" ;;
  *) models="the deterministic FAKE provider answers every agent (fixtures ${SEED_FAKE_FIXTURES:-planning}): no model does the work until you route to Claude (docs/getting-started.md §5)" ;;
esac
if [ "$GITHUB" = fake ]; then gh="FAKE: the in-repo fake GitHub (one repository, reshif/asf-factory-testbed); PRs are opened there"; else gh="REAL: api.github.com with your factory App (reads, pushes agent/* branches and Draft PRs) and gate-check App (aisdlc/gate)"; fi

cat <<EOF

== up-full: the factory is up (project $COMPOSE_PROJECT_NAME)
  Portal        http://localhost:$AISDLC_BFF_PORT   (the sign-in people: docs/getting-started.md §3)
  Repository    $REPO may run code in sandboxes (sandbox.exec_allowed_repos, M1-published by the seed)
  GitHub        $gh
  Model routes  ${routes:-unknown}: $models
  Vendor key    $key
  Coding (S6)   REAL: W sandbox sessions on this Docker daemon (one at a time), scratch $SANDBOX_SCRATCH
  Verify (S7)   REAL: the verify service, the signed Evidence Pack, gate-check's aisdlc/gate
  Push (6.6)    REAL against the GitHub above: the Push Broker writes agent/<item>/<unit> and a Draft PR; a person merges
  Sign-in       Keycloak (http://keycloak.localhost:$AISDLC_OIDC_PORT): the test people (alice, lt, ...; password in
                secrets/keycloak-persona-password) and the break-glass factory admin \`factory-admin\` (password in
                secrets/keycloak-factory-admin-password); Keycloak's own admin is kc-admin (secrets/keycloak-bootstrap-admin)
  Secrets       Vault (LOCAL PROD ONLY: one unseal key in secrets/vault/$COMPOSE_PROJECT_NAME/, it unseals itself); paste a
                key once in the portal (PUT /api/secrets/<name>), it is never shown again
  Stubbed       key custody (kms-local), the first admin (the seed), Vault's auto-unseal and plain-http Keycloak;
                release is the fake unless CORE_WORKER_RELEASE=gate-relay (README.md, "What local-prod stubs")
  Next          sign in as alice (factory admin), Integrations (/integrations) › Repositories › Onboard $REPO
                (Light for agent lanes: docs/getting-started.md §6); route the models to Claude first (§5)
  Logs          make logs SERVICE=core-worker   (make ps: every container and its health)
  Stop          make down (keeps everything)   Delete: make reset
EOF
