import {
  PLANNING_EVENT,
  UNIT_EVENT,
  UnitAdmittedPayload,
  UnitGrantReleasedPayload,
  UnitLeaseChangedPayload,
  UnitStateChangedPayload,
  UnitWaitEnteredPayload,
  UnitsPlannedPayload,
  canTransitionUnit,
  planningStream,
  unitBranchOf,
  unitStream,
  UnitState,
} from '@aisdlc/contracts';
import { ok } from '@aisdlc/kernel';
import type { Tx } from '@aisdlc/record';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { foldPlan } from '../planning/unit-fold.js';

// The Unit, Lease and AdmissionGrant read models (PLAN M13.1). One fold, used twice: by the transaction that
// writes an event (so the rows are never behind the record) and by `rebuildUnits`, which replays an item's
// `units.planned` and `unit.*` events in record order into empty tables. A rebuilt table equals the live one.

/** The states of a Unit with a branch and an open PR, before the merge: a re-plan keeps them (`Planned` again). */
export const PUSHED_BEFORE_MERGE: readonly UnitState[] = UnitState.extract([
  'Pushed',
  'Verifying',
  'InReview',
]).options;

/** The two lock keys of an item's Unit model: serialise every writer of its rows. */
export const unitLockKey = (itemId: string): string => `planning:${itemId}`;

export interface FoldedEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly occurred_at: string;
  readonly global_seq: number;
}

const iso = (s: string): Date => new Date(s);

async function appendHistory(
  tx: Tx,
  unitId: string,
  h: {
    epoch: number;
    holder_kind: string;
    holder_ref: string | null;
    status: string;
    cause: string;
    at: Date;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO core.lease_history (unit_id, n, epoch, holder_kind, holder_ref, status, cause, at)
     SELECT $1, COALESCE(max(n), 0) + 1, $2, $3, $4, $5, $6, $7 FROM core.lease_history WHERE unit_id = $1`,
    [unitId, h.epoch, h.holder_kind, h.holder_ref, h.status, h.cause, h.at],
  );
}

async function setLease(
  tx: Tx,
  p: {
    unit_id: string;
    item_id: string;
    branch: string;
    epoch: number;
    holder_kind: string;
    holder_ref: string | null;
    status: string;
    cause: string;
  },
  at: Date,
  gseq: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO core.lease (unit_id, item_id, branch, epoch, holder_kind, holder_ref, status, changed_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (unit_id) DO UPDATE
        SET epoch = EXCLUDED.epoch, holder_kind = EXCLUDED.holder_kind, holder_ref = EXCLUDED.holder_ref,
            status = EXCLUDED.status, changed_at = EXCLUDED.changed_at, event_gseq = EXCLUDED.event_gseq`,
    [p.unit_id, p.item_id, p.branch, p.epoch, p.holder_kind, p.holder_ref, p.status, at, gseq],
  );
  // the Unit reads its epoch from the lease: one owner, one value
  await tx.query('UPDATE core.unit SET lease_epoch = $2, branch = $3 WHERE unit_id = $1', [
    p.unit_id,
    p.epoch,
    p.branch,
  ]);
  await appendHistory(tx, p.unit_id, { ...p, at });
}

async function stateOf(tx: Tx, unitId: string): Promise<UnitState | null> {
  const q = await tx.query<{ state: UnitState }>('SELECT state FROM core.unit WHERE unit_id = $1', [
    unitId,
  ]);
  return q.rows[0]?.state ?? null;
}

async function moveUnit(tx: Tx, unitId: string, to: UnitState): Promise<void> {
  const from = await stateOf(tx, unitId);
  if (from === null || from === to) return;
  // a transition the table does not draw is not applied (a writer checks first; a replay stays safe)
  if (!canTransitionUnit(from, to)) return;
  await tx.query('UPDATE core.unit SET state = $2 WHERE unit_id = $1', [unitId, to]);
}

