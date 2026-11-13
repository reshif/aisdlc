# Deletion and the factory admin's override

Status: design for portal v2 (owner decisions of 2026-11-13, `docs/design/portal-v2-intent.md`: **delete means delete**,
**nothing applies to the factory admin**). Screen map gaps G2, G3, G6; new APIs N2, N19, N26. The vocabulary is
`packages/contracts/src/entities/deletion.ts` and `packages/contracts/src/entities/admin-override.ts`.

## 1. What "deleted" means

Deleting an object removes every piece of its data and content from the factory: record events, read models, settings,
documents, transcripts, packs in the object store, onboarding records. Afterwards the object answers `404` everywhere
and cannot be restored from the factory. What stays is what the chains need to keep verifying, and nothing of the
object can be read from it:

| Store | What happens | What stays |
| --- | --- | --- |
| `ledger.ledger_entry` | every entry of the object is **redacted in place**: body `{}`, every gate, subject, decision and actor column `NULL`, `entry_type` `redacted`, `redacted_at` and `redaction_id` set | `ledger_seq`, `entry_id`, `prev_hash`, `entry_hash`, the Notary signature, `created_at` |
| `record.record_event`, a stream that is all the object's | **removed** (every row) | one `record.purged_event` row per removed event: `global_seq`, the deletion's id, nothing else |
| `record.record_event`, a shared stream (an event of the object in a stream of something else) | **redacted in place**: type `redacted`, body `{}`, actor `redacted`, `idempotency_key` `NULL`, `redacted_at` set | `stream`, `seq`, `global_seq`, `event_id`, `prev_hash`, `hash`, `occurred_at` |
| `record.outbox` | rows of the object removed | |
| every read model (all other tables of the record database) | rows of the object **removed** (see §3: matching) | |
| object store (`evidence-packs`, `audit-exports` of the project's scope) | **purged**: legal hold lifted and every version deleted, by the deletion credential only | |
| Notary journal (`notary.journal`, its own database) | the redacted entries' `entry` JSON erased (`POST /v1/journal/redact`) | seq, status, hashes |
| the `deletion.performed` ledger entry | **new**, written last | who, the kind, `sha256` of each deleted id, counts, the redacted ledger seqs, the reason's hash. No name, no content |

Backups taken before a delete still contain the object (§6).

## 2. Why the chains still verify

**Ledger.** `entry_hash` is sha256 of the canonical entry preimage, the Notary signs exactly that digest (ES256 over a
32-byte digest, `ledger-format.ts`), `prev_hash` links entries and checkpoints are Merkle roots over the `entry_hash`
values. None of the three checks needs the preimage once the hash is trusted: the link is `prev_hash == previous
entry_hash`, the signature verifies over the digest alone (`es256VerifyDigest`), and the Merkle root is over hashes.
So a redacted entry is verified **by its stored hash**: link, signature over the stored hash, place in the checkpoint
root. What is lost is exactly what deletion must lose: the proof that the hash is of some content. `verify-ledger`
gains `--allow-redacted` (and `verifyLedger(..., {allowRedacted: true})`): a redacted entry passes when it links, its
signature verifies over its stored `entry_hash`, **and a later `deletion.performed` entry, itself fully verified,
names its seq** (`redacted_ledger_seqs`). A redacted entry that no signed deletion accounts for fails
(`redaction_unaccounted`): marking an entry redacted is not a way to hide an edit. Without the flag, a ledger with any
redacted entry fails (`redacted`), so the old strict check stays available. No hashed field moved, no format changed.

**Record.** Each stream is its own hash chain (`computeEventHash`). A removed stream is gone entirely, so no chain is
broken; `verifyAll`'s global-sequence check accepts a gap exactly when every missing `global_seq` is in
`record.purged_event`. A redacted event in a shared stream keeps `prev_hash` and `hash`, so the stream still links;
its own content check is skipped (`redacted_at` set) and reported as a count.

## 3. What belongs to an object (matching)

A deletion starts from **roots** and collects **needles**: the ids that are the object's.

| Kind | Roots | Expands to |
| --- | --- | --- |
| project | the project id, its repos (`owner/name`), its S0 records | items, gates, cards, units, packs, threads, ... |
| repo | the repo key | as project when it is the project's only repo; otherwise its S0 records, census, knowledge, items |
| item | the item id | its gates, cards, units, packs, threads |
| person | the principal id | bindings, links, memberships, their notification preferences |
| team | the team id | its bindings |
| role binding | the binding id | |

Expansion is a fixpoint over the record: a stream of an **owned stream type** (`item:`, `gate:`, `card:`, `s:`,
`planning:`, `evidence:`, `unit:`, `agent:`, `verify:`, `push:`, `handoff:`, ...) whose events name a needle adds the
stream's id to the needles. Streams of independent things never expand (`principal:`, `team:`, `group:`, `config:`,
`pdp_decision:`, `killswitch:` ...): a binding of a person on the project is the project's, the person is not.

A value **names** a needle when it is the needle, or the needle is a whole segment of it (`acme-web`, `acme-web/L3`,
`project:acme-web`, `acme-web/<item>`): `(^|[:/])needle($|[:/])` over every string of the JSON (`jsonb_path_exists`
with `like_regex`), never a substring, so the slug `web` does not hit `webhook`. Read-model rows are matched the same
way over `to_jsonb(row)`. Every table of the record database is either swept or named in `DELETION_KEPT_TABLES` with
the reason (a test fails on a new table that is neither).

