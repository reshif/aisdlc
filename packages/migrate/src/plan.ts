import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { migrate, readMigrationDir, type MigrationResult, type MigrationText } from '@aisdlc/db';
import type pg from 'pg';
import { z } from 'zod';

// The migration plan (PLAN M2.7): which schemas exist, in which order they are applied, and in which
// database. `plan.json` is the one list; the order is the dependency order (record first, then
// ledger, decisions and config, which only need `record`; identity, which needs record and ledger;
// directory and bff, which read the others). A new schema is a new entry here, and a test fails
// until it is there.

/**
 * The databases the factory has: core's (record, read models, config) and three that are their
 * services' own: the Notary's, the Witness's and the kill switch's (AR9: its state is not core's).
 */
export const DATABASES = ['record', 'notary', 'witness', 'killswitch'] as const;
export type DatabaseName = (typeof DATABASES)[number];

export interface ScopeMigrations {
  readonly scope: string;
  readonly files: readonly MigrationText[];
}
export type MigrationSets = Record<DatabaseName, readonly ScopeMigrations[]>;

const PlanFile = z.strictObject({
  databases: z.strictObject({
    record: z.array(z.strictObject({ scope: z.string().min(1), dir: z.string().min(1) })),
    notary: z.array(z.strictObject({ scope: z.string().min(1), dir: z.string().min(1) })),
    witness: z.array(z.strictObject({ scope: z.string().min(1), dir: z.string().min(1) })),
    killswitch: z.array(z.strictObject({ scope: z.string().min(1), dir: z.string().min(1) })),
  }),
});
export type PlanFile = z.infer<typeof PlanFile>;

/** `plan.json`, next to `src/` (and found from `src/` only: a bundle has the SQL embedded instead). */
export const PLAN_PATH = join(import.meta.dirname, '..', 'plan.json');

export function readPlan(path = PLAN_PATH): PlanFile {
  return PlanFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The plan with the SQL of every directory read from disk. For source runs and the tests. */
export async function loadSetsFromDisk(path = PLAN_PATH): Promise<MigrationSets> {
  const plan = readPlan(path);
  const read = (entries: PlanFile['databases']['record']) =>
    Promise.all(
      entries.map(async (e) => ({
        scope: e.scope,
        files: await readMigrationDir(resolve(dirname(path), e.dir)),
      })),
    );
  return {
    record: await read(plan.databases.record),
    notary: await read(plan.databases.notary),
    witness: await read(plan.databases.witness),
    killswitch: await read(plan.databases.killswitch),
  };
}

export interface ScopeOutcome {
  readonly scope: string;
  readonly result: MigrationResult;
}

/** Applies the scopes of one database in order, one `migrate` call each (each file is its own transaction). */
export async function applyScopes(
  pool: pg.Pool,
  scopes: readonly ScopeMigrations[],
): Promise<ScopeOutcome[]> {
  const out: ScopeOutcome[] = [];
  for (const s of scopes) {
    out.push({ scope: s.scope, result: await migrate(pool, { scope: s.scope, files: s.files }) });
  }
  return out;
}
