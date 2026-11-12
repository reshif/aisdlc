import {
  AUDIT_LEDGER_ENTRY_TYPE,
  AUDIT_RETENTION_STREAM,
  AUDIT_SERVICE_EVENT,
  ERASURE_MAX_TARGETS,
  ErasureBlockedPayload,
  ErasureDecidedPayload,
  ErasureRequestedPayload,
  HoldPlacedPayload,
  HoldReleasedPayload,
  AuditPayloadErasedPayload,
  RetentionSweptPayload,
  auditErasureStream,
  auditHoldStream,
  type AuditRetentionConfig,
  type ErasureRequestInput,
  type ErasureTarget,
  type ErasureView,
  type LedgerEntryDraft,
  type LegalHoldView,
  type PlaceHoldRequest,
} from '@aisdlc/contracts';
import { deterministicId, err, hashCanonical, newId, ok, type Result } from '@aisdlc/kernel';
import type { ErasablePayloadsPort } from '@aisdlc/ports';
import type pg from 'pg';
import {
  auditError,
  clockOf,
  holdsCovering,
  listErasures,
  listHolds,
  recordAudit,
  type AuditDeps,
  type AuditError,
} from './store.js';

// Legal hold, erasure and retention (PLAN M19; DM §3.12 ErasureRequest, LegalHold, RetentionClass).
//
//   - A legal hold is placed by a factory admin (`legal_hold.place` on the ledger) and released by ANOTHER one
//     (`legal_hold.release`): loosening always needs a second person. While it is active no payload it covers is
//     erased, by a request or by retention.
//   - An erasure is requested by a factory admin (the payloads it covers are found then, by id and hash, through core),
//     and approved, as the legal approval under a matter reference, by ANOTHER factory admin. The approval is the
//     `erasure.execute` ledger entry, written before anything is erased; then each payload is erased through core and
//     recorded. A hold covering any payload blocks the approval (recorded, nothing erased) and stops an approved erasure
//     before each payload. A blocked erasure can be approved again once the hold is released (a new entry).
//   - Retention: the published `audit.retention` class (M1-gated) erases the payloads older than its days, as an
//     erasure of basis `retention` approved by the config revision itself, minus what a hold covers.
// Holds and approvals take one lock, so an approval never misses a hold placed at the same moment.

export interface GovernDeps extends AuditDeps {
  readonly payloads: ErasablePayloadsPort;
  readonly policyVersion: () => string;
}

const HOLDS_LOCK = 'legal-holds';

const textOf = (e: AuditError): string => `${e.code}: ${e.message}`;

// ---------------------------------------------------------------- legal hold

export async function placeHold(
  d: GovernDeps,
  req: PlaceHoldRequest,
  by: string,
): Promise<Result<LegalHoldView, AuditError>> {
  const at = clockOf(d).now().toISOString();
  const hold_id = newId<'LegalHold'>(Date.parse(at));
  const entry_id = deterministicId<'LedgerEntry'>(`legal_hold.place:${hold_id}`);
  const p = HoldPlacedPayload.parse({ hold_id, ...req, placed_by: by, entry_id, at });
  const r = await recordAudit(d, {
    lock: HOLDS_LOCK,
    stream: auditHoldStream(hold_id),
    events: [{ type: AUDIT_SERVICE_EVENT.hold_placed, body: p as never, key: `placed:${hold_id}` }],
    draft: holdDraft(d, AUDIT_LEDGER_ENTRY_TYPE.hold_placed, entry_id, by, at, {
      kind: 'legal_hold',
      hold_id,
      scope: req.scope,
      project_id: req.scope.kind === 'project' ? req.scope.project_id : null,
      matter_ref: req.matter_ref,
      reason: req.reason,
    }),
  });
  if (!r.ok) return r;
  const v = (await listHolds(d.pool, { hold_id }))[0];
  return v ? ok(v) : err(auditError('unavailable', 'the hold was not found after it was recorded'));
}

