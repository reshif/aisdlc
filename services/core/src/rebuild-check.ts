import { configProjection } from '@aisdlc/config';
import { inboxProjection, gateInstanceProjection } from '@aisdlc/decisions';
import { directoryProjection } from '@aisdlc/directory';
import { identityProjection } from '@aisdlc/identity/read';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { rebuild, runProjection, streamTypeCounts, type Projection } from '@aisdlc/record';
import type pg from 'pg';
import { agentRunProjection } from './agent-runs.js';
import { rebuildUnits } from './admission/fold.js';
import { conversationProjection } from './conversation/store.js';
import { consoleProjection } from './onboarding-console/store.js';
import { evalRunProjection } from './evals.js';
import { sessionActivityProjection } from './floor-live.js';
import { floorProjection } from './floor.js';
import { coreProjection } from './projection.js';
import { rebuildEvidencePacks } from './verify/evidence.js';
import { workItemProjection } from './work-projection.js';

// The restore drill's read-model check (RC-OPS-1): every read model of the record database as a count and a hash,
// before a backup, after the restore, and after it is rebuilt from the record alone. A read model whose hash after the
// rebuild differs from the one before the backup was not a function of the record (or the record was not restored
// whole): the drill fails. Read-only unless asked to rebuild.
//
//   projections   the folds with a checkpoint (`rebuild` drops the state and refolds the record and its feeds)
//   per item      the Unit, Lease, AdmissionGrant and Evidence Pack rows, refolded item by item from their streams

/** The projections the drill checks, by name (each is folded from the record, and the ledger where it has a feed). */
export const CHECKED_PROJECTIONS: readonly Projection[] = [
  streamTypeCounts,
  configProjection,
  identityProjection,
  directoryProjection,
  gateInstanceProjection,
  inboxProjection,
  coreProjection,
  workItemProjection,
  agentRunProjection,
  floorProjection,
  sessionActivityProjection,
  evalRunProjection,
  conversationProjection,
  consoleProjection,
] as readonly Projection[];

/** The tables the per-item rebuilds own, hashed row by row (`row::text`, sorted). */
export const PER_ITEM_TABLES = [
  'core.unit',
  'core.lease_history',
  'core.admission_grant',
  'core.evidence_pack',
] as const;

export interface ReadModelDigest {
  readonly rows: number;
  readonly sha256: string;
}

/** Rows of a snapshot: an array's length, or the sum over an object's arrays (a scalar counts one). */
const countOf = (v: unknown): number => {
  if (Array.isArray(v)) return v.length;
  if (v !== null && typeof v === 'object')
    return Object.values(v).reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : 1), 0);
  return 1;
};

async function tableDigest(db: Pick<pg.Pool, 'query'>, table: string): Promise<ReadModelDigest> {
  const r = await db.query<{ n: string; h: string }>(
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h
       FROM ${table} t`,
  );
  return { rows: Number(r.rows[0]?.n ?? 0), sha256: sha256Hex(r.rows[0]?.h ?? '') };
}

/** Whether every table exists (a database migrated without that schema has no such read model to check). */
async function present(db: Pick<pg.Pool, 'query'>, tables: readonly string[]): Promise<boolean> {
  for (const t of tables) {
    const r = await db.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [t]);
    if (r.rows[0]?.t == null) return false;
  }
  return true;
}

/** Every checked read model's digest, now (a read model whose schema is not migrated here is left out). */
export async function readModelDigests(pool: pg.Pool): Promise<Record<string, ReadModelDigest>> {
  const out: Record<string, ReadModelDigest> = {};
  for (const p of CHECKED_PROJECTIONS) {
    if (!(await present(pool, p.tables))) continue;
    const snap = await p.snapshot(pool);
    out[`projection:${p.name}`] = {
      rows: countOf(snap),
      // a snapshot carries Dates and bigints as the driver reads them: their JSON form is what is hashed
      sha256: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(snap)) as never)),
    };
  }
  for (const t of PER_ITEM_TABLES)
    if (await present(pool, [t])) out[`table:${t}`] = await tableDigest(pool, t);
  return out;
}

/**
 * Folds every checked projection forward to the head of the record (what the live services do lazily, on their next
 * read): the reference a restore is compared with. Throws on a projection that needs a rebuild.
 */
export async function catchUpReadModels(pool: pg.Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of CHECKED_PROJECTIONS) {
    if (!(await present(pool, p.tables))) continue;
    const r = await runProjection(pool, p);
    if (!r.ok) throw new Error(`the ${p.name} read model needs a rebuild`);
    out[p.name] = r.value.applied;
  }
  return out;
}

/** Drops and refolds every checked read model from the record; returns how many events and items were folded. */
export async function rebuildReadModels(
  pool: pg.Pool,
): Promise<{ projections: Record<string, number>; items: number }> {
  const projections: Record<string, number> = {};
  for (const p of CHECKED_PROJECTIONS)
    if (await present(pool, p.tables)) projections[p.name] = (await rebuild(pool, p)).applied;
  const items = await pool.query<{ id: string }>(
    `SELECT DISTINCT split_part(stream, ':', 2) AS id FROM record.record_event
      WHERE stream LIKE 'item:%' OR stream LIKE 'unit:%' OR stream LIKE 'evidence:%' OR stream LIKE 'planning:%'`,
  );
  for (const { id } of items.rows) {
    await rebuildUnits({ pool }, id);
    await rebuildEvidencePacks({ pool }, id);
  }
  return { projections, items: items.rows.length };
}
