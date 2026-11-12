# Runbook: backup and restore of the local-prod stack (RC-OPS-1)

The record is the source of truth and the ledger is append-only and signed: a lost or inconsistent restore is not
recoverable later. This runbook is how the local-prod compose stack (`platform/compose`) is backed up, restored onto a
fresh host, and proven restored. The drill that proves it runs nightly (`.github/workflows/restore-drill.yml`) and on
demand (`npm run drill:restore`).

## 1. What is backed up

| Part | Where it lives | How | Why it matters |
|---|---|---|---|
| Roles and memberships | the Postgres cluster | `pg_dumpall --globals-only --no-role-passwords` | every service's least-privilege login role (`gateway`, `sandbox_controller`, `verify`, `gate_check`, `gate_relay`, `notifier`, `audit`) and the group roles the migrations grant to (`aisdlc_app`, `aisdlc_gateway`, ...). Passwords are not in the dump: they are the secret files, and db-init re-applies them on every up |
| Database `aisdlc` | Postgres | `pg_dump -Fc` | the record (`record_event`, outbox, projections), the ledger and its checkpoints, decisions, config, identity, directory, core, bff, knowledge, and the gateway's, sandbox-controller's, verify's, gate-check's, gate-relay's, notifier's and audit's own schemas |
| Databases `notary`, `witness`, `killswitch` | Postgres | `pg_dump -Fc` each | the Notary's journal and chain head, the Witness's co-signed checkpoints, the kill switch's signed journal, kills, approvals, delegations and holders |
| Any other database of the cluster | Postgres | `pg_dump -Fc` | taken too, so a database added later is not silently left out |
| Object store | volume `objectstore-data` (MinIO) | tar of the volume while the store is paused | the write-once `evidence-packs` bucket (signed Evidence Packs and D2 Handoff Packs, under object lock) and every other bucket |
| Key custody | volume `kms-state` | tar of the volume | the Notary's, Witness's, kill switch's, step-up and fingerprint keys (`dev:` keys locally; KMS in production) |
| Secrets and settings | `platform/compose/secrets/`, `.env` | tar and copy | service tokens, database passwords, the GitHub App key, the object store's credentials, the uid and App settings |

Not backed up: `codehost-work` and `knowledge-work` (clones and indexes rebuilt from GitHub at the next census), the
sandbox scratch directory, logs and telemetry.

**The backup is a secret.** It holds every key and password of the factory. `backup.sh` never prints a secret, but
the directory is one: it is written mode 0700, and must be encrypted at rest before it leaves the host (`age -r`,
`gpg --encrypt`, a bucket with server-side encryption and its own access policy) and held as tightly as the keys.

## 2. Take a backup

```
cd platform/compose
COMPOSE_PROJECT_NAME=<the stack's project> ./backup.sh /secure/backups/$(date -u +%Y%m%dT%H%M%SZ)
```

The stack may stay up (an online backup). The order makes it restorable: the record database first, then the
Notary's, the Witness's and the kill switch's (their heads can only be ahead of what the record names, and the
reconciler and the kill observer catch the record up after a restore), then the object store (every pack the record
names is already stored: write-once, never deleted). `manifest.json` names the commit, the databases and the record,
ledger and checkpoint heads the backup covers; `SHA256SUMS` covers every file.

## 3. Restore onto a fresh host

1. Check out the commit in `manifest.json` and build the image (`docker compose build`, or the `docker build` of the
   compose README behind a proxy). Set `AISDLC_IMAGE` if it is not `aisdlc/factory:local`.