export async function releaseHold(
  d: GovernDeps,
  holdId: string,
  reason: string,
  by: string,
): Promise<Result<LegalHoldView, AuditError>> {
  const have = (await listHolds(d.pool, { hold_id: holdId }))[0];
  if (!have) return err(auditError('not_found', 'no such hold'));
  if (have.state !== 'active') return err(auditError('conflict', 'the hold is not active'));
  if (have.placed_by === by) {
    return err(
      auditError(
        'forbidden',
        'the person who placed a hold does not release it: a second factory admin does',
      ),
    );
  }
  const at = clockOf(d).now().toISOString();
  const entry_id = deterministicId<'LedgerEntry'>(`legal_hold.release:${holdId}`);
  const p = HoldReleasedPayload.parse({ hold_id: holdId, released_by: by, reason, entry_id, at });
  const r = await recordAudit(d, {
    lock: HOLDS_LOCK,
    stream: auditHoldStream(holdId),
    events: [
      { type: AUDIT_SERVICE_EVENT.hold_released, body: p as never, key: `released:${holdId}` },
    ],
    draft: holdDraft(d, AUDIT_LEDGER_ENTRY_TYPE.hold_released, entry_id, by, at, {
      kind: 'legal_hold',
      hold_id: holdId,
      scope: have.scope,
      project_id: have.scope.kind === 'project' ? have.scope.project_id : null,
      reason,
    }),
    check: async (tx) => {
      const s = await tx.query<{ state: string }>(
        'SELECT state FROM audit.legal_hold WHERE hold_id = $1',
        [holdId],
      );
      return s.rows[0]?.state === 'active'
        ? ok(undefined)
        : err(auditError('conflict', 'the hold is not active'));
    },
  });
  if (!r.ok) return r;
  const v = (await listHolds(d.pool, { hold_id: holdId }))[0];
  return v ? ok(v) : err(auditError('unavailable', 'the hold was not found after it was recorded'));
}

function holdDraft(
  d: GovernDeps,
  type: string,
  entry_id: string,
  by: string,
  at: string,
  body: Record<string, unknown>,
): LedgerEntryDraft {
  return {
    entry_id: entry_id as never,
    entry_type: type,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: hashCanonical(body as never) as never,
    decision: null,
    actor: by as never,
    sod_waiver: false,
    policy_bundle_version: d.policyVersion(),
    body: body as never,
    created_at: at as never,
  };
}

// ---------------------------------------------------------------- erasure

const one = async (d: GovernDeps, id: string): Promise<ErasureView | undefined> =>
  (await listErasures(d.pool, { erasure_id: id }))[0];

export async function requestErasure(
  d: GovernDeps,
  input: ErasureRequestInput,
  by: string,
): Promise<Result<ErasureView, AuditError>> {
  const found = await d.payloads.list({
    owner: input.subject.principal_id,
    ...(input.subject.project_id === null ? {} : { project_id: input.subject.project_id }),
    live_only: true,
    limit: ERASURE_MAX_TARGETS + 1,
  });
  if (!found.ok)
    return err(auditError('unavailable', `core: ${found.error.code}: ${found.error.message}`));
  if (found.value.length === 0) {
    return err(auditError('not_found', 'the subject has no payload left to erase'));
  }
  if (found.value.length > ERASURE_MAX_TARGETS) {
    return err(
      auditError(
        'too_large',
        `more than ${ERASURE_MAX_TARGETS} payloads: narrow the subject to a project`,
      ),
    );
  }
  const at = clockOf(d).now().toISOString();
  const erasure_id = newId<'Erasure'>(Date.parse(at));
  const p = ErasureRequestedPayload.parse({
    erasure_id,
    basis: 'request',
    subject: input.subject,
    reason: input.reason,
    requested_by: by,
    retention: null,
    targets: found.value.map(targetOf),
    requested_at: at,
  });
  const r = await recordAudit(d, {
    lock: `erasure:${erasure_id}`,
    stream: auditErasureStream(erasure_id),
    events: [
      {
        type: AUDIT_SERVICE_EVENT.erasure_requested,
        body: p as never,
        key: `requested:${erasure_id}`,
      },
    ],
  });
  if (!r.ok) return r;
  const v = await one(d, erasure_id);
  return v
    ? ok(v)
    : err(auditError('unavailable', 'the erasure was not found after it was recorded'));
}

const targetOf = (p: ErasureTarget): ErasureTarget => ({
  kind: p.kind,
  payload_id: p.payload_id,
  thread_id: p.thread_id,
  owner: p.owner,
  project_id: p.project_id,
  sha256: p.sha256,
});

