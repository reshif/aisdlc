import {
  ProjectId,
  configLineageKey,
  type ConfigLineage,
  type LedgerEntryId,
} from '@aisdlc/contracts';
import { configProjection, loadEffective, type ConfigRegistry } from '@aisdlc/config';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import { runProjection } from '@aisdlc/record';
import type pg from 'pg';
import type { RoleMapReconcilerPort } from './clients.js';

// Publishing a project's settings makes identity bind its role map (PLAN M7.1, the follow-up from
// M4.4). CHOSEN: a core-worker loop that watches the published project-layer revisions, not a hook
// in `config_publish`:
//   - `config_publish` is the M1 gate's act and writes one record event; making it call identity
//     would put an HTTP call to another service inside (or just after) that decision, and a publish
//     whose reconcile failed could not be told from one that never needed it;
//   - the loop is retry-safe by construction: `core.role_map_sync` records the revision identity
//     acknowledged, written only after identity answered, so a failed call leaves the revision
//     pending and the next tick tries again (identity's reconcile is idempotent, so a repeat after
//     a crash between the answer and the row writes nothing);
//   - it is eventually consistent with a bounded lag (the interval), like every other loop of
//     core-worker, and a project whose reconcile keeps failing shows as a failing item of the
//     `role_map_sync` loop (health, metrics) without stopping the other projects.
// Only a revision the ledger vouches for counts: `loadEffective` joins each published row to the M1
// decision entry for exactly that hash.

export interface RoleMapSyncDeps {
  readonly pool: pg.Pool;
  readonly registry?: ConfigRegistry;
  readonly reconciler: RoleMapReconcilerPort;
  readonly clock?: Clock;
}

export interface PendingRoleMap {
  readonly project: ProjectId;
  readonly rev_hash: string;
  readonly ledger_entry_id: LedgerEntryId;
}

const PREFIX = 'project:project:';
const lineageOf = (project: string): ConfigLineage => ({
  layer: 'project',
  scope: { kind: 'project', ref: project },
});

/** The projects whose effective settings revision is not the one identity last acknowledged. */
export async function pendingRoleMaps(d: RoleMapSyncDeps): Promise<PendingRoleMap[]> {
  const caught = await runProjection(d.pool, configProjection);
  if (!caught.ok) throw new Error('the config read model needs a rebuild');
  const lineages = await d.pool.query<{ lineage: string }>(
    `SELECT DISTINCT lineage FROM config.config_published WHERE starts_with(lineage, $1) ORDER BY lineage`,
    [PREFIX],
  );
  const out: PendingRoleMap[] = [];
  for (const { lineage } of lineages.rows) {
    const project = ProjectId.safeParse(lineage.slice(PREFIX.length));
    if (!project.success || configLineageKey(lineageOf(project.data)) !== lineage) continue;
    const eff = await loadEffective(d.pool, lineageOf(project.data));
    if (!eff) continue;
    const done = await d.pool.query<{ rev_hash: string }>(
      'SELECT rev_hash FROM core.role_map_sync WHERE project_id = $1',
      [project.data],
    );
    if (done.rows[0]?.rev_hash === eff.rev_hash) continue;
    const pub = await d.pool.query<{ ledger_entry_id: string }>(
      'SELECT ledger_entry_id FROM config.config_published WHERE rev_hash = $1',
      [eff.rev_hash],
    );
    const entry = pub.rows[0]?.ledger_entry_id;
    if (!entry) continue;
    out.push({
      project: project.data,
      rev_hash: eff.rev_hash,
      ledger_entry_id: entry as LedgerEntryId,
    });
  }
  return out;
}

/** Tells identity about one revision and, only once it answered, remembers that it did. Throws on a failure. */
export async function syncRoleMap(d: RoleMapSyncDeps, p: PendingRoleMap): Promise<void> {
  const r = await d.reconciler.reconcile(p.project, {
    config_rev: p.rev_hash,
    m_gate_ref: p.ledger_entry_id,
  });
  if (!r.ok)
    throw new Error(`identity reconcile of ${p.project}: ${r.error.kind}: ${r.error.message}`);
  await d.pool.query(
    `INSERT INTO core.role_map_sync (project_id, rev_hash, ledger_entry_id, reconciled_at, report)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (project_id) DO UPDATE SET rev_hash = EXCLUDED.rev_hash,
       ledger_entry_id = EXCLUDED.ledger_entry_id, reconciled_at = EXCLUDED.reconciled_at,
       report = EXCLUDED.report`,
    [
      p.project,
      p.rev_hash,
      p.ledger_entry_id,
      (d.clock ?? systemClock).now(),
      JSON.stringify(r.value),
    ],
  );
}

export interface RoleMapSyncReport {
  readonly synced: readonly string[];
  readonly failed: ReadonlyArray<{ project: string; error: string }>;
}

/** One pass: every pending project, each on its own (one failing project does not stop the rest). */
export async function syncRoleMaps(d: RoleMapSyncDeps): Promise<RoleMapSyncReport> {
  const synced: string[] = [];
  const failed: Array<{ project: string; error: string }> = [];
  for (const p of await pendingRoleMaps(d)) {
    try {
      await syncRoleMap(d, p);
      synced.push(p.project);
    } catch (e) {
      failed.push({ project: p.project, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { synced, failed };
}

export const ROLE_MAP_SYNC_INTERVAL_MS = 10_000;

/** The `role_map_sync` loop of core-worker. */
export function roleMapSyncLoop(
  d: RoleMapSyncDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? ROLE_MAP_SYNC_INTERVAL_MS;
  return {
    name: 'role_map_sync',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick(ctx) {
      const pending = await pendingRoleMaps(d);
      return ctx.eachItem(
        pending,
        (p) => `project ${p.project}`,
        (p) => syncRoleMap(d, p),
      );
    },
  };
}
