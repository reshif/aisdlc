import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'bff';
/** Same relative position from `src/` and from `dist/`. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the bff migrations (Postgres schema `bff`). */
export function migrateBff(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