2. Make sure the project has no Postgres volume (`docker compose down -v` on a reused host) and `secrets/` is absent.
3. Decrypt the backup to a local directory and run:

   ```
   cd platform/compose
   COMPOSE_PROJECT_NAME=<project> ./restore.sh /path/to/backup
   docker compose --profile <the profiles you run> up -d --wait
   ```

   `restore.sh` checks every checksum first (a damaged backup is refused before anything is touched), puts back
   `secrets/` and `.env`, the object store's and key custody's volumes, then starts an empty Postgres with the restored
   superuser password, restores the roles and every database (`pg_restore --exit-on-error`), and has db-init re-apply
   the role passwords. `migrate` then finds every migration applied.
4. Prove it (§4) before anyone uses the factory.

## 4. Prove the restore (what the drill checks)

| Check | How | A failure means |
|---|---|---|
| Every table of every database equals the backup | row count and hash of every table of `aisdlc`, `notary`, `witness`, `killswitch` | the dump or the restore lost or changed rows: do not start the stack |
| Every read model is the same, and rebuilt from the record alone it is the same again | `aisdlc-rebuild-check` (core's bundle): the projections (stream counts, config, identity, directory, gate instances, the inbox, core, work items, agent runs, the floor, session activity, eval runs, conversations) and the per-item Unit, Lease, AdmissionGrant and Evidence Pack rows, as counts and hashes; `--rebuild` drops each and refolds it | a read model that is not a function of the record, or a record that did not come back whole |
| The Notary's journal agrees with the ledger | `notary.state.last_seq` is the ledger head; the committed journal's entry hashes are the ledger's | the Notary and the record were restored from different moments: the next signature would fork the chain. Stop; restore both from the same backup |
| The Witness's newest checkpoint is the ledger's | `witness.cosigned` against `ledger.checkpoint` | as above, for the Witness |
| The ledger verifies offline | `verify-ledger.sh`: every entry's Notary signature and hash chain, every checkpoint's Notary and Witness signatures, with the public keys from key custody | a damaged ledger or the wrong keys (`kms-state`) |
| The kill switch state survived | a kill that was engaged still refuses admission for its project (423); a released one stays released | the kill switch database or its key did not come back |
| Every evidence pack still verifies offline | `aisdlc-export-packs` reads every pack `core.evidence_pack` names back from the object store; `aisdlc-verify-pack` checks each (canonical bytes, object key, pack hash, the Notary's signature, the head and item) | the object store volume did not come back, or a pack was changed |
| The restored factory keeps working | a kill is released by two people: new ledger entries signed by the restored Notary and a new checkpoint co-signed by the restored Witness, and `verify-ledger.sh` passes again | the restored signers cannot continue the chain |

`npm run drill:restore` (`platform/compose/drill-restore.sh`) does all of it end to end: a stack with data (the
browser e2e when Playwright resolves, `DRILL_DATA=e2e`; else an onboarding through core, `DRILL_DATA=seed`), a kill
kept engaged and a kill released, quiesce, backup, `down -v` and the secrets moved away, restore, every check above,
then `down -v`. Its own project (`aisdlc-drill`) and subnets (`10.237`); `DRILL_SKIP_BUILD=1` with `AISDLC_IMAGE` uses
an image as it is; `DRILL_KEEP=1` leaves the restored stack up; `DRILL_BACKUP_DIR` keeps the backup.

## 5. RPO and RTO

- **RPO**: the moment `backup.sh` reads the record. Whatever is recorded after it is lost on a restore, so the
  backup interval is the RPO. Local prod states no schedule: an operator who runs it nightly has an RPO of 24 hours.
  The cloud target replaces this with continuous archiving (point-in-time recovery) of each database and a
  versioned, object-locked bucket (RPO minutes).
- **RTO**: what the drill measures from `restore.sh` to a healthy stack on the same host with the image present
  (minutes; the drill prints it). A fresh host adds the image build and the copy of the backup.

## 6. When a check fails

Do not open the portal to users and do not let core-worker run work on a restore that failed a check: a forked ledger
or a lost kill cannot be repaired by the factory itself. Restore again from the same backup; if the same check fails,
take the next older backup, and record the gap (what was decided after it) for the people who must decide it again.
