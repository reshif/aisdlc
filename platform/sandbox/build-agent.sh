#!/usr/bin/env bash
# Builds the W image: aisdlc/sandbox-agent:local = the sandbox base image + the coding runner + the agent binary.
#   platform/sandbox/build-agent.sh [--no-bundle]     (--no-bundle: use the runner bundle already built)
# Needs the repo's node_modules (the agent harness's native binary comes from the pinned SDK package) and Docker.
# The image carries the runner's sha256 as a label; `--check` exits 0 when the local image is current.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE=${SANDBOX_IMAGE:-aisdlc/sandbox:local}
TAG=${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local}
arch=$(uname -m)
case "$arch" in x86_64) pkg=linux-x64 ;; aarch64 | arm64) pkg=linux-arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac
bin="node_modules/@anthropic-ai/claude-agent-sdk-$pkg/claude"
[ -x "$bin" ] || { echo "build-agent: $bin is missing (npm ci first)" >&2; exit 1; }
if [ "${1:-}" != --no-bundle ] && [ "${1:-}" != --check ]; then (cd services/coding-runner && npm run build >/dev/null); fi
runner=services/coding-runner/dist/runner.js
[ -f "$runner" ] || { echo "build-agent: $runner is missing" >&2; exit 1; }
sha=$(sha256sum "$runner" | cut -d' ' -f1)
if [ "${1:-}" = --check ]; then
  [ "$(docker image inspect "$TAG" --format '{{index .Config.Labels "aisdlc.runner.sha256"}}' 2>/dev/null || true)" = "$sha" ]
  exit
fi
docker image inspect "$BASE" >/dev/null 2>&1 || docker build -q -t "$BASE" platform/sandbox >/dev/null
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
cp "$runner" "$ctx/runner.js"
cp "$bin" "$ctx/claude"
docker build -q -f platform/sandbox/Dockerfile.agent --build-arg "BASE=$BASE" --build-arg "RUNNER_SHA=$sha" -t "$TAG" "$ctx" >/dev/null
echo "built $TAG (runner $sha)"
