import { createPool } from '@aisdlc/db';
import { ServiceConfigError, databaseUrl, type Env } from '@aisdlc/service-kit';
import { createHash } from 'node:crypto';
import { embedded } from './embedded.js';
import {
  applyScopes,
  loadSetsFromDisk,
  type DatabaseName,
  type MigrationSets,
  type ScopeMigrations,
} from './plan.js';

export const USAGE = `usage: aisdlc-migrate [--notary] [--witness] [--killswitch] [--list]

Applies, in dependency order, every schema of the factory to its database, and does nothing to a
database that is already up to date:
  record, ledger, decisions, config, identity, directory, bff   -> AISDLC_DATABASE_URL
  notary   (with --notary)                                      -> AISDLC_NOTARY_DATABASE_URL
  witness  (with --witness)                                     -> AISDLC_WITNESS_DATABASE_URL
  killswitch (with --killswitch)                                -> AISDLC_KILLSWITCH_DATABASE_URL
Each URL is a secret reference (env:NAME or file:PATH) or a postgres:// URL without a password.
The notary, witness and killswitch databases are the key holders' own; their services also migrate
them at start.
--list prints the plan (scopes, files, checksums) and needs no database.
Exit: 0 done, 78 bad configuration, 1 a migration failed.
`;

export interface CliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const DB_ENV: Record<DatabaseName, string> = {
  record: 'AISDLC_DATABASE_URL',
  notary: 'AISDLC_NOTARY_DATABASE_URL',
  witness: 'AISDLC_WITNESS_DATABASE_URL',
  killswitch: 'AISDLC_KILLSWITCH_DATABASE_URL',
};

const checksum = (sql: string): string =>
  createHash('sha256').update(sql).digest('hex').slice(0, 12);

/**
 * The CLI, as a function (the bin file is one line around it). `sets` are the SQL to apply: the
 * embedded ones in a bundle, the directories' in a source run.
 */
export async function runMigrateCli(
  argv: readonly string[],
  env: Env,
  io: CliIo,
  sets?: MigrationSets,
): Promise<number> {
  const flags = new Set(argv);
  const known = new Set(['--notary', '--witness', '--killswitch', '--list', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0 || flags.has('--help') || flags.has('-h')) {
    (unknown.length > 0 ? io.error : io.log)(
      `${unknown.length > 0 ? `aisdlc-migrate: unknown argument ${unknown[0]}\n` : ''}${USAGE}`,
    );
    return unknown.length > 0 ? 78 : 0;
  }
  const all = sets ?? embedded ?? (await loadSetsFromDisk());
  const source = sets ? 'given' : embedded ? 'embedded' : 'directories';
  const wanted: DatabaseName[] = [
    'record',
    ...(flags.has('--notary') ? (['notary'] as const) : []),
    ...(flags.has('--witness') ? (['witness'] as const) : []),
    ...(flags.has('--killswitch') ? (['killswitch'] as const) : []),
  ];

  if (flags.has('--list')) {
    io.log(`aisdlc-migrate: plan (SQL ${source})`);
    for (const db of ['record', 'notary', 'witness', 'killswitch'] as const) {
      for (const s of all[db]) {
        io.log(`${db}/${s.scope}: ${s.files.map((f) => `${f.name}@${checksum(f.sql)}`).join(' ')}`);
      }
    }
    return 0;
  }

  // All configuration is read before any database is touched.
  let urls: Record<string, string>;
  try {
    urls = Object.fromEntries(wanted.map((db) => [db, databaseUrl(env, DB_ENV[db])]));
  } catch (e) {
    if (e instanceof ServiceConfigError) {
      io.error(`aisdlc-migrate: configuration error: ${e.message}`);
      return 78;
    }
    throw e;
  }

  for (const db of wanted) {
    const pool = createPool(urls[db] as string, 2);
    try {
      const scopes: readonly ScopeMigrations[] = all[db];
      for (const o of await applyScopes(pool, scopes)) {
        io.log(
          o.result.applied.length > 0
            ? `${db}/${o.scope}: applied ${o.result.applied.join(', ')}`
            : `${db}/${o.scope}: up to date (${o.result.skipped.length} migrations)`,
        );
      }
    } catch (e) {
      io.error(`aisdlc-migrate: ${db}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  return 0;
}
