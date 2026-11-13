# shellcheck shell=bash
# The full stack's setup, ONE copy for the owner's path (up-full.sh, `make up-full`) and the test's (e2e-pr.sh,
# `npm run e2e:pr`), so the two cannot drift. Sourced from platform/compose; it defines functions and runs nothing.
#
# What "full" is: compose profile `full` (the Push Broker, both Docker socket proxies, the package mirror, the
# sandbox-controller, verify, gate-check) and core-worker on the real ports: planning (S1 to S5) through the gateway,
# coding in W sessions through the sandbox-controller (S6), the verify service (S7), the signed Evidence Pack (7.6) and
# the Push Broker (6.6). Plus the images by digest (the W image LF4 is about, the onboarding probe and its lock), the
# seed's sandbox settings (each its own M1 revision: DEC-18's allow-list, the probe image, the W image) and SP-STD-1,
# the W image's isolation report LF4 needs, posted once the stack is up.
#
# The callers differ only in what they choose: e2e-pr.sh a throwaway project on its own ports, the fake GitHub, the
# testbed fixtures and the testbed allow-listed; up-full.sh the persistent project `aisdlc` on 8340/8390, the fake or
# the real GitHub, the owner's repo allow-listed and the gateway's routes as the owner decided them.

# The four images, by name, from AISDLC_IMAGE_TAG (build-images.sh builds the same names).
full_images() {
  local tag="${AISDLC_IMAGE_TAG:-local}"
  export AISDLC_FACTORY_IMAGE="${AISDLC_FACTORY_IMAGE:-aisdlc/factory:$tag}"
  export SANDBOX_IMAGE="${SANDBOX_IMAGE:-aisdlc/sandbox:$tag}"
  export SANDBOX_AGENT_IMAGE="${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:$tag}"
  export SANDBOX_ONBOARDING_TAG="${SANDBOX_ONBOARDING_TAG:-aisdlc/sandbox-onboarding:$tag}"
}

# full_build_images: build-images.sh with the names above (its RUNTIME_IMAGE, EXTRA_CA, BUILD_PROXY, BUILD_NETWORK apply)
full_build_images() {
  bash ./build-images.sh
}

# full_require_images: each image exists, or say how to build it
full_require_images() {
  local i
  for i in "$AISDLC_FACTORY_IMAGE" "$SANDBOX_IMAGE" "$SANDBOX_AGENT_IMAGE" "$SANDBOX_ONBOARDING_TAG"; do
    docker image inspect "$i" >/dev/null 2>&1 ||
      full_fail "the image $i does not exist: build the four with \`make images\` (AISDLC_IMAGE_TAG=${AISDLC_IMAGE_TAG:-local})"
  done
}

# full_pin_images: the W image and the probe image by digest, the probe's pin lock (the seed publishes them, the
# controller checks the W image against SANDBOX_AGENT_IMAGE_ID, the coding proxy allows the probe by digest)
full_pin_images() {
  SANDBOX_AGENT_IMAGE_ID=$(docker image inspect "$SANDBOX_AGENT_IMAGE" --format '{{.Id}}')
  SANDBOX_ONBOARDING_IMAGE=$(docker image inspect "$SANDBOX_ONBOARDING_TAG" --format '{{.Id}}')
  SANDBOX_ONBOARDING_LOCK_SHA256=$(sha256sum ../sandbox/onboarding/pins.json | cut -d' ' -f1)
  local label
  label=$(docker image inspect "$SANDBOX_ONBOARDING_TAG" --format '{{index .Config.Labels "aisdlc.onboarding.lock.sha256"}}')
  [ "$label" = "$SANDBOX_ONBOARDING_LOCK_SHA256" ] ||
    full_fail "the probe image $SANDBOX_ONBOARDING_TAG was built from another pin lock ($label): \`make images\` again"
  export SANDBOX_AGENT_IMAGE_ID SANDBOX_ONBOARDING_IMAGE SANDBOX_ONBOARDING_LOCK_SHA256
  echo "  W image $SANDBOX_AGENT_IMAGE_ID, probe image $SANDBOX_ONBOARDING_IMAGE"
}