export async function rejectErasure(
  d: GovernDeps,
  id: string,
  reason: string,
  by: string,
): Promise<Result<ErasureView, AuditError>> {
  const v = await one(d, id);
  if (!v) return err(auditError('not_found', 'no such erasure'));
  if (v.state !== 'requested' && v.state !== 'blocked') {
    return err(auditError('conflict', `the erasure is ${v.state}`));
  }
  if (v.requested_by === by) {
    return err(auditError('forbidden', 'the requester does not decide their own erasure request'));
  }
  const at = clockOf(d).now().toISOString();
  const p = ErasureDecidedPayload.parse({
    erasure_id: id,
    by,
    reason,
    matter_ref: null,
    entry_id: null,
    at,
  });
  const r = await recordAudit(d, {
    lock: `erasure:${id}`,
    stream: auditErasureStream(id),
    events: [
      { type: AUDIT_SERVICE_EVENT.erasure_rejected, body: p as never, key: `rejected:${id}` },
    ],
  });
  if (!r.ok) return r;
  return ok((await one(d, id)) as ErasureView);
}

/** How many times an erasure was approved so far (a blocked one may be approved again: a new entry each time). */
async function approvals(pool: Pick<pg.Pool, 'query'>, id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM record.record_event WHERE stream = $1 AND type = $2',
    [auditErasureStream(id), AUDIT_SERVICE_EVENT.erasure_approved],
  );
  return Number(r.rows[0]?.n ?? 0);
}

function erasureDraft(
  d: GovernDeps,
  entry_id: string,
  approver: string | null,
  at: string,
  v: Pick<ErasureView, 'erasure_id' | 'basis' | 'subject' | 'requested_by' | 'reason'> & {
    readonly targets: readonly ErasureTarget[];
  },
  extra: Record<string, unknown>,
): LedgerEntryDraft {
  const targets = v.targets.map((t) => ({
    kind: t.kind,
    payload_id: t.payload_id,
    thread_id: t.thread_id,
    sha256: t.sha256,
  }));
  return {
    entry_id: entry_id as never,
    entry_type: AUDIT_LEDGER_ENTRY_TYPE.erasure,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: hashCanonical(targets as never) as never,
    decision: null,
    actor: approver as never,
    sod_waiver: false,
    policy_bundle_version: d.policyVersion(),
    body: {
      kind: 'erasure',
      erasure_id: v.erasure_id,
      basis: v.basis,
      subject: v.subject,
      project_id: v.subject?.project_id ?? null,
      requested_by: v.requested_by,
      reason: v.reason,
      targets,
      ...extra,
    } as never,
    created_at: at as never,
  };
}

/** The holds covering an erasure's payloads that are not erased yet, read under the holds' lock. */
async function heldBy(
  db: Pick<pg.Pool, 'query'>,
  targets: ReadonlyArray<ErasureTarget & { erased?: boolean }>,
): Promise<string[]> {
  return holdsCovering(
    db,
    targets
      .filter((t) => t.erased !== true)
      .map((t) => ({ owner: t.owner, project_id: t.project_id })),
  );
}

async function recordBlocked(
  d: GovernDeps,
  id: string,
  holds: string[],
  stage: 'approval' | 'execution',
  n: number,
): Promise<void> {
  const p = ErasureBlockedPayload.parse({
    erasure_id: id,
    hold_ids: holds,
    at_stage: stage,
    at: clockOf(d).now().toISOString(),
  });
  await recordAudit(d, {
    lock: `erasure:${id}`,
    stream: auditErasureStream(id),
    events: [
      {
        type: AUDIT_SERVICE_EVENT.erasure_blocked,
        body: p as never,
        key: `blocked:${stage}:${n}:${p.at}`,
      },
    ],
  });
}

