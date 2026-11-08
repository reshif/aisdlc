import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'directory';
/** Same relative position from `src/` and from `dist/`. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the directory migrations (Postgres schema `directory`). Run after the record migrations. */
export function migrateDirectory(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
