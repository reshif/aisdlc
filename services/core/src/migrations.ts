import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'core';
/** Same relative position from `src/` and from `dist/`. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the core migrations (Postgres schema `core`). Run after the record schema. */
export function migrateCore(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
