import {
  PLANNING_EVENT,
  UNITS_SCHEMA_ID,
  Unit,
  UnitsPlannedPayload,
  planningStream,
} from '@aisdlc/contracts';
import { ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';
import type { CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { PLANNING_ACTOR } from './store.js';
import { foldPlan, type PlanOfUnits } from './unit-fold.js';

// The `unit` read model (PLAN M12.4; DM §6.4). The authority is the `units.planned` event of a plan; the rows
// of `core.unit` are folded from it in the same transaction and can be rebuilt from the events alone.

export { unitIdOf, type PlanOfUnits } from './unit-fold.js';

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
    // a redelivered plan (the same hash) is the same event: the rows are folded again to the same state. The time folded
    // is the event's own (`planned_at`), as `rebuildUnits` folds it: a clock read here would make the live row differ
    // from the one rebuilt from the record (the restore drill found it)
    const at = e.value.events[0]?.occurred_at;
    await foldPlan(tx, p, at === undefined ? now : new Date(at));
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
  base_sha: string | null;
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

export { rebuildUnits } from '../admission/fold.js';
