#!/bin/sh
# The one-shot `volume-init` job: gives every named volume a factory service writes to the uid the stack runs as
# (AISDLC_UID:AISDLC_GID, from .env: your own uid, or 10001 when init-secrets ran as root).
#
# Why: a fresh named volume takes the ownership of the image directory at its mount point (/kms and /work are
# 10001 in the factory image, /data is root in MinIO's), so a stack started by any other uid could not write
# its own state (kms-local: EACCES on /kms/dev_notary.key.json). A restored backup keeps the numeric owners of
# the stack it was taken from, which is the same problem.
#
# What: each volume under /v is chowned to the uid, recursively (only entries not already owned by it), and its
# top directory is made 0700. File modes are never touched, so a key file stays 0600 and nothing becomes
# readable by group or others. Runs as root with CHOWN, FOWNER and DAC_READ_SEARCH only, no network, a
# read-only root; idempotent.
set -eu
uid="${AISDLC_UID:?AISDLC_UID is not set: run ./init-secrets first}"
gid="${AISDLC_GID:?AISDLC_GID is not set: run ./init-secrets first}"
case "$uid" in '' | *[!0-9]*) echo "volume-init: AISDLC_UID '$uid' is not a number" >&2; exit 1 ;; esac
case "$gid" in '' | *[!0-9]*) echo "volume-init: AISDLC_GID '$gid' is not a number" >&2; exit 1 ;; esac
# the services never run as root: refuse to hand them a volume as root
if [ "$uid" = 0 ] || [ "$gid" = 0 ]; then echo "volume-init: refusing uid/gid 0 (run ./init-secrets)" >&2; exit 1; fi

n=0
for d in /v/*; do
  [ -d "$d" ] || continue
  find "$d" -xdev \( ! -user "$uid" -o ! -group "$gid" \) -exec chown -h "$uid:$gid" {} +
  chmod 0700 "$d"
  n=$((n + 1))
done
echo "volume-init: $n volume(s) owned by $uid:$gid, mode 0700"
