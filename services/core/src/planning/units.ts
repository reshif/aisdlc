import {
  PLANNING_EVENT,
  UNITS_SCHEMA_ID,
  Unit,
  UnitsPlannedPayload,
  planningStream,
  type PlannedUnit,
} from '@aisdlc/contracts';
import { ok, type Result } from '@aisdlc/kernel';
import type { Tx } from '@aisdlc/record';
import type pg from 'pg';
import type { CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { PLANNING_ACTOR } from './store.js';

// The `unit` read model (PLAN M12.4; DM §6.4). The authority is the `units.planned` event of a plan; the rows
// of `core.unit` are folded from it in the same transaction and can be rebuilt from the events alone.

export interface PlanOfUnits {
  readonly item_id: string;
  readonly project_id: string;
  readonly repo: string;
  readonly plan_sha256: string;
  readonly base_sha: string;
  readonly units: readonly PlannedUnit[];
}

/** The unit id the rest of the system uses. */
export const unitIdOf = (itemId: string, unitKey: string): string => `${itemId}:${unitKey}`;

/**
 * Folds one plan into the rows (inside a transaction that holds the planning lock): the item's Units that are
 * still `Planned` are replaced by the plan's; a Unit that has moved on is never touched.
 */
async function foldPlan(tx: Tx, p: PlanOfUnits, plannedAt: Date): Promise<void> {
  await tx.query(`DELETE FROM core.unit WHERE item_id = $1 AND state = 'Planned'`, [p.item_id]);
  for (const u of p.units) {
    await tx.query(
      `INSERT INTO core.unit
         (item_id, unit_key, unit_id, project_id, repo, title, paths, size, depends_on, position,
          envelope, state, plan_sha256, base_sha, planned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,'Planned',$12,$13,$14)
       ON CONFLICT (item_id, unit_key) DO NOTHING`,
      [
        p.item_id,
        u.unit_key,
        unitIdOf(p.item_id, u.unit_key),
        p.project_id,
        p.repo,
        u.title,
        JSON.stringify(u.paths),
        u.size,
        JSON.stringify(u.depends_on),
        u.position,
        JSON.stringify(u.envelope),
        p.plan_sha256,
        p.base_sha,
        plannedAt,
      ],
    );
  }
}

/** Records the plan's Units (the event) and folds them into `core.unit`, once per (item, plan). */
export async function planUnits(d: CoreDeps, p: PlanOfUnits): Promise<Result<void, CoreError>> {
  const now = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [`planning:${p.item_id}`]);
    const body = UnitsPlannedPayload.parse({
      schema: UNITS_SCHEMA_ID,
      item_id: p.item_id,
      project_id: p.project_id,
      repo: p.repo,
      plan_sha256: p.plan_sha256,
      base_sha: p.base_sha,
      units: p.units,
    });
    const e = await j.emitAll(planningStream(p.item_id), [
      {
        type: PLANNING_EVENT.units_planned,
        body: body as unknown as Record<string, unknown>,
        actor: PLANNING_ACTOR,
        idempotency_key: `units.planned:${p.item_id}:${p.plan_sha256}`,
      },
    ]);
    if (!e.ok) return e;
    // a redelivered plan (the same hash) is the same event: the rows are folded again to the same state
    await foldPlan(tx, p, now);
    return ok(undefined);
  });
}

interface Row {
  item_id: string;
  unit_id: string;
  project_id: string;
  repo: string;
  unit_key: string;
  title: string;
  paths: string[];
  size: string;
  depends_on: string[];
  position: number;
  envelope: unknown;
  state: string;
  plan_sha256: string;
  base_sha: string;
  branch: string | null;
  lease_epoch: number | null;
  head_sha: string | null;
  pr_ref: string | null;
}

/** The Units of an item in DAG order. */
export async function listUnits(pool: pg.Pool, itemId: string): Promise<Unit[]> {
  const q = await pool.query<Row>(
    `SELECT item_id, unit_id, project_id, repo, unit_key, title, paths, size, depends_on, position,
            envelope, state, plan_sha256, base_sha, branch, lease_epoch, head_sha, pr_ref
       FROM core.unit WHERE item_id = $1 ORDER BY position, unit_key`,
    [itemId],
  );
  return q.rows.map((r) => Unit.parse(r));
}

/**
 * Rebuilds an item's rows from its `units.planned` events: the read model is derived, never authoritative.
 * Only the latest plan's Units are `Planned` rows (a plan replaces the one before it).
 */
export async function rebuildUnits(d: CoreDeps, itemId: string): Promise<number> {
  const ev = await d.pool.query<{ body: unknown; occurred_at: Date }>(
    `SELECT body, occurred_at FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [planningStream(itemId), PLANNING_EVENT.units_planned],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [`planning:${itemId}`]);
    await tx.query('DELETE FROM core.unit WHERE item_id = $1', [itemId]);
    for (const e of ev.rows) {
      const p = UnitsPlannedPayload.parse(e.body);
      await foldPlan(tx, p, e.occurred_at);
    }
    return ok(ev.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}
