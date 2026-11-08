import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'knowledge';
/** Same relative position from `src/` and from `dist/`. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the knowledge migrations (schemas `knowledge` and `security_findings`). Run after the record's. */
export function migrateKnowledge(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
