import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as bff from '@aisdlc/bff';
import * as config from '@aisdlc/config';
import * as decisions from '@aisdlc/decisions';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import * as directory from '@aisdlc/directory';
// Not the package root: nothing outside services/identity imports its writer (single-writer test).
import * as identity from '@aisdlc/identity/migrations';
import * as ledger from '@aisdlc/ledger';
import * as notary from '@aisdlc/notary';
import * as record from '@aisdlc/record';
import * as witness from '@aisdlc/witness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_PATH, applyScopes, loadSetsFromDisk, readPlan, runMigrateCli } from '../src/index.js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const scratch = join(import.meta.dirname, '..', '.tmp');
const cli = join(scratch, 'migrate', 'aisdlc-migrate.js');

/** Every schema's owner: the scope and directory it exports, for the plan to be checked against. */
const OWNERS = [
  ['record', record],
  ['ledger', ledger],
  ['decisions', decisions],
  ['config', config],
  ['identity', identity],
  ['directory', directory],
  ['bff', bff],
  ['notary', notary],
  ['witness', witness],
] as const;

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
};

async function tables(db: TestDatabase) {
  const r = await db.pool.query<{ s: string; n: number }>(
    `SELECT table_schema AS s, count(*)::int AS n FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') GROUP BY 1 ORDER BY 1`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.s, x.n]));
}

async function ledgerOfMigrations(db: TestDatabase) {
  const r = await db.pool.query(
    'SELECT scope, name, checksum, applied_at FROM public.schema_migrations ORDER BY scope, name',
  );
  return r.rows as Array<{ scope: string; name: string; checksum: string; applied_at: Date }>;
}

describe('the plan', () => {
  it('names every migrations directory of every package and service, once, in the owner’s own scope', () => {
    const plan = readPlan();
    const entries = Object.entries(plan.databases).flatMap(([db, list]) =>
      list.map((e) => ({ db, ...e, abs: resolve(PLAN_PATH, '..', e.dir) })),
    );
    // Every directory named in the plan exists in the workspace and holds migrations.
    for (const e of entries)
      expect(
        readdirSync(e.abs).some((f) => f.endsWith('.sql')),
        e.abs,
      ).toBe(true);
    // Every `migrations` directory of the workspace is named (a new schema without an entry fails here).
    const found = ['packages', 'services'].flatMap((top) =>
      readdirSync(join(root, top), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(root, top, d.name, 'migrations'))
        .filter((p) => {
          try {
            return readdirSync(p).length > 0;
          } catch {
            return false;
          }
        }),
    );
    expect(found.sort()).toEqual(entries.map((e) => e.abs).sort());
    expect(new Set(entries.map((e) => e.scope)).size).toBe(entries.length);
    // And each entry is what its owner says: same scope, same directory.
    for (const [name, mod] of OWNERS) {
      const e = entries.find((x) => x.scope === name);
      expect(e, `plan entry for ${name}`).toBeDefined();
      expect(mod.MIGRATION_SCOPE).toBe(name);
      expect(resolve(mod.MIGRATIONS_DIR)).toBe(e?.abs);
    }
    // Core's database is migrated in dependency order.
    expect(plan.databases.record.map((e) => e.scope)).toEqual([
      'record',
      'ledger',
      'decisions',
      'config',
      'identity',
      'directory',
      'bff',
    ]);
  });

  it('the order is a dependency order: the config schema reads the record table, so it cannot go first', async () => {
    const db = await createTestDatabase();
    try {
      const sets = await loadSetsFromDisk();
      const dir = sets.record.find((s) => s.scope === 'config');
      await expect(applyScopes(db.pool, [dir as never])).rejects.toThrow(/failed/);
    } finally {
      await db.drop();
    }
  });
});