export async function approveErasure(
  d: GovernDeps,
  id: string,
  o: { matter_ref: string; reason: string },
  by: string,
): Promise<Result<ErasureView, AuditError>> {
  const v = await one(d, id);
  if (!v) return err(auditError('not_found', 'no such erasure'));
  if (v.state !== 'requested' && v.state !== 'blocked') {
    return err(auditError('conflict', `the erasure is ${v.state}`));
  }
  if (v.requested_by === by) {
    return err(
      auditError(
        'forbidden',
        'the requester does not approve their own erasure: a second factory admin does',
      ),
    );
  }
  const n = (await approvals(d.pool, id)) + 1;
  const held = await heldBy(d.pool, v.targets);
  if (held.length > 0) {
    await recordBlocked(d, id, held, 'approval', n);
    return err(
      auditError(
        'legal_hold',
        `a legal hold covers the subject (${held.join(', ')}): nothing is erased`,
      ),
    );
  }
  const at = clockOf(d).now().toISOString();
  const entry_id = deterministicId<'LedgerEntry'>(`erasure.execute:${id}:${n}`);
  const p = ErasureDecidedPayload.parse({
    erasure_id: id,
    by,
    reason: o.reason,
    matter_ref: o.matter_ref,
    entry_id,
    at,
  });
  const r = await recordAudit(d, {
    lock: HOLDS_LOCK,
    stream: auditErasureStream(id),
    events: [
      { type: AUDIT_SERVICE_EVENT.erasure_approved, body: p as never, key: `approved:${n}` },
    ],
    draft: erasureDraft(d, entry_id, by, at, v, {
      approved_by: by,
      matter_ref: o.matter_ref,
      approval_reason: o.reason,
    }),
    // under the holds' lock: a hold placed a moment ago is seen here
    check: async (tx) => {
      const st = await tx.query<{ state: string }>(
        'SELECT state FROM audit.erasure WHERE erasure_id = $1',
        [id],
      );
      const state = st.rows[0]?.state;
      if (state !== 'requested' && state !== 'blocked') {
        return err(auditError('conflict', `the erasure is ${state ?? 'missing'}`));
      }
      const now = await heldBy(tx, v.targets);
      return now.length === 0
        ? ok(undefined)
        : err(auditError('legal_hold', `a legal hold covers the subject (${now.join(', ')})`));
    },
  });
  if (!r.ok) return r;
  await executeErasure(d, id);
  return ok((await one(d, id)) as ErasureView);
}

/**
 * Erases an approved erasure's payloads that are not erased yet, one by one, each recorded; a hold over a payload stops
 * it (recorded, `blocked`); core unreachable leaves it `approved` for the next tick. Returns what it did.
 */
export async function executeErasure(
  d: GovernDeps,
  id: string,
): Promise<'executed' | 'blocked' | 'pending' | 'skipped'> {
  const v = await one(d, id);
  if (!v || v.state !== 'approved') return 'skipped';
  const n = await approvals(d.pool, id);
  for (const t of v.targets) {
    if (t.erased) continue;
    const held = await heldBy(d.pool, [t]);
    if (held.length > 0) {
      await recordBlocked(d, id, held, 'execution', n);
      return 'blocked';
    }
    const e = await d.payloads.erase(targetOf(t));
    if (!e.ok) return 'pending';
    const p = AuditPayloadErasedPayload.parse({
      erasure_id: id,
      payload_id: t.payload_id,
      sha256: t.sha256,
      already: e.value.already,
      at: clockOf(d).now().toISOString(),
    });
    const r = await recordAudit(d, {
      lock: `erasure:${id}`,
      stream: auditErasureStream(id),
      events: [
        {
          type: AUDIT_SERVICE_EVENT.payload_erased,
          body: p as never,
          key: `erased:${t.payload_id}`,
        },
      ],
    });
    if (!r.ok) return 'pending';
  }
  const done = await recordAudit(d, {
    lock: `erasure:${id}`,
    stream: auditErasureStream(id),
    events: [
      {
        type: AUDIT_SERVICE_EVENT.erasure_executed,
        body: { erasure_id: id, erased: v.targets.length, at: clockOf(d).now().toISOString() },
        key: `executed:${n}`,
      },
    ],
  });
  return done.ok ? 'executed' : 'pending';
}

/** The loop's work: every approved erasure not finished yet. */
export async function executeApproved(d: GovernDeps): Promise<number> {
  let n = 0;
  for (const v of await listErasures(d.pool, { state: 'approved' })) {
    if ((await executeErasure(d, v.erasure_id)) === 'executed') n += 1;
  }
  return n;
}

// ---------------------------------------------------------------- retention

export interface RetentionRead {
  readonly config: AuditRetentionConfig;
  /** The published revision it comes from; `null` is the default (which erases nothing). */
  readonly rev_hash: string | null;
}

