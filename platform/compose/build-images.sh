#!/usr/bin/env bash
# Builds the four images the full stack runs (`make images`), all under one tag:
#
#   aisdlc/factory:<tag>              every service (platform/compose/Dockerfile)
#   aisdlc/sandbox:<tag>              the sandbox base: pinned node, uid 10002, the aisdlc-run wrapper (platform/sandbox)
#   aisdlc/sandbox-agent:<tag>        the W image: the sandbox base + the coding runner + the agent harness binary
#   aisdlc/sandbox-onboarding:<tag>   the onboarding probe image (LF3), from the pinned lock (platform/sandbox/onboarding)
#
# Needs Docker and the repo's node_modules (`npm ci`: the W image takes the harness binary from the pinned SDK package).
#
#   AISDLC_IMAGE_TAG=local     the tag (default local); up-full.sh and e2e-pr.sh read the same variable
#   RUNTIME_IMAGE=...          the factory image's runtime base: a node:22 bookworm-slim image that already has git,
#                              where apt is blocked (README.md, "Using a real GitHub App")
#   EXTRA_CA=/path/ca.pem      a CA to trust during the factory image's `npm ci` (a TLS-inspecting proxy), as a build
#                              secret: it is never in a layer
#   BUILD_PROXY=1              pass HTTPS_PROXY, HTTP_PROXY and NO_PROXY from this shell as build args
#   BUILD_NETWORK=host         the factory build's network (a proxy on the host's loopback needs `host`)
#   IMAGES="factory sandbox agent onboarding"   build only these
#
# Prints the W image's and the probe image's digests at the end (what the stack pins).
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"
TAG="${AISDLC_IMAGE_TAG:-local}"
FACTORY="${AISDLC_FACTORY_IMAGE:-aisdlc/factory:$TAG}"
SANDBOX="${SANDBOX_IMAGE:-aisdlc/sandbox:$TAG}"
AGENT="${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:$TAG}"
ONBOARDING="${SANDBOX_ONBOARDING_TAG:-aisdlc/sandbox-onboarding:$TAG}"
IMAGES="${IMAGES:-factory sandbox agent onboarding}"
want() { case " $IMAGES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
fail() { echo "build-images: FAIL: $*" >&2; exit 1; }

if want factory; then
  echo "== $FACTORY (every service; the first build runs npm ci and npm run build inside the image)"
  args=(-f platform/compose/Dockerfile -t "$FACTORY")
  [ -n "${RUNTIME_IMAGE:-}" ] && args+=(--build-arg "RUNTIME_IMAGE=$RUNTIME_IMAGE")
  if [ -n "${EXTRA_CA:-}" ]; then
    [ -s "$EXTRA_CA" ] || fail "EXTRA_CA=$EXTRA_CA is not a readable file"
    args+=(--secret "id=extra_ca,src=$EXTRA_CA")
  fi
  if [ "${BUILD_PROXY:-0}" = 1 ]; then
    for v in HTTPS_PROXY HTTP_PROXY NO_PROXY; do
      [ -n "${!v:-}" ] && args+=(--build-arg "$v=${!v}")
    done
  fi
  [ -n "${BUILD_NETWORK:-}" ] && args+=(--network "$BUILD_NETWORK")
  (cd "$repo_root" && docker build "${args[@]}" .) || fail "the factory image did not build (behind a proxy: BUILD_PROXY=1 BUILD_NETWORK=host EXTRA_CA=...; without apt: RUNTIME_IMAGE=...)"
fi
if want sandbox; then
  echo "== $SANDBOX (the sandbox base: nothing is fetched, the pinned node base must be local or pullable)"
  docker build -q -t "$SANDBOX" ../sandbox >/dev/null || fail "the sandbox image did not build"
fi
if want agent; then
  echo "== $AGENT (the W image: the coding runner and the agent harness)"
  docker image inspect "$SANDBOX" >/dev/null 2>&1 || fail "the W image builds on $SANDBOX, which does not exist"
  SANDBOX_IMAGE="$SANDBOX" SANDBOX_AGENT_IMAGE="$AGENT" bash ../sandbox/build-agent.sh || fail "the W image did not build (npm ci first?)"
fi
if want onboarding; then
  echo "== $ONBOARDING (the onboarding probe: pinned bases and wheels, each checked by sha256)"
  bash ../sandbox/onboarding/build.sh --tag "$ONBOARDING" >/dev/null || fail "the onboarding probe image did not build"
fi

echo "== images ($TAG)"
for i in "$FACTORY" "$SANDBOX" "$AGENT" "$ONBOARDING"; do
  printf '  %-40s %s\n' "$i" "$(docker image inspect "$i" --format '{{.Id}}' 2>/dev/null || echo 'missing')"
done
