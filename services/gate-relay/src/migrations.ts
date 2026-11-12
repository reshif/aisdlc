import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'gaterelay';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the gate-relay schema (after the record, ledger, config and core and gate-check schemas) to the record database. */
export function migrateGateRelay(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