# full_wiring REPO: core-worker on the real stage ports, real verify (never the scripted S7), the seed's allow-list
full_wiring() {
  export CORE_WORKER_STAGE_PORTS=agents
  export CORE_WORKER_SANDBOX_CONTROLLER_URL=http://sandbox-controller:8430
  export CORE_WORKER_VERIFY_URL=http://verify:8440
  export CORE_WORKER_PUSH_BROKER=1
  export CORE_WORKER_PUSH_BROKER_URL=http://push-broker:8350
  export CORE_WORKER_FAKE_VERIFY=default
  export SEED_EXEC_ALLOWED_REPOS="$1"
  DOCKER_GID="${DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock)}"
  export DOCKER_GID
}

# full_scratch DIR: the directory the sandbox-controller writes read-only repo copies to (the same path for the
# containers and the daemon, so it must be a host path); world-writable with the sticky bit, like /tmp
full_scratch() {
  mkdir -p "$1"
  chmod 1777 "$1"
  SANDBOX_SCRATCH="$(cd "$1" && pwd)"
  export SANDBOX_SCRATCH
}

# full_fake_apps two|split: the GitHub Apps on the fake GitHub. `two` (the default) is what ./setup-github-apps writes
# for the real one: ONE factory App for the codehost and the Push Broker (the same id, installation and key), its bot
# the PR author, and gate-check's own App. `split`: the Push Broker on an App of its own (the stricter layout).
full_fake_apps() {
  case "$1" in
    two)
      local envv
      PUSH_BROKER_APP_ID="$(sed -n 's/^GITHUB_APP_ID=//p' .env | tail -1)"
      PUSH_BROKER_INSTALLATION_ID="$(sed -n 's/^GITHUB_INSTALLATION_ID=//p' .env | tail -1)"
      envv="${FULL_FAKE_BOT_LOGIN:-aisdlc-factory-e2e[bot]}"
      export PUSH_BROKER_APP_ID PUSH_BROKER_INSTALLATION_ID AISDLC_PUSH_BROKER_KEY=github-app
      export PUSH_BROKER_LOGIN="$envv" GATE_CHECK_PUSH_BROKER_LOGIN="$envv"
      echo "  two Apps: factory App $PUSH_BROKER_APP_ID (installation $PUSH_BROKER_INSTALLATION_ID) reads and pushes as $PUSH_BROKER_LOGIN; gate-check apart"
      ;;
    split) echo "  split Apps: the Push Broker on its own App" ;;
    *) full_fail "the App layout is two or split, not '$1'" ;;
  esac
}

# full_check_fake_env: .env is the fake GitHub's (init-secrets --fake-github), so a real App's ids are never used with
# the fake GitHub (or the other way round)
full_check_fake_env() {
  grep -qx 'CODEHOST_GITHUB_API_URL=http://127.0.0.1:8353' .env ||
    full_fail ".env points at a real GitHub (it is what ./setup-github-apps or ./init-secrets --real-github wrote): use GITHUB=real, or \`make secrets\` to go back to the fake one"
}

# full_check_real_github: the two Apps exist (./setup-github-apps, docs/getting-started.md §4): their ids in .env, their
# keys in secrets/, none of them a throwaway init-secrets made
full_check_real_github() {
  local v val bad=0
  for v in GITHUB_APP_ID GITHUB_INSTALLATION_ID PUSH_BROKER_APP_ID PUSH_BROKER_INSTALLATION_ID GATE_CHECK_APP_ID GATE_CHECK_INSTALLATION_ID; do
    val="$(sed -n "s/^$v=//p" .env 2>/dev/null | tail -1)"
    case "$val" in '' | *[!0-9]*) echo "  .env: $v is '${val}', not an id" >&2; bad=1 ;; esac
  done
  for v in PUSH_BROKER_LOGIN GATE_CHECK_PUSH_BROKER_LOGIN; do
    val="$(sed -n "s/^$v=//p" .env 2>/dev/null | tail -1)"
    case "$val" in *'[bot]') ;; *) echo "  .env: $v is '${val}', not the factory App's <slug>[bot]" >&2; bad=1 ;; esac
  done
  [ -z "$(sed -n 's/^CODEHOST_GITHUB_API_URL=//p' .env | tail -1)" ] || { echo "  .env: CODEHOST_GITHUB_API_URL points at a fake GitHub" >&2; bad=1; }
  for v in github-app push-broker-app gate-check-app; do
    if [ ! -s "secrets/$v.pem" ]; then
      echo "  secrets/$v.pem is missing" >&2; bad=1
    elif [ -e "secrets/.$v-fake" ]; then
      echo "  secrets/$v.pem is a throwaway key init-secrets made, not your App's" >&2; bad=1
    fi
  done
  [ "$bad" = 0 ] || full_fail "the real GitHub Apps are not set up: run \`make github-apps\` (docs/getting-started.md §4.1), or §4.3 by hand"
}

