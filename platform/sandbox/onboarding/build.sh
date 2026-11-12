#!/usr/bin/env bash
# Builds the onboarding probe image (PLAN M16; DEC-17 refined): aisdlc/sandbox-onboarding:local.
#
#   platform/sandbox/onboarding/build.sh [--tag TAG]
#
# 1. Reads pins.json: the two base images by digest and every wheel with its URL and sha256.
# 2. Fetches each wheel into a cache on the HOST (AISDLC_ONBOARDING_CACHE, default ~/.cache/aisdlc-onboarding) and
#    checks its sha256; a wheel already cached is checked again. A mismatch stops the build (the file is removed).
# 3. Assembles a context (Dockerfile, pins.json, pins.sha256, requirements.txt with hashes, the wheels, the two
#    wrappers) and builds it; the Dockerfile checks the wheels again and installs them in pip's hash-checking mode.
# 4. Prints the image digest (`sha256:<64 hex>`): the value `onboarding.sandbox_image.image` names, with
#    `lock_sha256` the sha256 of pins.json (also the image's `aisdlc.onboarding.lock.sha256` label).
# The base images must be pullable or already local; nothing in the Dockerfile reaches the network.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
TAG=aisdlc/sandbox-onboarding:local
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
cache=${AISDLC_ONBOARDING_CACHE:-$HOME/.cache/aisdlc-onboarding}
mkdir -p "$cache"
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
mkdir "$ctx/wheels"

# the lock, as lines: file sha256 url (node is the one JSON reader the host is sure to have)
node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (p.schema !== "aisdlc-onboarding-pins/1") throw new Error("pins.json: unknown schema");
  for (const w of p.wheels) {
    if (!/^[0-9a-f]{64}$/.test(w.sha256) || !/^https:\/\/files\.pythonhosted\.org\//.test(w.url) || !/^[A-Za-z0-9_.+-]+\.whl$/.test(w.file))
      throw new Error(`pins.json: bad entry ${w.file}`);
    console.log(`${w.file} ${w.sha256} ${w.url}`);
  }' "$here/pins.json" > "$ctx/lines"

: > "$ctx/pins.sha256"
while read -r file sha url; do
  if [ ! -f "$cache/$file" ] || ! echo "$sha  $cache/$file" | sha256sum --strict -c --quiet - >/dev/null 2>&1; then
    rm -f "$cache/$file"
    curl -fsSL --retry 3 -o "$cache/$file.part" "$url"
    mv "$cache/$file.part" "$cache/$file"
  fi
  if ! echo "$sha  $cache/$file" | sha256sum --strict -c --quiet -; then
    rm -f "$cache/$file"
    echo "build.sh: $file does not match its pinned sha256" >&2
    exit 1
  fi
  cp "$cache/$file" "$ctx/wheels/$file"
  echo "$sha  $file" >> "$ctx/pins.sha256"
done < "$ctx/lines"

# requirements with every pinned hash of a name (one per platform where a wheel is platform-specific)
node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const by = new Map();
  for (const w of p.wheels) {
    const k = `${w.name}==${w.version}`;
    by.set(k, [...(by.get(k) ?? []), w.sha256]);
  }
  for (const [k, h] of [...by].sort()) console.log(`${k} ${h.map((x) => `--hash=sha256:${x}`).join(" ")}`);
' "$here/pins.json" > "$ctx/requirements.txt"

cp "$here/Dockerfile" "$here/pins.json" "$here/aisdlc-probe" "$ctx/"
cp "$here/../aisdlc-run" "$ctx/aisdlc-run"
lock=$(sha256sum "$here/pins.json" | cut -d' ' -f1)
py=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).images.python.ref)' "$here/pins.json")
nd=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).images.node.ref)' "$here/pins.json")
# quiet unless it fails: then the build's own output says why
if ! out=$(docker build --progress=plain --build-arg "PYTHON_IMAGE=$py" --build-arg "NODE_IMAGE=$nd" \
  --build-arg "LOCK_SHA256=$lock" -t "$TAG" "$ctx" 2>&1); then
  printf '%s\n' "$out" | tail -40 >&2
  exit 1
fi
id=$(docker image inspect "$TAG" --format '{{.Id}}')
echo "built $TAG" >&2
echo "  onboarding.sandbox_image = {\"image\": \"$id\", \"lock_sha256\": \"$lock\"}" >&2
echo "$id"
