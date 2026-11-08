import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const LOCK_KEY = 'aisdlc.schema_migrations';

export interface MigrationSource {
  /** Namespace for this set of migrations, normally the package or bounded-context name. */
  scope: string;
  /** Directory holding `NNNN_name.sql` files. */
  dir: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (!m) throw new MigrationError(`bad migration file name: ${name} (want NNNN_name.sql)`);
    const num = m[1]!;
    if (seen.has(num)) throw new MigrationError(`duplicate migration number ${num} in ${dir}`);
    seen.add(num);
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

/**
 * Applies pending migrations in filename order. Each file runs in its own transaction together
 * with its `public.schema_migrations` row, so a failure leaves nothing half-applied. Re-running
 * is a no-op. An already-applied file whose content changed is an error (fail closed). A
 * session-level advisory lock serialises concurrent runners.
 */
export async function migrate(pool: pg.Pool, source: MigrationSource): Promise<MigrationResult> {
  const files = await loadFiles(source.dir);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          scope      text        NOT NULL,
          name       text        NOT NULL,
          checksum   text        NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (scope, name)
        )`);
      const done = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM public.schema_migrations WHERE scope = $1',
        [source.scope],
      );
      const applied = new Map(done.rows.map((r) => [r.name, r.checksum]));
      for (const f of files) {
        const prior = applied.get(f.name);
        if (prior !== undefined) {
          if (prior !== f.checksum) {
            throw new MigrationError(
              `migration ${source.scope}/${f.name} changed after being applied`,
            );
          }
          result.skipped.push(f.name);
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(f.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (scope, name, checksum) VALUES ($1, $2, $3)',
            [source.scope, f.name, f.checksum],
          );
          await client.query('COMMIT');
        } catch (cause) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new MigrationError(`migration ${source.scope}/${f.name} failed: ${String(cause)}`, {
            cause,
          });
        }
        result.applied.push(f.name);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return result;
}
