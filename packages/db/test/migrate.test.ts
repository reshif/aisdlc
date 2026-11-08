import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { asc } from 'drizzle-orm';
import { migrate, MigrationError } from '../src/index.js';
import { createTestDatabase, withTestDatabase } from '../src/testing.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'migrations');
const demo = pgSchema('demo');
const widgets = demo.table('widgets', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

describe('test database + migrations', () => {
  it('creates a database, migrates, queries with pg and drizzle, tears down', async () => {
    const t = await createTestDatabase();
    try {
      const first = await migrate(t.pool, { scope: 'demo', dir: fixtures });
      expect(first.applied).toEqual(['0001_create_widgets.sql', '0002_seed_widgets.sql']);

      const raw = await t.pool.query('SELECT name FROM demo.widgets ORDER BY name');
      expect(raw.rows.map((r) => (r as { name: string }).name)).toEqual(['gear', 'sprocket']);

      const rows = await t.db.select().from(widgets).orderBy(asc(widgets.name));
      expect(rows.map((r) => r.name)).toEqual(['gear', 'sprocket']);

      const second = await migrate(t.pool, { scope: 'demo', dir: fixtures });
      expect(second.applied).toEqual([]);
      expect(second.skipped).toHaveLength(2);

      const tracked = await t.pool.query('SELECT count(*)::int AS n FROM public.schema_migrations');
      expect((tracked.rows[0] as { n: number }).n).toBe(2);
    } finally {
      await t.drop();
    }
    // The database is gone after drop().
    const probe = await withTestDatabase(async (other) => {
      const r = await other.pool.query('SELECT datname FROM pg_database WHERE datname = $1', [
        t.name,
      ]);
      return r.rowCount;
    });
    expect(probe).toBe(0);
  });

  it('isolates databases from each other', async () => {
    await withTestDatabase(async (a) => {
      await withTestDatabase(async (b) => {
        await migrate(a.pool, { scope: 'demo', dir: fixtures });
        const r = await b.pool.query("SELECT to_regclass('demo.widgets') AS t");
        expect((r.rows[0] as { t: string | null }).t).toBeNull();
      });
    });
  });

  it('rolls back a failing migration and applies earlier ones', async () => {
    await withTestDatabase(async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mig-'));
      try {
        await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);');
        await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT nope();');
        await expect(migrate(t.pool, { scope: 's', dir })).rejects.toThrow(MigrationError);
        const r = await t.pool.query("SELECT to_regclass('a') AS a, to_regclass('b') AS b");
        expect(r.rows[0]).toEqual({ a: 'a', b: null });
        const m = await t.pool.query('SELECT name FROM public.schema_migrations');
        expect(m.rows).toEqual([{ name: '0001_ok.sql' }]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('refuses edited applied migrations and bad file names', async () => {
    await withTestDatabase(async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mig-'));
      try {
        await writeFile(join(dir, '0001_x.sql'), 'CREATE TABLE x (id int);');
        await migrate(t.pool, { scope: 's', dir });
        await writeFile(join(dir, '0001_x.sql'), 'CREATE TABLE x (id bigint);');
        await expect(migrate(t.pool, { scope: 's', dir })).rejects.toThrow(
          /changed after being applied/,
        );
        await writeFile(join(dir, '0001_x.sql'), 'CREATE TABLE x (id int);');
        await writeFile(join(dir, 'oops.sql'), 'SELECT 1;');
        await expect(migrate(t.pool, { scope: 's', dir })).rejects.toThrow(
          /bad migration file name/,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('scopes migration tracking per package', async () => {
    await withTestDatabase(async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mig-'));
      try {
        await writeFile(join(dir, '0001_t.sql'), 'SELECT 1;');
        await migrate(t.pool, { scope: 'one', dir });
        const r = await migrate(t.pool, { scope: 'two', dir });
        expect(r.applied).toEqual(['0001_t.sql']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
