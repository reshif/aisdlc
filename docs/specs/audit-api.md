# audit: signed exports, legal hold, erasure and retention (M19)

The audit service (`services/audit`; ADR-0003 §1 Trust plane, "audit: signed exports to write-once storage, pseudonyms, erasure, retention, legal hold, permission history") is where an auditor gets evidence they can check without trusting the factory, and where the factory removes what it may and must not keep. ADR-0003 names **one** service (its milestone table: "audit (one service)"), and the build follows the ADR: PLAN M19's two names after RV §1.3, `audit-exporter` (export signing, write-once store) and `audit-backend` (erasure, retention, legal hold), are the two halves of `services/audit` (`exporter.ts`, `govern.ts`). Its vocabulary is `packages/contracts/src/entities/audit.ts`, the source of truth for every shape below.

## 1. Signed exports

An export is the ledger and the record of one **scope** (`{kind: 'project', project_id}` or `{kind: 'fleet'}`) over a half-open **range** `[from, to)` of at most 366 days, as one self-contained, signed package (`aisdlc-audit-export/1`, `AuditExportPackage`):

| Part | What | Why |
|---|---|---|
| `ledger.checkpoint` | the newest checkpoint at export time, with its Notary and Witness signatures | the anchor: an export is never made without one (`409 not_checkpointed`) |
| `ledger.entry_hashes` | the `entry_hash` of every entry 1..`checkpoint.to_ledger_seq`, in order | the checkpoint's Merkle root is recomputed from them offline, and every exported entry is placed in the chain |
| `ledger.entries` | the scope's entries in the range, up to the checkpoint, **in full** (each with its Notary signature) | the decisions themselves |
| `ledger.uncovered` | how many of the scope's entries in the range are after the checkpoint | they are not exported (not yet anchored); the next export after the next checkpoint has them |
| `record.events` | the scope's record events in the range, in global order, each with its stream, seq, `prev_hash` and `hash` | the facts; each hash is recomputed offline, and consecutive events of a stream must link |

