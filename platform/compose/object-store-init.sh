#!/usr/bin/env bash
# The one-shot `object-store-init` job (portal v2, docs/specs/deletion.md §1, §5): the deletion's own credential on the
# object store. Idempotent: run on every `up`, it (re)writes the policy and the user from the secret files, so a
# rotated secret takes effect.
#
#   policy aisdlc-deletion-purge   on the two write-once buckets (`evidence-packs`, `audit-exports`) only: list an
#                                  object's versions, lift a version's legal hold, delete the version (exactly what
#                                  `S3ObjectStore.purge` sends; MinIO asks DeleteObject beside DeleteObjectVersion; core
#                                  knows the buckets without asking, `knownBuckets`).
#                                  Not GetObject, PutObject, CreateBucket or any bucket setting: the deletion removes
#                                  what it was told to and reads, writes or reconfigures nothing
#   user aisdlc-core-purge         its access key and secret are secrets/object-store-purge-{access,secret}-key, which
#                                  only core mounts (CORE_PURGE_OBJECT_STORE_*); the policy is its only one
#
# The store's root credential is used here to make them (MinIO's `mc admin`, which ships in the store's image) and the
# job has no other network than the store's. MinIO keeps users and policies in its own volume (`objectstore-data`),
# so a backup and a restore carry them; this job puts them back regardless.
set -euo pipefail
export MC_CONFIG_DIR=/tmp/mc
root_ak="$(cat /run/secrets/object-store-access-key)"
root_sk="$(cat /run/secrets/object-store-secret-key)"
purge_ak="$(cat /run/secrets/object-store-purge-access-key)"
purge_sk="$(cat /run/secrets/object-store-purge-secret-key)"
url="${OBJECT_STORE_URL:-http://object-store:9000}"

# the root credential reaches mc in this job's own environment (MC_HOST_<alias>), never in an argument list or a file
MC_HOST_store="${url%%://*}://${root_ak}:${root_sk}@${url#*://}"
export MC_HOST_store

policy=/tmp/aisdlc-deletion-purge.json
cat >"$policy" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::evidence-packs", "arn:aws:s3:::audit-exports"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObjectLegalHold", "s3:DeleteObject", "s3:DeleteObjectVersion"],
      "Resource": ["arn:aws:s3:::evidence-packs/*", "arn:aws:s3:::audit-exports/*"]
    }
  ]
}
JSON

mc --quiet admin policy create store aisdlc-deletion-purge "$policy" >/dev/null
mc --quiet admin user add store "$purge_ak" "$purge_sk" >/dev/null
# attach answers an error when the policy is attached already: read what the user has first (the image has no grep)
attached() { [[ "$(mc --quiet --json admin user info store "$purge_ak")" == *'"aisdlc-deletion-purge"'* ]]; }
attached || mc --quiet admin policy attach store aisdlc-deletion-purge --user "$purge_ak" >/dev/null
attached || { echo "object-store-init: the policy is not attached to $purge_ak" >&2; exit 1; }
echo "object-store-init: user $purge_ak holds aisdlc-deletion-purge (legal hold and version delete on evidence-packs, audit-exports)"