# full_idp_seed DIR: the IdP seed names the issuer with its port; on another port than 8390 the stack gets its own copy
full_idp_seed() {
  if [ "${AISDLC_OIDC_PORT:-8390}" != 8390 ]; then
    export AISDLC_IDP_SEED_FILE="$1/idp-seed.json"
    sed "s#http://dev-oidc.localhost:8390#http://dev-oidc.localhost:$AISDLC_OIDC_PORT#g" config/idp-seed.json >"$AISDLC_IDP_SEED_FILE"
    chmod 644 "$AISDLC_IDP_SEED_FILE"
  fi
}

# full_ports_free: the two published ports are free, unless they are this project's own (a stack brought up again)
full_ports_free() {
  local p
  [ -n "$(docker compose ps -q bff 2>/dev/null)" ] && return 0
  for p in "${AISDLC_BFF_PORT:-8340}" "${AISDLC_OIDC_PORT:-8390}"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then full_fail "port $p is already in use on this host (another stack?)"; fi
  done
}

# full_sp_std_1 DIR: SP-STD-1 (the planted-instruction isolation test: real W sessions on this daemon) on the W image,
# its report at DIR/sp-std-1.json. A report already there for exactly this image is kept (the image did not change).
# The report is written before the test's own leftover check (a sandbox of another run on a shared daemon may fail that);
# core computes the verdict itself when it is posted, so a failing report gives no LF4. A coding session of another run
# on the same daemon makes the proxy answer busy (one W at a time): tried three times.
full_sp_std_1() {
  local dir="$1" attempt repo_root
  repo_root="$(cd ../.. && pwd)"
  if [ -s "$dir/sp-std-1.json" ] && grep -q "\"worker_image\": \"$SANDBOX_AGENT_IMAGE_ID\"" "$dir/sp-std-1.json"; then
    echo "  the report for $SANDBOX_AGENT_IMAGE_ID is already there ($dir/sp-std-1.json)"
    return 0
  fi
  for attempt in 1 2 3; do
    rm -f "$dir/sp-std-1.json"
    (cd "$repo_root" && SP_STD_1_EVIDENCE_DIR="$dir" SANDBOX_IMAGE="$SANDBOX_IMAGE" SANDBOX_AGENT_IMAGE="$SANDBOX_AGENT_IMAGE" \
      npx vitest run --project coding-runner isolation >"$dir/sp-std-1.log" 2>&1) && break
    echo "  (attempt $attempt: the isolation test exited non-zero: $(grep -E 'Tests ' "$dir/sp-std-1.log" | tr -s ' '))"
    [ -s "$dir/sp-std-1.json" ] && break
    sleep 30
  done
  [ -s "$dir/sp-std-1.json" ] || { tail -40 "$dir/sp-std-1.log"; full_fail "SP-STD-1 wrote no report"; }
  grep -q "\"worker_image\": \"$SANDBOX_AGENT_IMAGE_ID\"" "$dir/sp-std-1.json" || full_fail "the SP-STD-1 report is not about $SANDBOX_AGENT_IMAGE_ID"
}

# full_post_sp_std_1 FILE: the operator posts the report; core computes the verdict against onboarding.light_tests.
# The same report again is the same record (core keys it by its hash).
full_post_sp_std_1() {
  node -e 'process.stdout.write(JSON.stringify({kind:"sp-std-1",report:JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}))' "$1" |
    docker compose exec -T core node -e '
      let b = ""; process.stdin.on("data", (d) => (b += d)).on("end", async () => {
        const tok = require("fs").readFileSync("/run/secrets/tok-operator-core", "utf8").trim();
        const r = await fetch("http://127.0.0.1:8380/v1/onboarding/spikes", { method: "POST", body: b,
          headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
        const j = await r.json(); console.log(`  ${r.status} verdict ${JSON.stringify(j.verdict ?? j)}`);
        process.exit((r.status === 201 || r.status === 200) && j.verdict?.passed === true ? 0 : 1);
      });' || full_fail "the SP-STD-1 report was not recorded as passing"
}

full_fail() {
  echo "${FULL_WHO:-full-env}: FAIL: $*" >&2
  exit 1
}