**Which entries and events belong to a project.** The project's streams are those with an event whose body names it (`project_id`): its S0 records, items, gates, cards, threads. Every event of those streams in the range is exported, and every ledger entry in the range whose body names the project or whose subject or gate instance is one of those streams' subjects. The fleet is everything. Payloads kept off the hash chain (a conversation's text) are never in an export: the record carries only their hashes.

**Signing.** The export id is the sha256 of the package's canonical JSON (RFC 8785). The Notary signs a domain-separated message over it (`auditExportSigningMessage`: `{purpose: 'aisdlc.audit-export.sign/1', export_sha256}`), never the bare id, so an export signature can never be taken for a ledger entry, a checkpoint or an Evidence Pack signature. It is the Notary's third purpose (scope `audit_export`; journalled append-only in `notary.audit_export_signature`; the same id asked again gets its first signature, the same id with another scope is refused). The audit service holds **no key**.

**Store and record.** The signed export (`aisdlc-signed-audit-export/1`: the package, its id, the signature) is checked offline with the Notary's and the Witness's public keys **before** it is stored (nothing that does not verify is stored or recorded), written to the write-once bucket `audit-exports` under the sha256 of its bytes (S3 Object Lock and a legal hold on every object in a real store; delete is refused by the adapter and by the store), then recorded: `audit.export_written` on `audit-export:<id>` and the `audit.export` ledger entry (body: the export's facts, `project_id` at the top so the project's ledger view lists it; `subject_hash` the export id; `actor` the requester), in one transaction, the entry last.

**Offline check.** `aisdlc verify-export --file <signed.json> --notary-key <jwk> --witness-key <jwk> [--object-key <sha256>]` (`packages/ledger`, the same CLI as `verify-ledger`; `checkSignedAuditExport` in contracts): canonical bytes and the object key; the package's shape and its id; the Notary's export signature; both checkpoint signatures, the Merkle root over `entry_hashes`, the head hash; each entry's hash, Notary signature, place in the chain and link to the entry before it, ledger order, the range; each event's hash, its link to the event before it when that one is exported (the first of a stream links to the genesis hash), global and stream order, the range. Exit 0: verified; 1: the first failure (`export_hash_mismatch`, `entry_signature`, `checkpoint_root`, `event_hash`, ...); 2: bad usage. It trusts nothing but the two public keys.

Limits: 20,000 entries and 20,000 events per export (`413 too_large`: narrow the range). `entry_hashes` grows with the ledger (66 bytes per entry, under the store's 64 MiB per object to about 900,000 entries); a later format can carry Merkle inclusion proofs instead.

## 2. Legal hold

A hold freezes the erasable payloads of a **scope**: a person (`{kind: 'principal', principal_id}`), a project, or the fleet, under a **matter reference** (`LA-112`). It is placed by a factory admin (`audit.legal_hold_placed`, ledger `legal_hold.place`) and released by **another** one (`audit.legal_hold_released`, ledger `legal_hold.release`; the placer is refused `403`): loosening always needs a second person. While a hold is active, no payload it covers is erased, by a request or by retention. A payload is covered when the hold is the fleet's, its project's, or its owner's.

## 3. Erasure

Erasure removes **only payloads kept off the hash chain**: today the conversation payloads (`core.conversation_payload`, the text of an assistant thread's title and turns), which the record names by id and sha256. Their text goes, their hash stays (`conversation.payload_erased` on the thread), so the record and the ledger still verify. **A record event or a ledger entry is never erased**, by anyone: nothing in the audit service can (its role has no UPDATE or DELETE on either, the tables reject both for every role, and the ledger has row-level security on insert).

| Step | Who | Recorded on `audit-erasure:<id>` | Ledger |
|---|---|---|---|
| request `{subject: {principal_id, project_id or null}, reason}` | a factory admin | `audit.erasure_requested`: the payloads found then through core, by id, thread, owner, project and hash (never their text); at most 500 | none |
| reject `{reason}` | another factory admin | `audit.erasure_rejected` | none |
| approve, the legal approval `{matter_ref, reason}` | **another** factory admin (the requester is refused) | `audit.erasure_approved` | `erasure.execute` (body: the targets by id and hash, the subject, requester, approver, matter; `subject_hash` the hash of the targets), written in the same transaction, **before** anything is erased |
| a hold covers a payload at approval | | `audit.erasure_blocked` (`at_stage: approval`, the holds); state `blocked`; nothing erased, no entry | none |
| erase, payload by payload | the service | `audit.payload_erased` (each, idempotent); a hold placed after the approval stops it before the next payload (`audit.erasure_blocked`, `at_stage: execution`) | |
| done | | `audit.erasure_executed` | |

A blocked erasure may be approved again once the hold is released (a new `erasure.execute` entry). An approved erasure whose payloads core could not erase (core down) stays `approved` and the `audit_erasure` loop finishes it. Holds and approvals take one lock, so an approval never misses a hold placed at the same moment. Core erases a payload only when its id **and hash** are the ones named (`409 mismatch` otherwise) and only on the thread that names it.

**Pseudonyms.** The ledger and the record name people by their principal id (the pseudonymous `oid`); the audit service never resolves one to a person (not built: DM's "pseudonym resolution needs a legal approval and is itself logged" waits for the IdP's resolution API).

## 4. Retention

Retention classes are configuration: `audit.retention` (factory layer, M1-gated like every revision; `registerAuditConfig`, registered by core too so its revisions validate it):

```json
{ "classes": { "conversation_payload": { "days": 365 } } }
```

`days: null` (the **default**) keeps every payload until an erasure request: retention erases nothing until a factory revision sets a class. Only payloads off the hash chain have a class: the record, the ledger and the signed exports are kept for ever (exports are under Object Lock). The `audit_retention` loop (hourly) erases the live payloads older than `days`, minus what a hold covers and what an open erasure already names, as ONE erasure of basis `retention` requested and approved by the published class in one transaction with its `erasure.execute` entry (`actor: null`, `approved_by: config:<rev_hash>`), recorded with `audit.retention_swept` (due, held). An unreadable setting falls back to the default (erase nothing).

## 5. API

Every route needs a service token; the bff is the only caller and every request names the signed-in person (`on_behalf_of`, a query parameter for reads and a body field for writes). The PDP is embedded here too and decides about that person (the identity read model is read, never folded: while it is behind the record the PDP denies).

| Route | Scope | PDP | Answer |
|---|---|---|---|
| `GET /v1/exports?on_behalf_of=&project=` | read | `audit.read` on the project, or the fleet without `project` | `AuditExportList` |
| `POST /v1/exports` `{on_behalf_of, scope, from, to, reason}` | export | `audit.read` on the scope | `201 AuditExportView` |
| `GET /v1/exports/:id?on_behalf_of=` | read | `audit.read` on its scope | `AuditExportView` |
| `GET /v1/exports/:id/signed?on_behalf_of=` | read | `audit.read` on its scope | `{object_key, bytes_b64}`: the exact stored bytes, re-hashed to their key |
| `GET /v1/holds?on_behalf_of=` | read | `audit.read`, fleet | `LegalHoldList` |
| `POST /v1/holds` `{on_behalf_of, scope, matter_ref, reason}` | govern | `config.decide`, fleet | `201 LegalHoldView` |
| `POST /v1/holds/:id/release` `{on_behalf_of, reason}` | govern | `config.decide`, fleet | `LegalHoldView`; `403` for the placer, `409` not active |
| `GET /v1/erasures`, `GET /v1/erasures/:id` `?on_behalf_of=` | read | `audit.read`, fleet | `ErasureList`, `ErasureView` |
| `POST /v1/erasures` `{on_behalf_of, subject, reason}` | govern | `config.decide`, fleet | `201 ErasureView`; `404` nothing to erase, `413` over 500 |
| `POST /v1/erasures/:id/approve` `{on_behalf_of, matter_ref, reason}` | govern | `config.decide`, fleet | `ErasureView`; `403` the requester, `409 legal_hold`, `409` decided |
| `POST /v1/erasures/:id/reject` `{on_behalf_of, reason}` | govern | `config.decide`, fleet | `ErasureView` |
| `GET /v1/retention?on_behalf_of=` | read | `audit.read`, fleet | `RetentionView`: the classes in force, their revision, the last sweeps |
| `GET /healthz`, `GET /metrics` | none | | the loops' health (503 while one is unhealthy) |

Errors: `{error: {code, message}}`; `invalid_input` 400, `forbidden` 403, `not_found` 404, `conflict`/`legal_hold`/`not_checkpointed` 409, `too_large` 413, `unavailable` 503 (the Notary, core, the store or the database).

**PDP actions.** `audit.read` is the catalogue's. Erasure and legal hold need the proposed `identity.admin` (portal-coverage §5 item 6), which is **not** in `ACTION_CATALOGUE`; adding it is an M3 catalogue change for the user. Until then they are decided under `config.decide` on the fleet (`AUDIT_ACTION.govern`): the nearest existing action, factory admins only, a `decide` action whose allows are logged. The two-person rules are the service's own.

The bff serves the same under `/api/audit/*` (`services/bff/src/audit.ts`: the person is the session's, the PDP decides there first, the signed bytes are re-hashed before they are sent) and the portal's Govern › Audit page (`services/web/src/pages/AuditPanels.tsx`) shows them.

## 6. Record, role, deployment

| Event (`audit-` streams; never `audit:`, which are core's 9.5 sample streams) | Read model |
|---|---|
| `audit.export_written` | `audit.export` |
| `audit.legal_hold_placed`, `audit.legal_hold_released` | `audit.legal_hold` |
| `audit.erasure_requested`, `_rejected`, `_blocked`, `_approved`, `audit.payload_erased`, `audit.erasure_executed` | `audit.erasure`, `audit.erasure_target` |
| `audit.retention_swept` | `audit.retention_sweep` |

The read models are folded in the event's transaction and rebuilt from the record alone (`rebuildAudit`); they name their ledger entries by entry id and the views resolve the sequence numbers from the ledger.

Its database role `aisdlc_audit` (login role `audit`): SELECT, INSERT, UPDATE on its read models; SELECT on every record stream (an export reads them) and INSERT on `audit-%` streams only (row-level security); SELECT on the ledger and INSERT of its four entry types only (the migration enables row-level security on `ledger.ledger_entry`: the owner bypasses it, `aisdlc_app` keeps every type, every SELECT grant still reads every entry); SELECT on the checkpoints, the projection checkpoints, the config view and identity's read model. No core table, no DDL, no DELETE.

Configuration: `AUDIT_DATABASE_URL`, `AUDIT_CALLERS`, `AUDIT_NOTARY_URL` and `AUDIT_NOTARY_TOKEN_REF` (scopes ledger, read, audit_export), `KMS_URL` and `KMS_TOKEN_REF` (public-key reads of `dev:notary`, `dev:witness`; or `AUDIT_NOTARY_KEY_REF`, `AUDIT_WITNESS_KEY_REF` pinned), `AUDIT_CORE_URL` and `AUDIT_CORE_TOKEN_REF` (core scope `erasure`), `AUDIT_OBJECT_STORE_*`, `AUDIT_ERASURE_INTERVAL_MS` (30 s), `AUDIT_RETENTION_INTERVAL_MS` (1 h), `AUDIT_HOST`, `AUDIT_PORT` (8480). Compose: profile `audit` (`platform/compose/README.md`).

## 7. Not built yet

Pseudonym resolution; permission history (`PermissionHistory`, who held which role when) and the audit service's own signed log (DM `sign_log_record`): every audit act is already a ledger entry; step-up on erasure and hold; `identity.admin` in the catalogue; Merkle inclusion proofs instead of the full hash list; exports of the identity journal and the Notary's own journals.
