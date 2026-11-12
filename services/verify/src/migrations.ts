import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'verify';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the verify schema (after the record schema) to the database it shares with the record. */
export function migrateVerify(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
