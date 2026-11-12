import {
  AUDIT_BUCKET,
  AUDIT_EXPORT_FORMAT,
  AUDIT_EXPORT_MAX_ENTRIES,
  AUDIT_EXPORT_MAX_EVENTS,
  AUDIT_LEDGER_ENTRY_TYPE,
  AUDIT_SERVICE_EVENT,
  AuditExportPackage,
  ExportWrittenPayload,
  SIGNED_AUDIT_EXPORT_CONTENT_TYPE,
  SIGNED_AUDIT_EXPORT_FORMAT,
  auditExportId,
  auditExportStream,
  checkSignedAuditExport,
  exportedEventOf,
  signedAuditExportBytes,
  type AuditExportKeys,
  type AuditExportRequest,
  type AuditExportView,
  type LedgerEntryDraft,
  type SignedAuditExport,
} from '@aisdlc/contracts';
import { deterministicId, err, newId, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  LEDGER_ENTRY_COLUMNS,
  readLastCheckpoint,
  toLedgerEntry,
  type LedgerEntryRow,
} from '@aisdlc/ledger';
import type { AuditExportSignerPort, ObjectStorePort } from '@aisdlc/ports';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type pg from 'pg';
import {
  auditError,
  clockOf,
  listExports,
  recordAudit,
  type AuditDeps,
  type AuditError,
} from './store.js';

// The export half of the audit service (PLAN M19; ADR-0003 §1, §8 "large content lives in the object store, addressed
// by content hash"): a signed, self-contained package of the ledger and the record of one scope and time range, in the
// write-once bucket under its sha256, recorded as `audit.export_written` and the `audit.export` ledger entry.
//
// Which entries and events belong to a project: the streams whose events name the project (`project_id` in their body:
// its S0 records, items, gates, cards, threads...), every event of those streams, and the ledger entries that name the
// project in their body or whose subject or gate instance is one of those streams' subjects. The fleet is everything.
//
// Fail closed: no checkpoint is `not_checkpointed` (an export is anchored to one); a hole in the ledger is `unavailable`;
// more than the limits is `too_large` (narrow the range); the package is checked offline with the public keys BEFORE it
// is stored, and nothing is recorded unless it was signed, stored under its own hash and verifies.

export interface ExportDeps extends AuditDeps {
  readonly signer: AuditExportSignerPort;
  readonly objects: ObjectStorePort;
  /** The Notary's and the Witness's public keys: the package is checked with them before it is stored. */
  readonly keys: AuditExportKeys;
  /** The bundle version the PDP decided under (stamped on the ledger entry). */
  readonly policyVersion: () => string;
}

const projectStreams = `SELECT DISTINCT stream FROM record.record_event WHERE body ->> 'project_id' = $1`;

/** Each stream's subject id: what follows its first `:`. */
const subjectsOf = (streams: readonly string[]): string[] =>
  streams.map((s) => s.slice(s.indexOf(':') + 1)).filter((s) => s.length > 0);

const declared = new WeakSet<ObjectStorePort>();

async function bucketReady(objects: ObjectStorePort): Promise<Result<void, AuditError>> {
  if (declared.has(objects)) return ok(undefined);
  const b = await objects.declareBucket(AUDIT_BUCKET, 'write_once');
  if (!b.ok) return err(auditError('unavailable', `the object store: ${b.error.code}`));
  declared.add(objects);
  return ok(undefined);
}

