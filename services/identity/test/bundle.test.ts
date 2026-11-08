import { dbUrlRef } from '@aisdlc/db/testing';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { migrateLedger } from '@aisdlc/ledger';
import { migrateRecord } from '@aisdlc/record';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settingsOf } from '../src/testing.js';

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'identity', 'dist', 'main.js');
const seed = join(import.meta.dirname, '..', 'fixtures', 'seed.json');

// The responses are asserted field by field; typing every body would only repeat the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const runOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, [bundle], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('the identity bundle fails fast on bad configuration', () => {
  it('missing database, password in the URL, bad callers, bad port', () => {
    const missing = runOnce({});
    expect(missing.status).toBe(78);
    expect(missing.stderr).toMatch(
      /identity: configuration error: IDENTITY_DATABASE_URL is required/,
    );
    const secret = runOnce({ IDENTITY_DATABASE_URL: 'postgres://u:pw@localhost/db' });
    expect(secret.status).toBe(78);
    expect(secret.stderr).toMatch(/contains a password/);
    expect(secret.stderr).not.toMatch(/pw@/);
    const noCallers = runOnce({ IDENTITY_DATABASE_URL: 'postgres://localhost/db' });
    expect(noCallers.status).toBe(78);
    expect(noCallers.stderr).toMatch(/IDENTITY_CALLERS is required/);
    const port = runOnce({
      IDENTITY_DATABASE_URL: 'postgres://localhost/db',
      IDENTITY_CALLERS: '{}',
      IDENTITY_PORT: '99999',
    });
    expect(port.status).toBe(78);
    expect(port.stderr).toMatch(/IDENTITY_PORT must be an integer/);
  });

  it('takes the project settings from core or from a file, never both, and core needs its token', () => {
    const base = {
      IDENTITY_DATABASE_URL: 'postgres://localhost/db',
      IDENTITY_CALLERS: JSON.stringify({ a: { token_ref: 'env:T', scopes: ['read'] } }),
      T: 'a'.repeat(32),
      IDENTITY_CORE_URL: 'http://127.0.0.1:1',
    };
    const both = runOnce({ ...base, IDENTITY_PROJECT_SETTINGS_FILE: '/nowhere.json' });
    expect(both.status).toBe(78);
    expect(both.stderr).toMatch(/two sources for the same thing/);
    const noToken = runOnce(base);
    expect(noToken.status).toBe(78);
    expect(noToken.stderr).toMatch(/IDENTITY_CORE_TOKEN_REF is required/);
  });

  it('refuses to run without a Notary unless access sync is explicitly off', () => {
    const r = runOnce({
      IDENTITY_DATABASE_URL: 'postgres://localhost/db',
      IDENTITY_CALLERS: '{}',
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/NOTARY_URL is required/);
  });
});

describe('the identity bundle without a migrated record database', () => {
  it('refuses to start rather than create the record schemas itself', async () => {
    const empty = await createTestDatabase();
    try {
      const r = runOnce({
        ...dbUrlRef('IDENTITY_DATABASE_URL', empty.url),
        IDENTITY_CALLERS: JSON.stringify({ admin: { token_ref: 'env:T', scopes: ['read'] } }),
        T: 'a'.repeat(32),
        IDENTITY_ACCESS_SYNC: 'off',
        IDENTITY_PORT: '0',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/record and ledger schemas are missing/);
    } finally {
      await empty.drop();
    }
  });
});

describe('the identity bundle as a process (plain node, no TypeScript loader)', () => {
  let kms: TestKms;
  let notary: TestNotary;
  let db: TestDatabase;
  let dir: string;
  let child: ChildProcess | undefined;
  let output = '';

  beforeAll(async () => {
    kms = await startTestKms();
    notary = await startTestNotary({ custody: kms.custodyFor('notary') });
    db = await createTestDatabase();
    await migrateRecord(db.pool);
    await migrateLedger(db.pool);
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-identity-'));
  });
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await notary.stop();
    await kms.stop();
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts, migrates, serves, writes access ledger entries by itself, and stops on SIGTERM', async () => {
    const settingsFile = join(dir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify([
        { settings: settingsOf('acme', { admin: ['alice'], intent: ['bob'] }), tier: 'T1' },
      ]),
    );
    const adminToken = 'a'.repeat(32);
    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        ...dbUrlRef('IDENTITY_DATABASE_URL', db.url),
        IDENTITY_CALLERS: JSON.stringify({
          admin: {
            token_ref: 'env:ID_ADMIN_TOKEN',
            scopes: ['read', 'write', 'reconcile', 'sync'],
          },
        }),
        ID_ADMIN_TOKEN: adminToken,
        IDENTITY_PORT: '0',
        IDENTITY_SYNC_INTERVAL_MS: '100',
        IDENTITY_IDP_SEED_FILE: seed,
        IDENTITY_PROJECT_SETTINGS_FILE: settingsFile,
        NOTARY_URL: notary.url,
        IDENTITY_NOTARY_TOKEN_REF: 'env:ID_NOTARY_TOKEN',
        ID_NOTARY_TOKEN: notary.tokens['core'] as string,
        KMS_URL: kms.url,
        KMS_TOKEN_REF: 'env:ID_KMS_TOKEN',
        ID_KMS_TOKEN: kms.tokens['notary'] as string,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`identity did not start:\n${output}`)), 20_000);
      const poll = setInterval(() => {
        const m = /identity listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`identity exited ${code}:\n${output}`)));
    });

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };
    expect((await call('POST', '/v1/idp/sync')).status).toBe(200);
    const rec = await call('POST', '/v1/projects/acme/reconcile', {});
    expect(rec.status).toBe(200);
    expect(rec.json.bindings_created).toBe(10);
    expect((await call('GET', '/v1/principals/alice')).json).toMatchObject({
      principal_id: 'alice',
    });
    const g = await call('GET', '/v1/projects/acme/explain?gate=G1');
    expect(g.json.deciders.map((d: { principal_id: string }) => d.principal_id)).toEqual(['bob']);

    // The loop in the process ledgers every access event without being asked.
    const deadline = Date.now() + 15_000;
    let lag = 1;
    while (Date.now() < deadline) {
      lag = (await call('GET', '/v1/access-sync')).json.lag_seconds;
      const n = await db.pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'",
      );
      if (lag === 0 && Number(n.rows[0]?.n) > 10) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lag).toBe(0);
    const events = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM record.record_event WHERE type IN ('group.member_added','binding.created','principal.status_changed')",
    );
    const entries = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'",
    );
    expect(Number(entries.rows[0]?.n)).toBe(Number(events.rows[0]?.n));

    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toMatch(/identity: SIGTERM received, shutting down/);
  }, 60_000);
});
