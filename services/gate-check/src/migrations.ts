import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'gatecheck';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the gate-check schema (after the record, ledger, config and core schemas) to the record database. */
export function migrateGateCheck(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
