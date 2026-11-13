import type { PlannedUnit } from '@aisdlc/contracts';
import type { Tx } from '@aisdlc/record';

export interface PlanOfUnits {
  readonly item_id: string;
  readonly project_id: string;
  readonly repo: string;
  readonly plan_sha256: string;
  /** `null` for a Unit no plan made (M13.1: the implicit Unit of an item with no S5). */
  readonly base_sha: string | null;
  readonly units: readonly PlannedUnit[];
}

/** The unit id the rest of the system uses. */
export const unitIdOf = (itemId: string, unitKey: string): string => `${itemId}:${unitKey}`;

/**
 * A Unit the item's re-plan retired: its newest grant was released `replanned` (a back-edge sent the item back to
 * planning, `syncUnits`). A plan's Unit of the same key re-plans it under the same id: the row goes back to
 * `Planned` with the plan's fields, its lease (and so its epoch) kept, and 6.0 admits it again at a higher epoch.
 */
const RETIRED_BY_REPLAN = `core.unit.state = 'GrantReleased' AND (
    SELECT g.release_cause FROM core.admission_grant g
     WHERE g.unit_id = core.unit.unit_id ORDER BY g.lease_epoch DESC LIMIT 1
  ) = 'replanned'`;

/**
 * Folds one plan into the rows (inside a transaction that holds the planning lock): the item's Units that are
 * still `Planned` are replaced by the plan's, and so is a Unit a re-plan retired (`RETIRED_BY_REPLAN`); any other
 * Unit that has moved on is never touched. A function of the rows the earlier events made: `rebuildUnits` folds
 * the same.
 */
export async function foldPlan(tx: Tx, p: PlanOfUnits, plannedAt: Date): Promise<void> {
  await tx.query(`DELETE FROM core.unit WHERE item_id = $1 AND state = 'Planned'`, [p.item_id]);
  for (const u of p.units) {
    await tx.query(
      `INSERT INTO core.unit
         (item_id, unit_key, unit_id, project_id, repo, title, paths, size, depends_on, position,
          envelope, state, plan_sha256, base_sha, planned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,'Planned',$12,$13,$14)
       ON CONFLICT (item_id, unit_key) DO UPDATE
          SET title = EXCLUDED.title, paths = EXCLUDED.paths, size = EXCLUDED.size,
              depends_on = EXCLUDED.depends_on, position = EXCLUDED.position, envelope = EXCLUDED.envelope,
              state = 'Planned', plan_sha256 = EXCLUDED.plan_sha256, base_sha = EXCLUDED.base_sha,
              planned_at = EXCLUDED.planned_at
        WHERE ${RETIRED_BY_REPLAN}`,
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