describe('aisdlc-migrate from source', () => {
  it('migrates a fresh database completely with one call, and a second run changes nothing', async () => {
    const db = await createTestDatabase();
    try {
      const env = { AISDLC_DATABASE_URL: db.url };
      const first = capture();
      expect(await runMigrateCli([], env, first.io)).toBe(0);
      expect(first.err).toEqual([]);
      const t = await tables(db);
      for (const schema of [
        'record',
        'ledger',
        'decisions',
        'config',
        'identity',
        'directory',
        'bff',
      ]) {
        expect(t[schema], `schema ${schema}`).toBeGreaterThan(0);
      }
      // The notary and witness are separate databases: not in this one.
      expect(t['notary']).toBeUndefined();
      expect(t['witness']).toBeUndefined();
      const sets = await loadSetsFromDisk();
      const total = sets.record.reduce((n, s) => n + s.files.length, 0);
      const before = await ledgerOfMigrations(db);
      expect(before).toHaveLength(total);
      expect(first.out.every((l) => l.includes(': applied '))).toBe(true);

      const second = capture();
      expect(await runMigrateCli([], env, second.io)).toBe(0);
      expect(second.out.every((l) => l.includes(': up to date '))).toBe(true);
      expect(await ledgerOfMigrations(db)).toEqual(before); // same rows, same applied_at
      expect(await tables(db)).toEqual(t);
    } finally {
      await db.drop();
    }
  });

  it('migrates the notary and witness databases only when asked, each in its own database', async () => {
    const rec = await createTestDatabase();
    const not = await createTestDatabase();
    const wit = await createTestDatabase();
    try {
      const env = {
        AISDLC_DATABASE_URL: rec.url,
        AISDLC_NOTARY_DATABASE_URL: not.url,
        AISDLC_WITNESS_DATABASE_URL: wit.url,
      };
      const run = capture();
      expect(await runMigrateCli(['--notary', '--witness'], env, run.io)).toBe(0);
      expect((await tables(not))['notary']).toBeGreaterThan(0);
      expect((await tables(wit))['witness']).toBeGreaterThan(0);
      expect((await tables(not))['record']).toBeUndefined();
      expect((await tables(rec))['notary']).toBeUndefined();
      expect(run.out.some((l) => l.startsWith('notary/notary: applied'))).toBe(true);
      const again = capture();
      expect(await runMigrateCli(['--notary', '--witness'], env, again.io)).toBe(0);
      expect(again.out.every((l) => l.includes('up to date'))).toBe(true);
    } finally {
      await Promise.all([rec.drop(), not.drop(), wit.drop()]);
    }
  });

  it('refuses bad configuration (78) before touching any database, and reports a failed migration (1)', async () => {
    const c = (argv: string[], env: Record<string, string>) => {
      const r = capture();
      return runMigrateCli(argv, env, r.io).then((code) => ({ code, ...r }));
    };
    expect(await c([], {})).toMatchObject({ code: 78 });
    expect((await c([], {})).err.join()).toMatch(/AISDLC_DATABASE_URL is required/);
    const pw = await c([], { AISDLC_DATABASE_URL: 'postgres://u:secret@localhost/db' });
    expect(pw.code).toBe(78);
    expect(pw.err.join()).toMatch(/contains a password/);
    expect(pw.err.join()).not.toMatch(/secret/);
    const noNotary = await c(['--notary'], { AISDLC_DATABASE_URL: 'postgres://localhost/db' });
    expect(noNotary.code).toBe(78);
    expect(noNotary.err.join()).toMatch(/AISDLC_NOTARY_DATABASE_URL is required/);
    expect((await c(['--frobnicate'], {})).code).toBe(78);
    expect((await c(['--help'], {})).code).toBe(0);
    // A database that cannot be reached: exit 1, and the message names the database.
    const down = await c([], { AISDLC_DATABASE_URL: 'postgres://127.0.0.1:1/none' });
    expect(down.code).toBe(1);
    expect(down.err.join()).toMatch(/aisdlc-migrate: record:/);
  });

  it('--list needs no database and prints scope, file and checksum', async () => {
    const r = capture();
    expect(await runMigrateCli(['--list'], {}, r.io)).toBe(0);
    expect(r.out[0]).toMatch(/plan \(SQL directories\)/);
    expect(r.out.some((l) => /^record\/record: 0001_record_event\.sql@[0-9a-f]{12} /.test(l))).toBe(
      true,
    );
    expect(r.out.some((l) => l.startsWith('record/bff:'))).toBe(true);
  });
});

