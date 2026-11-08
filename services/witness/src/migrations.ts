import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'witness';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the Witness migrations to the Witness's own database. */
export function migrateWitness(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
