import { catalogueFor } from '@aisdlc/catalogue';
import {
  AUDIT_EVENT,
  AuditConsideredPayload,
  AuditResultRecordedPayload,
  CatalogueRef,
  MODE_E_LIFTED_EVENT,
  MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE,
  ModeELiftedPayload,
  ModeESuspendedPayload,
  auditStream,
  type AuditOutcome,
  type LedgerEntryDraft,
  type PrincipalId,
  type ProjectId,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION, type DecisionDeps } from '@aisdlc/decisions';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import type { LoopSpec } from '@aisdlc/loops';
import type { Executor, Tx } from '@aisdlc/record';
import { limitValue, modeESuspension } from '@aisdlc/work';
import { coreError, type CoreError } from '../errors.js';
import {
  clockOf,
  inCoreLedgerTx,
  inCoreTx,
  lockKeys,
  type CoreDeps,
  type Journal,
} from '../journal.js';
import { requestSpawn } from '../work-signals.js';
import { CLOSEOUT_ACTOR } from './record.js';

// 9.5 the mode-E audit sample and B19 (PLAN M15.4; FL "9.5 Mode-E audit sample, async", FIX 4 "audit is sampled and
// asynchronous, not on the closing chain", FIX 12 ">10% over ≥20 sampled suspends mode E"):
//
//   draw     `drawAuditSamples` (the `audit_sample` loop, never the item's chain) considers every close-out record whose
//            G4 was decided in mode E exactly once (`audit.considered` on `audit:<project>`): drawn when the first 32
//            bits of the close-out id are 0 modulo `sample_one_in`, deterministic and replayable. Mode C, or a G4 whose
//            mode is not in the record, is never sampled (a codeowner already read it).
//   audit    `recordAuditResult`: a person who holds the project's `g4` slot and neither decided that G4 nor requested
//            the item records `ok` or `gate_miss` (`audit.result_recorded`, with the project's counts after it). A miss
//            is B19: a NEW linked item (`audit_miss`) through the engine, which takes it after Done.
//   suspend  after each result, the pinned catalogue of the audited item says (through `@aisdlc/work`'s
//            `modeESuspension`, the one reader of B19's `miss_rate` and `min_sample`) whether the project's misses over
//            its audits trip B19; the first trip records `audit.mode_e_suspended` and a ledger entry in the same
//            transaction (the ledger lock first, the entry last). From then on G4 opens in mode C with
//            `mode_e_suspended` (`readModeESuspension`, an input of `decideReviewMode`).
//   lift     (M15.5) only a decided M5 lifts it (9.4 Learn, `closeout/learn.ts`): `audit.mode_e_lifted` ends the
//            suspension and starts a new audit window (`core.mode_e_window`: the epoch and the record position after
//            which audits count), so B19 is judged again on fresh evidence only.
//
// Every table is a fold of the `audit:<project>` stream (`rebuildAudits`).

export const AUDIT_SAMPLE_OBSERVER = 'audit_sample';
export const auditLockKey = (projectId: string): string => `audit:${projectId}`;

export interface AuditDeps extends CoreDeps {
  readonly ledger: LedgerClientDeps;
  /** Who holds the `g4` slot (the auditors). */
  readonly decisions: Pick<DecisionDeps, 'eligibility'>;
}

/** Whether a close-out id is drawn at one-in-`n` (deterministic: the first 32 bits of the id). */
export const drawn = (closeoutSha256: string, oneIn: number): boolean =>
  oneIn <= 1 || Number.parseInt(closeoutSha256.slice(0, 8), 16) % oneIn === 0;

// ---------------------------------------------------------------- read model