Kept on purpose, flagged for the owner (§7): the factory configuration's history (`config:` factory lineage: a
revision that listed the repo in `sandbox.exec_allowed_repos` is factory settings, not the project's content; a delete
proposes no factory revision), fleet-scope audit exports (they hold every project), the kill switch's own signed
journal (its own database and key, AR9).

**Person.** A person's decisions on other projects' gates are not theirs to take away: deleting the decision would
re-open a gate that was decided. Their ledger entries are redacted to the **actor** only (`actor` becomes
`deleted.<sha256(deletion_id|principal)[0..16]>`, body `{}`), keeping the gate columns, so `foldDecisions` still counts
the approval and the gate stays decided; they show as "Deleted person".

## 4. The privileged purge path

`record_event`, `outbox` and `ledger_entry` are append-only by grant **and** trigger. Deletion gets its own group role,
`aisdlc_purge` (migrations `record/0005_purge.sql`, `ledger/0002_redaction.sql`):

- `aisdlc_purge` is a member of `aisdlc_app` (SELECT, INSERT) and holds DELETE on `record_event`, `outbox`, every
  read model, and UPDATE on `ledger_entry` and `record_event`. Default privileges give it SELECT, DELETE on every table
  a later migration creates.
- the mutation triggers let a change through only when `current_user` is a member of `aisdlc_purge` **and** the change
  is purge-shaped: a ledger UPDATE only to the redacted shape (hashes, seq, signature and `created_at` unchanged), never
  a ledger DELETE, never a checkpoint change, a record UPDATE only to the redacted shape.
- the purge transaction runs `SET LOCAL ROLE aisdlc_purge`. Core's normal login is **not** a member; the deletion login
  (`CORE_PURGE_DATABASE_URL`) is. Without it core answers `503 deletion_unavailable`.

## 5. The deletion

`DELETE /v1/<kind>/:id` (`projects`, `repos`, `items`, `people`, `teams`, `bindings`), body `{on_behalf_of, reason,
confirm}` (`confirm` is the object's id typed back). `POST /v1/deletions/preview` `{kind, id}` answers what would go
(counts) and what blocks it, writing nothing. PDP: `<kind>.delete` (`project.delete`, `item.delete`, `repo.delete`,
`person.delete`, `team.delete`, `binding.delete`): the factory admin always; a project admin for the project's repos and
items. One transaction, in the lock order:

1. ledger lock (`lockLedger`, import stranded entries), then `SET LOCAL ROLE aisdlc_purge`;
2. refuse when a legal hold covers it (`audit.legal_hold`: the fleet's, the project's, the person's): `409 legal_hold`;
3. collect needles (§3);
4. object store keys of the object's packs and project exports (read before the rows go);
5. redact ledger entries, remove and redact record events, sweep the read models;
6. write `deletion.performed` (record event on `deletion:<id>` and the ledger entry, last).

After COMMIT: purge the objects (idempotent; an object that cannot be purged now is retried by `deletion_purge`
from the `deletion.performed` facts: the key list is in the record event, not the ledger), confirm the Notary entry,
ask the Notary to erase its journal's copies. The bff serves the same routes under `/api/`.

## 6. Backups and the restore drill

A backup is a copy taken at a moment. One taken before a delete **contains the object**; the factory cannot reach into
it. The restore drill stays coherent: a backup restores a factory at the moment it was taken, including objects
deleted later. Restoring such a backup **un-deletes**: after a restore, re-apply every `deletion.performed` entry newer
than the backup (their roots are hashed, so the runbook keeps the deletion requests' ids in `manifest.json`-adjacent
`deletions.log`, plain ids, outside the factory: §7). Backups must be expired on a schedule the owner sets.

## 7. Owner decisions needed

1. Backups: retention period, and whether a restore must replay deletions automatically (needs the plain ids kept
   outside the factory, which is itself a copy of personal data).
2. Fleet-scope audit exports that contain a deleted project: kept (other projects' evidence) or purged.
3. Factory configuration history that names a deleted repo: kept as factory settings, or redacted (breaks the M1
   binding of those revisions).
4. The kill switch's journal (own database, signed by its own key): kept.

## 8. The factory admin's override

`factory.admin` may do every action on every resource. The generated Cedar bundle has one more hand-written policy,
`xcut/factory_admin_override`: `permit (principal in Role::"factory.admin", action, resource);` (still subject to
`xcut/disabled_principal_denied`). An allow whose only permitting policy is that one is an **override**
(`isAdminOverride`): it is always logged (`logged_because: 'override'`), and the caller must give a reason.

Every override is recorded: an `admin.override` record event on `admin_override:<id>` (`{actor, action, resource,
gate, reason, bypassed}`), and a ledger entry. For a gate decision the decision entry itself carries `body.override`
(`{reason, bypassed}`) and the event; `foldDecisions` treats an approve with `body.override` as deciding the gate. For
anything else an `admin.override` ledger entry. The rules it can bypass are `AdminOverrideRule`: `slot`, `own_request`,
`two_person`, `quorum_infeasible`, `policy_changed`, `already_voted`, `step_up`, `bootstrap`, `m1_second_approver`,
`kill_two_person`, `pdp_grant`. Not bypassed (physical, not rules): the factory never merges; a gate past its expiry or
no longer pending; maintenance mode MM-2; the nonce and the evidence-viewed step (they bind the decision to what was
shown); a disabled principal.