/** Folds one `unit.*` event into the rows. Idempotent per event only in the sense of replay: callers apply each once. */
export async function applyUnitEvent(tx: Tx, e: FoldedEvent): Promise<void> {
  const at = iso(e.occurred_at);
  switch (e.type) {
    case UNIT_EVENT.admitted: {
      const p = UnitAdmittedPayload.parse(e.payload);
      if ((await stateOf(tx, p.unit_id)) === null) return; // a Unit no plan made: nothing to admit
      if (p.resumes === null) await moveUnit(tx, p.unit_id, 'Admitted');
      let pausedMs = 0;
      if (p.resumes !== null) {
        const old = await tx.query<{ paused_ms: string; paused_since: Date | null }>(
          'SELECT paused_ms, paused_since FROM core.admission_grant WHERE grant_id = $1',
          [p.resumes.grant_id],
        );
        const o = old.rows[0];
        pausedMs =
          Number(o?.paused_ms ?? 0) +
          (o?.paused_since ? at.getTime() - o.paused_since.getTime() : 0);
        await tx.query(
          `UPDATE core.admission_grant
              SET status = 'released', release_cause = 'readmitted', released_at = $2, paused_since = NULL, paused_ms = $3
            WHERE grant_id = $1`,
          [p.resumes.grant_id, at, pausedMs],
        );
      }
      await tx.query(
        `INSERT INTO core.admission_grant
           (grant_id, item_id, unit_id, project_id, lease_epoch, slot, envelope, status, granted_at, paused_ms, resumes_grant_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active',$8,$9,$10)
         ON CONFLICT (grant_id) DO NOTHING`,
        [
          p.grant_id,
          p.item_id,
          p.unit_id,
          p.project_id,
          p.lease_epoch,
          JSON.stringify(p.slot),
          JSON.stringify(p.envelope),
          at,
          pausedMs,
          p.resumes?.grant_id ?? null,
        ],
      );
      await setLease(
        tx,
        {
          unit_id: p.unit_id,
          item_id: p.item_id,
          branch: p.branch,
          epoch: p.lease_epoch,
          holder_kind: 'agent',
          holder_ref: null,
          status: 'held',
          cause: p.resumes === null ? 'admitted' : 'readmitted',
        },
        at,
        e.global_seq,
      );
      return;
    }
    case UNIT_EVENT.lease_changed: {
      const p = UnitLeaseChangedPayload.parse(e.payload);
      const u = await tx.query<{ unit_key: string }>(
        'SELECT unit_key FROM core.unit WHERE unit_id = $1',
        [p.unit_id],
      );
      const key = u.rows[0]?.unit_key;
      if (key === undefined) return;
      await setLease(
        tx,
        {
          unit_id: p.unit_id,
          item_id: p.item_id,
          branch: unitBranchOf(p.item_id, key),
          epoch: p.lease_epoch,
          holder_kind: p.holder_kind,
          holder_ref: p.holder_ref,
          status: p.status,
          cause: p.cause,
        },
        at,
        e.global_seq,
      );
      // DM §6.4: a developer takes the lease of a Unit that is building
      if (p.holder_kind === 'human' && p.status === 'held')
        await moveUnit(tx, p.unit_id, 'HumanHeld');
      return;
    }
    case UNIT_EVENT.grant_released: {
      const p = UnitGrantReleasedPayload.parse(e.payload);
      await tx.query(
        `UPDATE core.admission_grant
            SET status = 'released', release_cause = $2, released_at = $3,
                paused_ms = paused_ms + COALESCE((EXTRACT(EPOCH FROM ($3 - paused_since)) * 1000)::bigint, 0),
                paused_since = NULL
          WHERE grant_id = $1 AND status <> 'released'`,
        [p.grant_id, p.cause, at],
      );
      // B11 after 6.6 (owner decision 2026-11-13): a Unit with a branch and an open PR goes back to `Planned` and keeps
      // them (head, PR, lease and epoch); the next plan re-plans it in place and 6.0 admits it again at a higher epoch.
      // Any other Unit is retired (`GrantReleased`) and re-planned by the next plan under its id (`foldPlan`).
      const from = await stateOf(tx, p.unit_id);
      if (p.cause === 'replanned' && from !== null && PUSHED_BEFORE_MERGE.includes(from)) {
        await moveUnit(tx, p.unit_id, 'Planned');
      } else {
        await moveUnit(tx, p.unit_id, 'GrantReleased');
      }
      return;
    }
    case UNIT_EVENT.wait_entered: {
      const p = UnitWaitEnteredPayload.parse(e.payload);
      await tx.query(
        `UPDATE core.admission_grant SET status = 'waiting', snapshot_ref = $2, paused_since = $3 WHERE grant_id = $1`,
        [p.grant_id, p.snapshot_ref, at],
      );
      const u = await tx.query<{ unit_key: string }>(
        'SELECT unit_key FROM core.unit WHERE unit_id = $1',
        [p.unit_id],
      );
      const key = u.rows[0]?.unit_key;
      if (key === undefined) return;
      // the lease is released; its epoch stays (the next holder's is higher)
      await setLease(
        tx,
        {
          unit_id: p.unit_id,
          item_id: p.item_id,
          branch: unitBranchOf(p.item_id, key),
          epoch: p.lease_epoch,
          holder_kind: 'agent',
          holder_ref: null,
          status: 'released',
          cause: 'human_wait',
        },
        at,
        e.global_seq,
      );
      return;
    }
    case UNIT_EVENT.state_changed: {
      const p = UnitStateChangedPayload.parse(e.payload);
      await moveUnit(tx, p.unit_id, p.to);
      if (p.head_sha !== undefined) {
        await tx.query('UPDATE core.unit SET head_sha = $2 WHERE unit_id = $1', [
          p.unit_id,
          p.head_sha,
        ]);
      }
      if (p.pr_ref !== undefined) {
        await tx.query('UPDATE core.unit SET pr_ref = $2 WHERE unit_id = $1', [
          p.unit_id,
          p.pr_ref,
        ]);
      }
      return;
    }
  }
}

/**
 * Rebuilds an item's Unit, Lease and AdmissionGrant rows from its events alone: the plan's `units.planned`
 * (planning stream) and every `unit.*` event, in the order they were recorded. Returns how many plans it
 * folded. The tables are derived, never authoritative.
 */
export async function rebuildUnits(d: CoreDeps, itemId: string): Promise<number> {
  const q = await d.pool.query<{
    type: string;
    body: unknown;
    occurred_at: Date;
    global_seq: string;
  }>(
    `SELECT type, body, occurred_at, global_seq::text AS global_seq FROM record.record_event
      WHERE (stream = $1 AND type = $2) OR stream = $3
      ORDER BY record_event.global_seq`,
    [planningStream(itemId), PLANNING_EVENT.units_planned, unitStream(itemId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [unitLockKey(itemId)]);
    await tx.query('DELETE FROM core.lease_history WHERE unit_id LIKE $1', [`${itemId}:%`]);
    await tx.query('DELETE FROM core.admission_grant WHERE item_id = $1', [itemId]);
    await tx.query('DELETE FROM core.unit WHERE item_id = $1', [itemId]);
    let plans = 0;
    for (const e of q.rows) {
      if (e.type === PLANNING_EVENT.units_planned) {
        await foldPlan(tx, UnitsPlannedPayload.parse(e.body), e.occurred_at);
        plans += 1;
      } else {
        await applyUnitEvent(tx, {
          type: e.type,
          payload: e.body,
          occurred_at: e.occurred_at.toISOString(),
          global_seq: Number(e.global_seq),
        });
      }
    }
    return ok(plans);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}
