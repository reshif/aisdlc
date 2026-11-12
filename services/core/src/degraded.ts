import {
  CONTROL_EVENT,
  healthViewOf,
  serviceTileId,
  type DegradedView,
  type ReadModelFreshness,
} from '@aisdlc/contracts';
import { readCheckpoint, runProjection, type Projection } from '@aisdlc/record';
import type pg from 'pg';
import { floorProjection } from './floor.js';
import { floorKillOf, sessionActivityProjection, type KillVerdictPort } from './floor-live.js';
import { readHealthSnapshots } from './health.js';
import { workItemProjection } from './work-projection.js';

// The degraded states a screen states first (PLAN M19; portal coverage §4): the kill switch unreachable is killed
// (AR9) on every screen that shows work, the Notary down says decisions fail closed and operator actions wait for the
// backfill, and a read model that cannot catch up says the screen may be behind. Read-only; every failure to find
// out reads as the degraded state, never as healthy.

/** The read models the work screens are served from (the item page, the inbox, the floor). */
const READ_MODELS: ReadonlyArray<{ name: string; projection: Projection }> = [
  { name: 'work_item', projection: workItemProjection },
  { name: 'floor', projection: floorProjection },
  { name: 'session_activity', projection: sessionActivityProjection },
];

async function headSeq(pool: pg.Pool): Promise<number> {
  const q = await pool.query<{ head: string }>(
    'SELECT COALESCE(max(global_seq), 0)::text AS head FROM record.record_event',
  );
  return Number(q.rows[0]?.head ?? 0);
}

/** Each read model, caught up now if it can be; one that cannot is `stale` with the reason. */
export async function readModelFreshness(pool: pg.Pool): Promise<ReadModelFreshness[]> {
  const out: ReadModelFreshness[] = [];
  for (const m of READ_MODELS) {
    let reason: string | null = null;
    try {
      const r = await runProjection(pool, m.projection);
      if (!r.ok) reason = `the ${m.name} read model needs a rebuild`;
    } catch {
      reason = `the ${m.name} read model could not catch up with the record`;
    }
    let asOf = 0;
    let head = 0;
    try {
      const cp = await readCheckpoint(pool, m.projection.name);
      asOf = Number(cp?.last_global_seq ?? 0);
      head = await headSeq(pool);
    } catch {
      reason ??= `the ${m.name} read model could not be read`;
    }
    out.push({ name: m.name, as_of_seq: asOf, head_seq: head, stale: reason !== null, reason });
  }
  return out;
}

/** Operator actions executed and not yet ledgered (`ops.action` without its `ops.ledgered`). */
export async function pendingOpsActions(pool: pg.Pool): Promise<number> {
  const q = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM record.record_event a
      WHERE a.type = $1 AND a.stream LIKE 'ops_action:%'
        AND NOT EXISTS (SELECT 1 FROM record.record_event l WHERE l.stream = a.stream AND l.type = $2)`,
    [CONTROL_EVENT.action, CONTROL_EVENT.ledgered],
  );
  return Number(q.rows[0]?.n ?? 0);
}

export interface DegradedDeps {
  readonly pool: pg.Pool;
  readonly now: () => Date;
  /** core-worker's kill verdict; absent reads unreachable (killed). */
  readonly kill?: KillVerdictPort | undefined;
}

/** What the screens for these projects must say first. At most 50 projects. */
export async function readDegraded(
  d: DegradedDeps,
  projects: readonly string[],
): Promise<DegradedView> {
  const now = d.now();
  const kills = await Promise.all(
    [...new Set(projects)].slice(0, 50).map(async (project_id) => ({
      project_id,
      ...(await floorKillOf(d.kill, { project_id })),
    })),
  );
  let notary: DegradedView['notary'] = {
    state: 'unknown',
    detail_code: 'unreadable',
    as_of: null,
    pending_ops_actions: 0,
  };
  try {
    const tile = healthViewOf(await readHealthSnapshots(d.pool), now.getTime()).tiles.find(
      (t) => t.tile_id === serviceTileId('notary'),
    );
    notary = {
      state: tile?.state ?? 'unknown',
      detail_code: tile?.detail_code ?? 'no_report',
      as_of: tile?.as_of ?? null,
      pending_ops_actions: await pendingOpsActions(d.pool),
    };
  } catch {
    // unreadable stays unknown
  }
  return {
    as_of: now.toISOString(),
    kills,
    notary,
    read_models: await readModelFreshness(d.pool),
  };
}
