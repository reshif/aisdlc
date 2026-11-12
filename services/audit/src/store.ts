import {
  AUDIT_SERVICE_EVENT,
  AUDIT_SERVICE_STREAM_PREFIX,
  AUDIT_ACTOR,
  AuditExportView,
  ErasureBlockedPayload,
  ErasureDecidedPayload,
  ErasureRequestedPayload,
  ErasureView,
  ExportWrittenPayload,
  HoldPlacedPayload,
  HoldReleasedPayload,
  LegalHoldView,
  AuditPayloadErasedPayload,
  RetentionSweptPayload,
  holdCovers,
  type HeldSubject,
  type LedgerEntryDraft,
  type LegalHoldScope,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import {
  err,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  confirmAll,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// The audit service's record and read models (PLAN M19). Record first: every fact is an `audit.*` event on one of the
// service's own streams, folded into its read model in the same transaction; a decision (an export written, an erasure
// approved, a hold placed or released) is ALSO a ledger entry, written last in that transaction after the subject's
// lock and the ledger lock (AGENTS.md lock order). `rebuildAudit` drops the read models and folds them again from the
// record alone.

export type AuditErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'legal_hold'
  | 'too_large'
  | 'not_checkpointed'
  | 'unavailable';

export const AuditError = taggedError('AuditError');
export type AuditError = TaggedError<'AuditError', { code: AuditErrorCode; message: string }>;
export const auditError = (code: AuditErrorCode, message: string): AuditError =>
  AuditError({ code, message });

export const AUDIT_STATUS: Record<AuditErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  legal_hold: 409,
  too_large: 413,
  not_checkpointed: 409,
  unavailable: 503,
};

export interface AuditDeps {
  /** The record database, as the least-privilege role `audit`. */
  readonly pool: pg.Pool;
  readonly ledger: LedgerClientDeps;
  readonly clock?: Clock;
}

export const clockOf = (d: { clock?: Clock }): Clock => d.clock ?? systemClock;

export interface NewAuditEvent {
  readonly type: string;
  readonly body: JsonObject;
  /** Every audit fact has one: a retry is the same fact. */
  readonly key: string;
}

const lockKey = (tx: pg.PoolClient, key: string) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`aisdlc.audit:${key}`]);

/**
 * Appends events to one stream (and folds them), and, when `draft` is given, the ledger entry LAST, in one
 * transaction: the subject's lock, then the ledger lock, before the first append (the lock order). A retry of the same
 * facts (their keys already stored) writes nothing, folds nothing and adds no entry. The Notary is confirmed after
 * COMMIT; a failed confirm is finished by the reconciler.
 */
export async function recordAudit(
  d: AuditDeps,
  o: {
    readonly lock: string;
    readonly stream: string;
    readonly events: readonly NewAuditEvent[];
    readonly draft?: LedgerEntryDraft;
    /** Runs under the locks before anything is appended: a refusal here writes nothing. */
    readonly check?: (tx: pg.PoolClient) => Promise<Result<void, AuditError>>;
  },
): Promise<Result<{ duplicate: boolean }, AuditError>> {
  let pending: PendingConfirm[] = [];
  let out: Result<{ duplicate: boolean }, AuditError>;
  try {
    out = await withTransaction(d.pool, async (tx) => {
      await lockKey(tx, o.lock);
      if (o.draft) {
        await lockLedger(tx);
        const caught = await importUnconfirmed(tx, d.ledger);
        if (!caught.ok) throw new Abort(auditError('unavailable', caught.error.message));
        pending = [...caught.value.pending];
      }
      if (o.check) {
        const c = await o.check(tx);
        if (!c.ok) throw new Abort(c.error);
      }
      const head = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [o.stream],
      );
      const a = await appendEvents(
        tx,
        o.stream,
        Number(head.rows[0]?.seq ?? 0),
        o.events.map((e) => ({
          type: e.type,
          body: e.body,
          actor: AUDIT_ACTOR,
          idempotency_key: e.key,
        })),
        { clock: clockOf(d) },
      );
      if (!a.ok) {
        throw new Abort(
          auditError(
            a.error._tag === 'IdempotencyMismatch' ? 'conflict' : 'unavailable',
            `the record refused the append (${a.error._tag})`,
          ),
        );
      }
      if (a.value.duplicate) return ok({ duplicate: true });
      for (const e of a.value.events) await applyAuditEvent(tx, e.type, e.payload, e.global_seq);
      if (o.draft) {
        const l = await appendLedgerEntryTx(tx, d.ledger, o.draft);
        if (!l.ok) throw new Abort(auditError('unavailable', `the ledger: ${l.error.message}`));
        pending.push(...l.value.pending);
      }
      return ok({ duplicate: false });
    });
  } catch (e) {
    if (e instanceof Abort) return err(e.error);
    return err(
      auditError('unavailable', e instanceof Error ? e.message.slice(0, 300) : 'database'),
    );
  }
  if (pending.length > 0) await confirmAll(d.ledger.notary, pending);
  return out;
}