export async function writeExport(
  d: ExportDeps,
  req: AuditExportRequest,
  requestedBy: string,
): Promise<Result<AuditExportView, AuditError>> {
  const now = clockOf(d).now();
  const export_id = newId<'AuditExport'>(now.getTime());
  const cp = await readLastCheckpoint(d.pool);
  if (!cp)
    return err(auditError('not_checkpointed', 'no checkpoint yet: an export is anchored to one'));
  const hashes = await d.pool.query<{ seq: string; entry_hash: string }>(
    `SELECT ledger_seq::text AS seq, entry_hash FROM ledger.ledger_entry
      WHERE ledger_seq <= $1 ORDER BY ledger_entry.ledger_seq`,
    [cp.to_ledger_seq],
  );
  if (
    hashes.rows.length !== cp.to_ledger_seq ||
    hashes.rows.some((r, i) => Number(r.seq) !== i + 1)
  ) {
    return err(auditError('unavailable', 'the ledger has a hole below its checkpoint'));
  }

  let streams: string[] | null = null;
  if (req.scope.kind === 'project') {
    const s = await d.pool.query<{ stream: string }>(projectStreams, [req.scope.project_id]);
    streams = s.rows.map((r) => r.stream).sort();
  }
  const project = req.scope.kind === 'project' ? req.scope.project_id : null;
  const subjects = streams === null ? [] : subjectsOf(streams);
  const entryWhere = `created_at >= $1 AND created_at < $2 AND (
      $3::text IS NULL OR body ->> 'project_id' = $3 OR subject_id = ANY($4::text[])
      OR gate_instance_id::text = ANY($4::text[]))`;
  const entryArgs = [req.from, req.to, project, subjects];
  const entries = await d.pool.query<LedgerEntryRow>(
    `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry
      WHERE ${entryWhere} AND ledger_seq <= $5 ORDER BY ledger_entry.ledger_seq LIMIT $6`,
    [...entryArgs, cp.to_ledger_seq, AUDIT_EXPORT_MAX_ENTRIES + 1],
  );
  if (entries.rows.length > AUDIT_EXPORT_MAX_ENTRIES) {
    return err(
      auditError(
        'too_large',
        `more than ${AUDIT_EXPORT_MAX_ENTRIES} ledger entries: narrow the range`,
      ),
    );
  }
  const uncovered = await d.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE ${entryWhere} AND ledger_seq > $5`,
    [...entryArgs, cp.to_ledger_seq],
  );
  const events = await d.pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE occurred_at >= $1 AND occurred_at < $2 AND ($3::text[] IS NULL OR stream = ANY($3::text[]))
      ORDER BY record_event.global_seq LIMIT $4`,
    [req.from, req.to, streams, AUDIT_EXPORT_MAX_EVENTS + 1],
  );
  if (events.rows.length > AUDIT_EXPORT_MAX_EVENTS) {
    return err(
      auditError(
        'too_large',
        `more than ${AUDIT_EXPORT_MAX_EVENTS} record events: narrow the range`,
      ),
    );
  }
  const exported = events.rows.map((r) => exportedEventOf(toRecordEvent(r)));
  const pkg = AuditExportPackage.parse({
    format: AUDIT_EXPORT_FORMAT,
    export_id,
    scope: req.scope,
    from: req.from,
    to: req.to,
    reason: req.reason,
    requested_by: requestedBy,
    produced_at: now.toISOString(),
    ledger: {
      checkpoint: cp,
      entry_hashes: hashes.rows.map((r) => r.entry_hash),
      entries: entries.rows.map(toLedgerEntry),
      uncovered: Number(uncovered.rows[0]?.n ?? 0),
    },
    record: { events: exported, streams: new Set(exported.map((e) => e.stream)).size },
  });
  const export_sha256 = auditExportId(pkg);
  const sig = await d.signer.signAuditExport({
    export_sha256,
    scope_ref: project === null ? 'fleet' : `project:${project}`,
  });
  if (!sig.ok)
    return err(auditError('unavailable', `the notary: ${sig.error.code}: ${sig.error.message}`));
  const signed: SignedAuditExport = {
    format: SIGNED_AUDIT_EXPORT_FORMAT,
    export_sha256,
    package: pkg,
    signature: sig.value,
  };
  const bytes = signedAuditExportBytes(signed);
  const object_key = sha256Hex(bytes);
  // never store (or record) what does not verify offline with the public keys alone
  const check = await checkSignedAuditExport(bytes, d.keys, { object_key });
  if (!check.ok)
    return err(
      auditError('unavailable', `the export does not verify: ${check.code}: ${check.message}`),
    );

  const ready = await bucketReady(d.objects);
  if (!ready.ok) return ready;
  const put = await d.objects.put(AUDIT_BUCKET, bytes, {
    contentType: SIGNED_AUDIT_EXPORT_CONTENT_TYPE,
  });
  if (!put.ok)
    return err(
      auditError('unavailable', `the object store: ${put.error.code}: ${put.error.message}`),
    );
  if (put.value.sha256 !== object_key)
    return err(auditError('unavailable', 'the object store keyed the export wrongly'));

  const entry_id = deterministicId<'LedgerEntry'>(`audit.export:${export_sha256}`);
  const written = ExportWrittenPayload.parse({
    export_id,
    scope: req.scope,
    from: req.from,
    to: req.to,
    reason: req.reason,
    requested_by: requestedBy,
    export_sha256,
    bucket: AUDIT_BUCKET,
    object_key,
    size: bytes.byteLength,
    key_id: sig.value.key_id,
    checkpoint_seq: cp.cp_seq,
    covered_to: cp.to_ledger_seq,
    entries: pkg.ledger.entries.length,
    events: exported.length,
    uncovered: pkg.ledger.uncovered,
    produced_at: pkg.produced_at,
    entry_id,
  });
  const facts: Record<string, unknown> = { ...written };
  delete facts['entry_id'];
  const draft: LedgerEntryDraft = {
    entry_id,
    entry_type: AUDIT_LEDGER_ENTRY_TYPE.export,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: export_sha256 as never,
    decision: null,
    actor: requestedBy as never,
    sod_waiver: false,
    policy_bundle_version: d.policyVersion(),
    // `project_id` at the top of the body: the project's own ledger view lists its exports
    body: { kind: 'audit_export', project_id: project, ...facts } as never,
    created_at: pkg.produced_at as never,
  };
  const rec = await recordAudit(d, {
    lock: `export:${export_id}`,
    stream: auditExportStream(export_id),
    events: [
      {
        type: AUDIT_SERVICE_EVENT.export_written,
        body: written as never,
        key: `export:${export_id}`,
      },
    ],
    draft,
  });
  if (!rec.ok) return rec;
  const view = (await listExports(d.pool, { export_id }))[0];
  return view
    ? ok(view)
    : err(auditError('unavailable', 'the export was not found after it was recorded'));
}

/** The stored bytes of a recorded export, re-hashed to their object key (the store is untrusted storage). */
export async function readExportBytes(
  d: { pool: pg.Pool; objects: ObjectStorePort },
  exportId: string,
): Promise<Result<{ view: AuditExportView; bytes: Uint8Array }, AuditError>> {
  const view = (await listExports(d.pool, { export_id: exportId }))[0];
  if (!view) return err(auditError('not_found', 'no such export'));
  const ready = await bucketReady(d.objects);
  if (!ready.ok) return ready;
  const g = await d.objects.get(view.bucket, view.object_key);
  if (!g.ok) return err(auditError('unavailable', `the object store: ${g.error.code}`));
  if (sha256Hex(g.value) !== view.object_key)
    return err(auditError('unavailable', 'the bytes do not hash to their key'));
  return ok({ view, bytes: g.value });
}
