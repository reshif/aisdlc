import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'notary';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the Notary migrations to the Notary's own database. */
export function migrateNotary(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