class Abort extends Error {
  constructor(readonly error: AuditError) {
    super(error.message);
  }
}

// ---------------------------------------------------------------- the fold

const scopeRef = (s: LegalHoldScope): string =>
  s.kind === 'fleet' ? '*' : s.kind === 'project' ? s.project_id : s.principal_id;

/** Folds one audit event into the read models (live, in the append's transaction, and in a rebuild). */
export async function applyAuditEvent(
  tx: Pick<pg.PoolClient, 'query'>,
  type: string,
  body: unknown,
  gseq: number,
): Promise<void> {
  switch (type) {
    case AUDIT_SERVICE_EVENT.export_written: {
      const p = ExportWrittenPayload.parse(body);
      await tx.query(
        `INSERT INTO audit.export (export_id, scope_kind, project_id, from_at, to_at, requested_by, export_sha256,
           object_key, entry_id, payload, event_gseq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (export_id) DO NOTHING`,
        [
          p.export_id,
          p.scope.kind,
          p.scope.kind === 'project' ? p.scope.project_id : null,
          p.from,
          p.to,
          p.requested_by,
          p.export_sha256,
          p.object_key,
          p.entry_id,
          JSON.stringify(p),
          gseq,
        ],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.hold_placed: {
      const p = HoldPlacedPayload.parse(body);
      await tx.query(
        `INSERT INTO audit.legal_hold (hold_id, scope_kind, scope_ref, scope, matter_ref, reason, state, placed_by,
           placed_at, place_entry_id, event_gseq)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10) ON CONFLICT (hold_id) DO NOTHING`,
        [
          p.hold_id,
          p.scope.kind,
          scopeRef(p.scope),
          JSON.stringify(p.scope),
          p.matter_ref,
          p.reason,
          p.placed_by,
          p.at,
          p.entry_id,
          gseq,
        ],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.hold_released: {
      const p = HoldReleasedPayload.parse(body);
      await tx.query(
        `UPDATE audit.legal_hold SET state = 'released', released_by = $2, released_at = $3, release_reason = $4,
           release_entry_id = $5, event_gseq = $6 WHERE hold_id = $1`,
        [p.hold_id, p.released_by, p.at, p.reason, p.entry_id, gseq],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.erasure_requested: {
      const p = ErasureRequestedPayload.parse(body);
      await tx.query(
        `INSERT INTO audit.erasure (erasure_id, basis, state, subject, reason, requested_by, requested_at, event_gseq)
         VALUES ($1, $2, 'requested', $3, $4, $5, $6, $7) ON CONFLICT (erasure_id) DO NOTHING`,
        [
          p.erasure_id,
          p.basis,
          p.subject === null ? null : JSON.stringify(p.subject),
          p.reason,
          p.requested_by,
          p.requested_at,
          gseq,
        ],
      );
      for (const t of p.targets) {
        await tx.query(
          `INSERT INTO audit.erasure_target (erasure_id, payload_id, kind, thread_id, owner, project_id, sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [p.erasure_id, t.payload_id, t.kind, t.thread_id, t.owner, t.project_id, t.sha256],
        );
      }
      return;
    }
    case AUDIT_SERVICE_EVENT.erasure_approved:
    case AUDIT_SERVICE_EVENT.erasure_rejected: {
      const p = ErasureDecidedPayload.parse(body);
      if (type === AUDIT_SERVICE_EVENT.erasure_approved) {
        await tx.query(
          `UPDATE audit.erasure SET state = 'approved', approved_by = $2, approved_at = $3, matter_ref = $4,
             entry_id = $5, blocked_by = '[]'::jsonb, event_gseq = $6 WHERE erasure_id = $1`,
          [p.erasure_id, p.by, p.at, p.matter_ref, p.entry_id, gseq],
        );
      } else {
        await tx.query(
          `UPDATE audit.erasure SET state = 'rejected', rejected_by = $2, event_gseq = $3 WHERE erasure_id = $1`,
          [p.erasure_id, p.by, gseq],
        );
      }
      return;
    }
    case AUDIT_SERVICE_EVENT.erasure_blocked: {
      const p = ErasureBlockedPayload.parse(body);
      await tx.query(
        `UPDATE audit.erasure SET state = 'blocked', blocked_by = $2, event_gseq = $3 WHERE erasure_id = $1`,
        [p.erasure_id, JSON.stringify(p.hold_ids), gseq],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.payload_erased: {
      const p = AuditPayloadErasedPayload.parse(body);
      await tx.query(
        'UPDATE audit.erasure_target SET erased = true WHERE erasure_id = $1 AND payload_id = $2',
        [p.erasure_id, p.payload_id],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.erasure_executed: {
      const p = body as { erasure_id: string; at: string };
      await tx.query(
        `UPDATE audit.erasure SET state = 'executed', executed_at = $2, event_gseq = $3 WHERE erasure_id = $1`,
        [p.erasure_id, p.at, gseq],
      );
      return;
    }
    case AUDIT_SERVICE_EVENT.retention_swept: {
      const p = RetentionSweptPayload.parse(body);
      await tx.query(
        `INSERT INTO audit.retention_sweep (event_gseq, class, payload, at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [gseq, p.class, JSON.stringify(p), p.at],
      );
      return;
    }
    default:
      return;
  }
}

const TABLES = [
  'audit.erasure_target',
  'audit.erasure',
  'audit.legal_hold',
  'audit.export',
  'audit.retention_sweep',
];

/** Drops the read models and folds them again from the record alone (as the schema's owner). Returns events. */
export async function rebuildAudit(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    for (const t of TABLES) await tx.query(`DELETE FROM ${t}`);
    const ev = await tx.query<{ type: string; body: unknown; global_seq: string }>(
      `SELECT type, body, global_seq::text FROM record.record_event
        WHERE stream LIKE $1 ORDER BY record_event.global_seq`,
      [`${AUDIT_SERVICE_STREAM_PREFIX}%`],
    );
    for (const e of ev.rows) await applyAuditEvent(tx, e.type, e.body, Number(e.global_seq));
    return ev.rows.length;
  });
}

/** Every row of every read model, in a fixed order (rebuild-equals-live). */
export async function auditSnapshot(pool: Pick<pg.Pool, 'query'>): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const t of TABLES) {
    const r = await pool.query(`SELECT to_jsonb(x) AS row FROM ${t} x ORDER BY to_jsonb(x)::text`);
    out.push(r.rows.map((x) => x.row));
  }
  return out;
}

// ---------------------------------------------------------------- reads

const iso = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString();

async function seqOf(db: Pick<pg.Pool, 'query'>, entryId: string | null): Promise<number | null> {
  if (entryId === null) return null;
  const r = await db.query<{ s: string }>(
    'SELECT ledger_seq::text AS s FROM ledger.ledger_entry WHERE entry_id = $1',
    [entryId],
  );
  return r.rows[0] ? Number(r.rows[0].s) : null;
}

export async function listExports(
  db: Pick<pg.Pool, 'query'>,
  q: { project_id?: string | null; export_id?: string; limit?: number } = {},
): Promise<AuditExportView[]> {
  const r = await db.query<{ payload: unknown; entry_id: string }>(
    `SELECT payload, entry_id::text AS entry_id FROM audit.export
      WHERE ($1::text IS NULL OR project_id = $1) AND ($2::uuid IS NULL OR export_id = $2)
      ORDER BY event_gseq DESC LIMIT $3`,
    [q.project_id ?? null, q.export_id ?? null, q.limit ?? 200],
  );
  const out: AuditExportView[] = [];
  for (const x of r.rows) {
    const seq = await seqOf(db, x.entry_id);
    // the entry is in the same transaction as the event: an export without it is not one
    if (seq === null) continue;
    out.push(AuditExportView.parse({ ...(x.payload as object), entry_seq: seq }));
  }
  return out;
}

export async function listHolds(
  db: Pick<pg.Pool, 'query'>,
  q: { hold_id?: string; active_only?: boolean } = {},
): Promise<LegalHoldView[]> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT hold_id::text AS hold_id, scope, matter_ref, reason, state, placed_by, placed_at,
            place_entry_id::text AS place_entry_id, released_by, released_at, release_reason,
            release_entry_id::text AS release_entry_id
       FROM audit.legal_hold
      WHERE ($1::uuid IS NULL OR hold_id = $1) AND (NOT $2 OR state = 'active')
      ORDER BY placed_at DESC, hold_id`,
    [q.hold_id ?? null, q.active_only === true],
  );
  const out: LegalHoldView[] = [];
  for (const x of r.rows) {
    const place = await seqOf(db, x['place_entry_id'] as string);
    if (place === null) continue;
    out.push(
      LegalHoldView.parse({
        hold_id: x['hold_id'],
        scope: x['scope'],
        matter_ref: x['matter_ref'],
        reason: x['reason'],
        state: x['state'],
        placed_by: x['placed_by'],
        placed_at: iso(x['placed_at']),
        place_entry_seq: place,
        released_by: x['released_by'] ?? null,
        released_at: iso(x['released_at']),
        release_reason: x['release_reason'] ?? null,
        release_entry_seq: await seqOf(db, (x['release_entry_id'] as string | null) ?? null),
      }),
    );
  }
  return out;
}

/** The active holds that cover any of these payloads (fail closed: a hold whose entry is missing still counts). */
export async function holdsCovering(
  db: Pick<pg.Pool, 'query'>,
  subjects: readonly HeldSubject[],
): Promise<string[]> {
  const r = await db.query<{ hold_id: string; scope: LegalHoldScope }>(
    `SELECT hold_id::text AS hold_id, scope FROM audit.legal_hold WHERE state = 'active' ORDER BY hold_id`,
  );
  return r.rows.filter((h) => subjects.some((s) => holdCovers(h.scope, s))).map((h) => h.hold_id);
}

export async function listErasures(
  db: Pick<pg.Pool, 'query'>,
  q: { erasure_id?: string; state?: string; limit?: number } = {},
): Promise<ErasureView[]> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT erasure_id::text AS erasure_id, basis, subject, state, reason, requested_by, requested_at, approved_by,
            approved_at, matter_ref, entry_id::text AS entry_id, blocked_by, rejected_by, executed_at
       FROM audit.erasure
      WHERE ($1::uuid IS NULL OR erasure_id = $1) AND ($2::text IS NULL OR state = $2)
      ORDER BY requested_at DESC, erasure_id LIMIT $3`,
    [q.erasure_id ?? null, q.state ?? null, q.limit ?? 200],
  );
  const out: ErasureView[] = [];
  for (const x of r.rows) {
    const t = await db.query<Record<string, unknown>>(
      `SELECT kind, payload_id::text AS payload_id, thread_id::text AS thread_id, owner, project_id, sha256, erased
         FROM audit.erasure_target WHERE erasure_id = $1 ORDER BY payload_id`,
      [x['erasure_id']],
    );
    out.push(
      ErasureView.parse({
        erasure_id: x['erasure_id'],
        basis: x['basis'],
        subject: x['subject'] ?? null,
        state: x['state'],
        reason: x['reason'],
        requested_by: x['requested_by'],
        requested_at: iso(x['requested_at']),
        approved_by: x['approved_by'] ?? null,
        approved_at: iso(x['approved_at']),
        matter_ref: x['matter_ref'] ?? null,
        entry_seq: await seqOf(db, (x['entry_id'] as string | null) ?? null),
        targets: t.rows.map((y) => ({ ...y, project_id: y['project_id'] ?? null })),
        blocked_by: x['blocked_by'] ?? [],
        rejected_by: x['rejected_by'] ?? null,
        executed_at: iso(x['executed_at']),
      }),
    );
  }
  return out;
}

export async function lastSweeps(
  db: Pick<pg.Pool, 'query'>,
  limit = 10,
): Promise<RetentionSweptPayload[]> {
  const r = await db.query<{ payload: unknown }>(
    'SELECT payload FROM audit.retention_sweep ORDER BY event_gseq DESC LIMIT $1',
    [limit],
  );
  return r.rows.map((x) => RetentionSweptPayload.parse(x.payload));
}