describe('the aisdlc-migrate bundle: the SQL is embedded, not read from disk', () => {
  let lonely: string;
  beforeAll(() => {
    // Alone in a directory: no plan.json, no migrations/, no node_modules, nothing of the repo.
    lonely = mkdtempSync(join(tmpdir(), 'aisdlc-migrate-bin-'));
    mkdirSync(join(lonely, 'bin'));
    copyFileSync(cli, join(lonely, 'bin', 'aisdlc-migrate.js'));
  });
  afterAll(() => rmSync(lonely, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [join(lonely, 'bin', 'aisdlc-migrate.js'), ...args], {
      cwd: lonely,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('lists the same plan, as embedded SQL, with the same checksums as the directories', async () => {
    const bundled = run(['--list'], {});
    expect(bundled.status).toBe(0);
    expect(bundled.stdout).toMatch(/plan \(SQL embedded\)/);
    const source = capture();
    await runMigrateCli(['--list'], {}, source.io);
    expect(bundled.stdout.split('\n').slice(1).filter(Boolean)).toEqual(source.out.slice(1));
  });

  it('migrates a fresh database to exactly what the source run produces, and is a no-op the second time', async () => {
    const viaBundle = await createTestDatabase();
    const viaSource = await createTestDatabase();
    try {
      const r1 = run([], { AISDLC_DATABASE_URL: viaBundle.url });
      expect(r1.status, r1.stderr).toBe(0);
      expect(r1.stdout).toMatch(/record\/record: applied 0001_record_event\.sql/);
      expect(await runMigrateCli([], { AISDLC_DATABASE_URL: viaSource.url }, capture().io)).toBe(0);
      const strip = (rows: Array<{ scope: string; name: string; checksum: string }>) =>
        rows.map(({ scope, name, checksum }) => ({ scope, name, checksum }));
      expect(strip(await ledgerOfMigrations(viaBundle))).toEqual(
        strip(await ledgerOfMigrations(viaSource)),
      );
      expect(await tables(viaBundle)).toEqual(await tables(viaSource));
      const before = await ledgerOfMigrations(viaBundle);
      const r2 = run([], { AISDLC_DATABASE_URL: viaBundle.url });
      expect(r2.status, r2.stderr).toBe(0);
      expect(
        r2.stdout
          .trim()
          .split('\n')
          .every((l) => l.includes('up to date')),
      ).toBe(true);
      expect(await ledgerOfMigrations(viaBundle)).toEqual(before);
      // A database the services' own boot-time migrations already did is also a no-op (same checksums).
      const bad = run([], { AISDLC_DATABASE_URL: 'postgres://u:pw@localhost/x' });
      expect(bad.status).toBe(78);
      expect(bad.stderr).not.toContain('pw@');
    } finally {
      await Promise.all([viaBundle.drop(), viaSource.drop()]);
    }
  });
});

describe('services start against a database that one command migrated, with no extra step', () => {
  let db: TestDatabase;
  let before: Awaited<ReturnType<typeof ledgerOfMigrations>>;
  let dir: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    const r = spawnSync(process.execPath, [cli], {
      env: { PATH: process.env['PATH'] ?? '', AISDLC_DATABASE_URL: db.url },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    before = await ledgerOfMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-migrate-svc-'));
  });
  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Starts a bundle, waits for its listening line, checks /healthz, stops it with SIGTERM (exit 0). */
  async function startsAndStops(name: string, file: string, env: Record<string, string>) {
    const child = spawn(process.execPath, ['--enable-source-maps', file], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const url = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${name} did not start:\n${output}`)), 30_000);
      const poll = setInterval(() => {
        const m = new RegExp(`${name} listening on (http://\\S+)`).exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          res(m[1] as string);
        }
      }, 50);
      child.once('exit', (code) => rej(new Error(`${name} exited ${code}:\n${output}`)));
    });
    expect((await fetch(new URL('/healthz', url))).status).toBe(200);
    const exited = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }

  it('identity', async () => {
    await startsAndStops('identity', join(scratch, 'identity', 'dist', 'main.js'), {
      IDENTITY_DATABASE_URL: db.url,
      IDENTITY_CALLERS: JSON.stringify({ admin: { token_ref: 'env:T', scopes: ['read'] } }),
      T: 'a'.repeat(32),
      IDENTITY_ACCESS_SYNC: 'off',
      IDENTITY_PORT: '0',
    });
  });

  it('bff', async () => {
    await startsAndStops('bff', join(scratch, 'bff', 'dist', 'main.js'), {
      BFF_DATABASE_URL: db.url,
      BFF_PUBLIC_URL: 'http://127.0.0.1:1',
      BFF_COOKIE_SECURE: 'false',
      BFF_OIDC_ISSUER: 'http://127.0.0.1:2',
      BFF_OIDC_CLIENT_ID: 'bff',
      BFF_OIDC_CLIENT_SECRET_REF: 'env:S',
      S: 'a'.repeat(32),
      KMS_URL: 'http://127.0.0.1:3',
      KMS_TOKEN_REF: 'env:K',
      K: 'b'.repeat(32),
      BFF_PORT: '0',
    });
  });

  it('codehost (no database of its own: it needs nothing from the migration)', async () => {
    const { generateTestAppKey } = await import('@aisdlc/codehost/testing');
    const key = join(dir, 'k.pem');
    writeFileSync(key, generateTestAppKey().privatePem, { mode: 0o600 });
    await startsAndStops('codehost', join(scratch, 'codehost', 'dist', 'main.js'), {
      CODEHOST_GITHUB_APP_ID: '123456',
      CODEHOST_GITHUB_INSTALLATION_ID: '4242',
      CODEHOST_GITHUB_APP_KEY_REF: `file:${key}`,
      CODEHOST_CALLERS: JSON.stringify({ core: { token_ref: 'env:T', scopes: ['census'] } }),
      T: 'a'.repeat(32),
      CODEHOST_IDENTITY_URL: 'http://127.0.0.1:1',
      CODEHOST_IDENTITY_TOKEN_REF: 'env:T',
      CODEHOST_PORT: '0',
    });
  });

  it('none of them migrated anything: the services’ own boot-time migrations were no-ops', async () => {
    expect(await ledgerOfMigrations(db)).toEqual(before);
  });
});
