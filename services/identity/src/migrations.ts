import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'identity';
/** Same relative position from `src/` and from `dist/`. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the identity migrations (Postgres schema `identity`). Run after the record and ledger migrations. */
export function migrateIdentity(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
