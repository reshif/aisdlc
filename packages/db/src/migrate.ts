import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const LOCK_KEY = 'aisdlc.schema_migrations';

/** One migration: its `NNNN_name.sql` file name and its SQL text. */
export interface MigrationText {
  name: string;
  sql: string;
}

interface MigrationScope {
  /** Namespace for this set of migrations, normally the package or bounded-context name. */
  scope: string;
}

/**
 * Where a scope's migrations come from: a directory of `NNNN_name.sql` files, or the same files
 * already in memory (embedded in a bundle at build time, so a bundle needs no directory of another
 * package). The two give the same checksums, so a database migrated one way is a no-op for the other.
 */
export type MigrationSource =
  | (MigrationScope & { /** Directory holding `NNNN_name.sql` files. */ dir: string })
  | (MigrationScope & {
      /** The files, in any order (they are sorted by name). */ files: readonly MigrationText[];
    });

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

/** Reads every `.sql` file of `dir`, sorted by name. The names are checked by `prepare` when applied. */
export async function readMigrationDir(dir: string): Promise<MigrationText[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    entries.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

/** Validates names (`NNNN_name.sql`, unique numbers), sorts, and checksums. */
function prepare(texts: readonly MigrationText[], where: string): MigrationFile[] {
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const { name, sql } of [...texts].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const m = FILE_RE.exec(name);
    if (!m) throw new MigrationError(`bad migration file name: ${name} (want NNNN_name.sql)`);
    const num = m[1]!;
    if (seen.has(num)) throw new MigrationError(`duplicate migration number ${num} in ${where}`);
    seen.add(num);
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
  const files =
    'files' in source
      ? prepare(source.files, source.scope)
      : prepare(await readMigrationDir(source.dir), source.dir);
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