/**
 * One sweep of the conversation payload class: the live payloads older than its days, minus those a hold covers and
 * those an open erasure already names, become ONE retention erasure (requested and approved by the published class in
 * one transaction with its `erasure.execute` entry), then erased. `days: null` erases nothing and records nothing.
 */
export async function sweepRetention(
  d: GovernDeps,
  read: RetentionRead,
): Promise<Result<{ due: number; held: number; erasure_id: string | null }, AuditError>> {
  const days = read.config.classes.conversation_payload.days;
  if (days === null) return ok({ due: 0, held: 0, erasure_id: null });
  const now = clockOf(d).now();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const found = await d.payloads.list({
    created_before: cutoff,
    live_only: true,
    limit: ERASURE_MAX_TARGETS * 2,
  });
  if (!found.ok)
    return err(auditError('unavailable', `core: ${found.error.code}: ${found.error.message}`));
  const open = await d.pool.query<{ payload_id: string }>(
    `SELECT t.payload_id::text AS payload_id FROM audit.erasure_target t JOIN audit.erasure e USING (erasure_id)
      WHERE NOT t.erased AND e.state IN ('requested', 'approved', 'blocked')`,
  );
  const named = new Set(open.rows.map((r) => r.payload_id));
  const candidates = found.value.filter((p) => !named.has(p.payload_id));
  const free = [];
  let held = 0;
  for (const p of candidates) {
    if ((await holdsCovering(d.pool, [p])).length > 0) held += 1;
    else free.push(p);
  }
  const due = free.slice(0, ERASURE_MAX_TARGETS);
  if (due.length === 0 && held === 0) return ok({ due: 0, held: 0, erasure_id: null });
  const at = now.toISOString();
  let erasure_id: string | null = null;
  if (due.length > 0) {
    erasure_id = newId<'Erasure'>(now.getTime());
    const requested = ErasureRequestedPayload.parse({
      erasure_id,
      basis: 'retention',
      subject: null,
      reason: `retention class conversation_payload: older than ${days} days`,
      requested_by: 'system.audit',
      retention: { class: 'conversation_payload', days, rev_hash: read.rev_hash },
      targets: due.map(targetOf),
      requested_at: at,
    });
    const entry_id = deterministicId<'LedgerEntry'>(`erasure.execute:${erasure_id}:1`);
    const approver = `config:${read.rev_hash ?? 'default'}`;
    const approved = ErasureDecidedPayload.parse({
      erasure_id,
      by: approver,
      reason: requested.reason,
      matter_ref: null,
      entry_id,
      at,
    });
    const targets = requested.targets;
    const r = await recordAudit(d, {
      lock: HOLDS_LOCK,
      stream: auditErasureStream(erasure_id),
      events: [
        {
          type: AUDIT_SERVICE_EVENT.erasure_requested,
          body: requested as never,
          key: `requested:${erasure_id}`,
        },
        { type: AUDIT_SERVICE_EVENT.erasure_approved, body: approved as never, key: 'approved:1' },
      ],
      draft: erasureDraft(
        d,
        entry_id,
        null,
        at,
        {
          erasure_id,
          basis: 'retention',
          subject: null,
          requested_by: 'system.audit',
          reason: requested.reason,
          targets,
        },
        { approved_by: approver, retention: requested.retention },
      ),
      check: async (tx) => {
        const now2 = await heldBy(tx, targets);
        return now2.length === 0
          ? ok(undefined)
          : err(
              auditError(
                'legal_hold',
                'a hold was placed during the sweep: the next sweep retries',
              ),
            );
      },
    });
    if (!r.ok) return err(auditError(r.error.code, textOf(r.error)));
  }
  const swept = RetentionSweptPayload.parse({
    class: 'conversation_payload',
    days,
    rev_hash: read.rev_hash,
    due: due.length,
    held,
    erasure_id,
    at,
  });
  await recordAudit(d, {
    lock: 'retention',
    stream: AUDIT_RETENTION_STREAM,
    events: [
      { type: AUDIT_SERVICE_EVENT.retention_swept, body: swept as never, key: `swept:${at}` },
    ],
  });
  if (erasure_id) await executeErasure(d, erasure_id);
  return ok({ due: due.length, held, erasure_id });
}