async function applyAuditEvent(
  tx: Tx,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type === AUDIT_EVENT.considered) {
    const p = AuditConsideredPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.audit_sample (item_id, project_id, closeout_sha256, g4_gate_instance_id, g4_deciders,
         requester, catalogue, sampled, considered_gseq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (item_id) DO NOTHING`,
      [
        p.item_id,
        p.project_id,
        p.closeout_sha256,
        p.g4_gate_instance_id,
        p.g4_deciders,
        p.requester,
        JSON.stringify(p.catalogue),
        p.sampled,
        e.global_seq,
      ],
    );
  } else if (e.type === AUDIT_EVENT.result_recorded) {
    const p = AuditResultRecordedPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.audit_sample SET outcome = $2, audited_by = $3, result_gseq = $4
        WHERE item_id = $1 AND outcome IS NULL`,
      [p.item_id, p.outcome, p.by, e.global_seq],
    );
  } else if (e.type === MODE_E_LIFTED_EVENT) {
    const p = ModeELiftedPayload.parse(e.payload);
    await tx.query('DELETE FROM core.mode_e_suspension WHERE project_id = $1', [p.project_id]);
    await tx.query(
      `INSERT INTO core.mode_e_window (project_id, epoch, since_gseq) VALUES ($1, 1, $2)
       ON CONFLICT (project_id) DO UPDATE SET epoch = core.mode_e_window.epoch + 1, since_gseq = EXCLUDED.since_gseq`,
      [p.project_id, e.global_seq],
    );
  } else if (e.type === AUDIT_EVENT.mode_e_suspended) {
    const p = ModeESuspendedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.mode_e_suspension (project_id, sampled, missed, detail, suspended_at, event_gseq)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project_id) DO NOTHING`,
      [p.project_id, p.sampled, p.missed, JSON.stringify(p), p.at, e.global_seq],
    );
  }
}

/** Derives a project's audit tables again from its `audit:<project>` events alone. */
export async function rebuildAudits(d: CoreDeps, projectId: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [auditStream(projectId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [auditLockKey(projectId)]);
    await tx.query('DELETE FROM core.audit_sample WHERE project_id = $1', [projectId]);
    await tx.query('DELETE FROM core.mode_e_suspension WHERE project_id = $1', [projectId]);
    await tx.query('DELETE FROM core.mode_e_window WHERE project_id = $1', [projectId]);
    for (const e of q.rows) {
      await applyAuditEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

export interface AuditSampleRow {
  readonly item_id: string;
  readonly project_id: string;
  readonly closeout_sha256: string;
  readonly g4_gate_instance_id: string;
  readonly g4_deciders: readonly string[];
  readonly requester: string;
  readonly catalogue: CatalogueRef;
  readonly sampled: boolean;
  readonly outcome: AuditOutcome | null;
  readonly audited_by: string | null;
}

export async function listAuditSamples(db: Executor, projectId: string): Promise<AuditSampleRow[]> {
  const q = await db.query<AuditSampleRow & { catalogue: unknown }>(
    `SELECT item_id::text, project_id, closeout_sha256, g4_gate_instance_id, g4_deciders, requester, catalogue,
            sampled, outcome, audited_by
       FROM core.audit_sample WHERE project_id = $1 ORDER BY considered_gseq`,
    [projectId],
  );
  return q.rows.map((r) => ({ ...r, catalogue: CatalogueRef.parse(r.catalogue) }));
}

/** The project's audit window: the lifts so far (`epoch`) and the record position after which audits count. */
export async function readAuditWindow(
  db: Executor,
  projectId: string,
): Promise<{ epoch: number; since_gseq: number }> {
  const q = await db.query<{ epoch: number; since_gseq: string }>(
    'SELECT epoch, since_gseq::text AS since_gseq FROM core.mode_e_window WHERE project_id = $1',
    [projectId],
  );
  const r = q.rows[0];
  return r ? { epoch: r.epoch, since_gseq: Number(r.since_gseq) } : { epoch: 0, since_gseq: 0 };
}

/** The suspension in force with its record position (what a lift binds), or `null`. */
export async function readSuspensionRow(
  db: Executor,
  projectId: string,
): Promise<{ gseq: number; sampled: number; missed: number } | null> {
  const q = await db.query<{ event_gseq: string; sampled: number; missed: number }>(
    'SELECT event_gseq::text AS event_gseq, sampled, missed FROM core.mode_e_suspension WHERE project_id = $1',
    [projectId],
  );
  const r = q.rows[0];
  return r ? { gseq: Number(r.event_gseq), sampled: r.sampled, missed: r.missed } : null;
}

/** Records a decided M5's lift (9.4) on the audit stream, in the caller's transaction (which holds the audit lock). */
export async function emitModeELifted(
  j: Journal,
  tx: Tx,
  p: ModeELiftedPayload,
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const e = await j.emitAll(auditStream(p.project_id), [
    {
      type: MODE_E_LIFTED_EVENT,
      body: p as unknown as Record<string, unknown>,
      actor: CLOSEOUT_ACTOR,
      idempotency_key: `audit:lifted:${p.project_id}:${p.suspension_gseq}`,
    },
  ]);
  if (!e.ok) return e;
  if (!e.value.duplicate) {
    await applyAuditEvent(tx, {
      type: MODE_E_LIFTED_EVENT,
      payload: p,
      global_seq: Number(e.value.events[0]?.global_seq ?? 0),
    });
  }
  return ok({ duplicate: e.value.duplicate });
}

/** B19 for a project: the suspension recorded, or `null` (mode E is not suspended). */
export async function readModeESuspension(
  db: Executor,
  projectId: string,
): Promise<ModeESuspendedPayload | null> {
  const q = await db.query<{ detail: unknown }>(
    'SELECT detail FROM core.mode_e_suspension WHERE project_id = $1',
    [projectId],
  );
  const r = q.rows[0];
  return r ? ModeESuspendedPayload.parse(r.detail) : null;
}

// ---------------------------------------------------------------- draw

/** Considers every mode-E close-out not considered yet, once (the `audit_sample` loop's tick). */
export async function drawAuditSamples(
  d: CoreDeps & { readonly sampleOneIn: number },
  o: { batch?: number } = {},
): Promise<Result<{ considered: number; sampled: number }, CoreError>> {
  if (!Number.isInteger(d.sampleOneIn) || d.sampleOneIn < 1) {
    return err(coreError('invalid_input', 'sample_one_in must be an integer of at least 1'));
  }
  const q = await d.pool.query<{
    item_id: string;
    project_id: string;
    closeout_sha256: string;
    record: {
      requester: string;
      catalogue: unknown;
      g4: { gate_instance_id: string; deciders: string[] } | null;
    };
  }>(
    `SELECT c.item_id::text, c.project_id, c.closeout_sha256, c.record FROM core.closeout c
      WHERE c.g4_mode = 'E' AND NOT EXISTS (SELECT 1 FROM core.audit_sample a WHERE a.item_id = c.item_id)
      ORDER BY c.event_gseq LIMIT $1`,
    [o.batch ?? 50],
  );
  let sampled = 0;
  for (const r of q.rows) {
    const g4 = r.record.g4;
    if (g4 === null) continue;
    const payload = AuditConsideredPayload.parse({
      item_id: r.item_id,
      project_id: r.project_id,
      closeout_sha256: r.closeout_sha256,
      g4_gate_instance_id: g4.gate_instance_id,
      g4_deciders: g4.deciders,
      requester: r.record.requester,
      catalogue: r.record.catalogue,
      sample_one_in: d.sampleOneIn,
      sampled: drawn(r.closeout_sha256, d.sampleOneIn),
      at: clockOf(d).now().toISOString(),
    });
    const w = await inCoreTx(d, async (j, tx) => {
      await lockKeys(tx, [auditLockKey(r.project_id)]);
      const e = await j.emitAll(auditStream(r.project_id), [
        {
          type: AUDIT_EVENT.considered,
          body: payload as unknown as Record<string, unknown>,
          actor: CLOSEOUT_ACTOR,
          idempotency_key: `audit:considered:${r.item_id}`,
        },
      ]);
      if (!e.ok) return e;
      if (!e.value.duplicate) {
        await applyAuditEvent(tx, {
          type: AUDIT_EVENT.considered,
          payload,
          global_seq: Number(e.value.events[0]?.global_seq ?? 0),
        });
      }
      return ok(undefined);
    });
    if (!w.ok) return w;
    if (payload.sampled) sampled += 1;
  }
  return ok({ considered: q.rows.length, sampled });
}

/** `audit_sample`: draws the mode-E audit sample, off the closing chain. */
export function auditSampleLoop(
  d: CoreDeps & { readonly sampleOneIn: number },
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 30_000;
  return {
    name: AUDIT_SAMPLE_OBSERVER,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const r = await drawAuditSamples(d);
      if (!r.ok) throw new Error(r.error.message);
      return { ok: r.value.sampled, failed: 0 };
    },
  };
}

// ---------------------------------------------------------------- audit result, B19

export interface AuditResultInput {
  readonly item_id: string;
  readonly by: string;
  readonly outcome: AuditOutcome;
  readonly reason_code: string;
}

/**
 * Records a person's audit of one drawn mode-E merge; a miss asks for B19's NEW item, and the project's counts are
 * checked against the audited item's pinned catalogue. Refused (nothing written): not drawn, already audited, an
 * auditor who does not hold `g4`, decided that G4 or requested the item, an unreadable slot or catalogue.
 */
export async function recordAuditResult(
  d: AuditDeps,
  r: AuditResultInput,
): Promise<Result<{ sampled: number; missed: number; suspended: boolean }, CoreError>> {
  const q = await d.pool.query<{ project_id: string }>(
    'SELECT project_id FROM core.audit_sample WHERE item_id = $1',
    [r.item_id],
  );
  const project = q.rows[0]?.project_id;
  if (project === undefined) {
    return err(coreError('not_found', `no audit sample for item ${r.item_id}`));
  }
  const sample = (await listAuditSamples(d.pool, project)).find((x) => x.item_id === r.item_id);
  if (!sample?.sampled) return err(coreError('conflict', 'this merge was not drawn for the audit'));
  if (sample.outcome !== null) {
    // a retry after a miss whose spawn did not get through asks for it again (idempotent by key)
    if (sample.outcome === 'gate_miss' && sample.audited_by === r.by) {
      const s = await spawnB19(d, sample);
      if (!s.ok) return s;
    }
    return err(coreError('conflict', 'this sample is already audited'));
  }
  if (sample.g4_deciders.includes(r.by)) {
    return err(coreError('forbidden', 'the G4 approver does not audit their own decision'));
  }
  if (sample.requester === r.by) {
    return err(coreError('forbidden', 'the requester does not audit their own item'));
  }
  const holders = await d.decisions.eligibility.holders(project as ProjectId, 'g4');
  if (!holders.ok) return err(coreError('unavailable', holders.error.message));
  if (!holders.value.includes(r.by as PrincipalId)) {
    return err(coreError('forbidden', `${r.by} does not hold the g4 slot of ${project}`));
  }
  const cat = catalogueFor(sample.catalogue);
  if (!cat.ok) return err(coreError('unavailable', `catalogue ${sample.catalogue.version}`));

  const now = clockOf(d).now().toISOString();
  const w = await inCoreLedgerTx(d, async (j, tx) => {
    await lockKeys(tx, [auditLockKey(project)]);
    // the ledger lock before the first record append (a trip writes a ledger entry last)
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, d.ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    // M15.5: only the audits of the current window count (a decided M5 lift starts a new one)
    const win = await readAuditWindow(tx, project);
    const counts = await tx.query<{ sampled: string; missed: string }>(
      `SELECT count(*)::text AS sampled, count(*) FILTER (WHERE outcome = 'gate_miss')::text AS missed
         FROM core.audit_sample WHERE project_id = $1 AND outcome IS NOT NULL AND result_gseq > $2`,
      [project, win.since_gseq],
    );
    const sampled = Number(counts.rows[0]?.sampled ?? 0) + 1;
    const missed = Number(counts.rows[0]?.missed ?? 0) + (r.outcome === 'gate_miss' ? 1 : 0);
    const result = AuditResultRecordedPayload.safeParse({
      item_id: r.item_id,
      project_id: project,
      outcome: r.outcome,
      by: r.by,
      reason_code: r.reason_code,
      sampled,
      missed,
      at: now,
    });
    if (!result.success) return err(coreError('invalid_input', result.error.message));
    const e = await j.emitAll(auditStream(project), [
      {
        type: AUDIT_EVENT.result_recorded,
        body: result.data as unknown as Record<string, unknown>,
        actor: r.by,
        idempotency_key: `audit:result:${r.item_id}`,
      },
    ]);
    if (!e.ok) return e;
    await applyAuditEvent(tx, {
      type: AUDIT_EVENT.result_recorded,
      payload: result.data,
      global_seq: Number(e.value.events[0]?.global_seq ?? 0),
    });
    // B19, from the audited item's pinned catalogue (never a number written here)
    const trips = modeESuspension(cat.value, { sampled, missed });
    const already = await tx.query('SELECT 1 FROM core.mode_e_suspension WHERE project_id = $1', [
      project,
    ]);
    if (!trips || already.rows.length > 0) {
      return ok({ value: { sampled, missed, suspended: already.rows.length > 0 }, pending });
    }
    const sus = ModeESuspendedPayload.parse({
      project_id: project,
      sampled,
      missed,
      limits: {
        miss_rate: limitValue(cat.value, 'B19', 'miss_rate'),
        min_sample: limitValue(cat.value, 'B19', 'min_sample'),
      },
      catalogue: sample.catalogue,
      item_id: r.item_id,
      at: now,
    });
    const s = await j.emitAll(auditStream(project), [
      {
        type: AUDIT_EVENT.mode_e_suspended,
        body: sus as unknown as Record<string, unknown>,
        actor: CLOSEOUT_ACTOR,
        idempotency_key:
          win.epoch === 0
            ? `audit:suspended:${project}`
            : `audit:suspended:${project}:${win.epoch}`,
      },
    ]);
    if (!s.ok) return s;
    await applyAuditEvent(tx, {
      type: AUDIT_EVENT.mode_e_suspended,
      payload: sus,
      global_seq: Number(s.value.events[0]?.global_seq ?? 0),
    });
    const draft: LedgerEntryDraft = {
      entry_id: deterministicId<'LedgerEntry'>(
        win.epoch === 0
          ? `audit.mode_e_suspended:${project}`
          : `audit.mode_e_suspended:${project}:${win.epoch}`,
      ),
      entry_type: MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      subject_hash: null,
      decision: null,
      actor: null,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: 'mode_e_suspended', ...sus } as never,
      created_at: now as never,
    };
    const l = await appendLedgerEntryTx(tx, d.ledger, draft);
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({ value: { sampled, missed, suspended: true }, pending });
  });
  if (!w.ok) return w;
  if (r.outcome === 'gate_miss') {
    const s = await spawnB19(d, { ...sample, audited_by: r.by });
    if (!s.ok) return s;
  }
  return ok(w.value);
}

/** B19's NEW linked item on the audited (Done) item, once per sample. */
async function spawnB19(d: CoreDeps, s: AuditSampleRow) {
  const lane = await d.pool.query<{ lane: string }>(
    "SELECT record ->> 'lane' AS lane FROM core.closeout WHERE item_id = $1",
    [s.item_id],
  );
  const r = await requestSpawn(d, s.item_id, {
    edge: 'B19',
    kind: 'audit_miss',
    lane: (lane.rows[0]?.lane ?? 'L1') as never,
    key: s.item_id,
    by: s.audited_by ?? CLOSEOUT_ACTOR,
  });
  return r.ok ? ok(undefined) : r;
}
