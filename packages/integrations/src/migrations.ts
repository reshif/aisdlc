import { join } from 'node:path';
import { migrate, type MigrationResult } from '@aisdlc/db';
import type pg from 'pg';

export const MIGRATION_SCOPE = 'integrations';
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Applies the integration-health schema (after the record schema). */
export function migrateIntegrations(pool: pg.Pool): Promise<MigrationResult> {
  return migrate(pool, { scope: MIGRATION_SCOPE, dir: MIGRATIONS_DIR });
}
