import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { migrateRecord } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeCodehost } from './fake-codehost.js';
import { contractSeed } from '@aisdlc/ports/testing';

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'core-worker', 'dist', 'main.js');

const runOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, [bundle], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('the core-worker bundle fails fast on bad configuration', () => {
  it('every misconfiguration exits 78 with a clear message', () => {
    expect(runOnce({}).stderr).toMatch(/CORE_WORKER_REGISTERED_REPOS_FILE is required/);
    const base = {
      CORE_WORKER_REGISTERED_REPOS_FILE: '/nonexistent.json',
      CORE_WORKER_CODEHOST_URL: 'http://127.0.0.1:1',
      CORE_WORKER_CODEHOST_TOKEN_REF: 'env:T',
      T: 'x'.repeat(32),
    };
    const pw = runOnce({ ...base, CORE_WORKER_DATABASE_URL: 'postgres://u:pw@localhost/db' });
    expect(pw.status).toBe(78);
    expect(pw.stderr).toMatch(/contains a password/);
    const bad = runOnce({
      ...base,
      CORE_WORKER_DATABASE_URL: 'postgres://localhost/db',
      CORE_WORKER_HEAD_INTERVAL_MS: '5',
    });
    expect(bad.status).toBe(78);
    expect(bad.stderr).toMatch(/CORE_WORKER_HEAD_INTERVAL_MS must be an integer of at least 100/);
  });

  it('refuses to start against a database whose record schema is not migrated', async () => {
    const empty = await createTestDatabase();
    try {
      const r = runOnce({
        CORE_WORKER_DATABASE_URL: empty.url,
        CORE_WORKER_REGISTERED_REPOS_FILE: '/nonexistent.json',
        CORE_WORKER_CODEHOST_URL: 'http://127.0.0.1:1',
        CORE_WORKER_CODEHOST_TOKEN_REF: 'env:T',
        T: 'x'.repeat(32),
        CORE_WORKER_PORT: '0',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/record schema is missing/);
    } finally {
      await empty.drop();
    }
  });
});

describe('the core-worker bundle as a process (plain node, no TypeScript loader)', () => {
  let db: TestDatabase;
  let dir: string;
  let child: ChildProcess | undefined;
  let output = '';
  let ch: Awaited<ReturnType<typeof startFakeCodehost>>;
  const token = 'w'.repeat(32);

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrateRecord(db.pool);
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-core-worker-'));
    ch = await startFakeCodehost(token);
  });
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await ch.stop();
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('polls through the codehost, records facts only when they change, serves healthz and metrics, stops on SIGTERM', async () => {
    const reg = join(dir, 'registered.json');
    writeFileSync(reg, JSON.stringify([{ project_id: 'acme', repo: 'acme/app' }]));
    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        CORE_WORKER_DATABASE_URL: db.url,
        CORE_WORKER_CODEHOST_URL: ch.url,
        CORE_WORKER_CODEHOST_TOKEN_REF: 'env:CW_TOKEN',
        CW_TOKEN: token,
        CORE_WORKER_REGISTERED_REPOS_FILE: reg,
        CORE_WORKER_HEAD_INTERVAL_MS: '200',
        CORE_WORKER_INSTALLATION_INTERVAL_MS: '200',
        CORE_WORKER_RULES_TICK_MS: '200',
        CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS: '200',
        CORE_WORKER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`core-worker did not start:\n${output}`)),
        20_000,
      );
      const poll = setInterval(() => {
        const m = /core-worker listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`core-worker exited ${code}:\n${output}`)));
    });
    const count = async (kind: string) =>
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1',
          [`inbound:${kind}:acme/app`],
        )
      ).rows[0].n as number;
    const until = async (cond: () => Promise<boolean>, what: string) => {
      const end = Date.now() + 15_000;
      while (!(await cond())) {
        if (Date.now() > end) throw new Error(`timed out: ${what}\n${output}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(async () => (await count('default_branch_head')) === 1, 'first head fact');
    await until(async () => (await count('installation')) === 1, 'installation fact');
    await until(async () => (await count('effective_rules')) === 1, 'rules fact');
    // Several ticks later with nothing changed: still one fact each.
    await new Promise((r) => setTimeout(r, 800));
    expect(await count('default_branch_head')).toBe(1);
    expect(await count('installation')).toBe(1);
    // acme/lib is installed but not registered: never polled.
    expect(ch.seen.some((u) => u.includes('acme/lib'))).toBe(false);
    // A push to the default branch is a new fact, at the next poll.
    const seed = contractSeed();
    ch.gh.load({
      ...seed,
      heads: seed.heads.map((h) => (h.repo === 'acme/app' ? { ...h, sha: 'e'.repeat(40) } : h)),
    });
    await until(async () => (await count('default_branch_head')) === 2, 'second head fact');

    const health = await fetch(new URL('/healthz', base));
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; loops: Array<{ name: string }> };
    expect(body.status).toBe('ok');
    expect(body.loops.map((l) => l.name).sort()).toEqual([
      'default_branch_head',
      'effective_rules',
      'installation',
      'outbox_watch',
    ]);
    const metrics = await (await fetch(new URL('/metrics', base))).text();
    expect(metrics).toMatch(
      /aisdlc_loop_ticks_total\{loop="default_branch_head",outcome="ok"\} [1-9]/,
    );

    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toMatch(/core-worker: SIGTERM received, shutting down/);
    // Log lines are loop-prefixed; the service token is nowhere in the output.
    expect(output).toMatch(/default_branch_head: \{"level":"info"/);
    expect(output.includes(token)).toBe(false);
  }, 90_000);
});
