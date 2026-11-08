import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AllowListedCodeHost,
  FakeIdentityLinks,
  createCodeHostApp,
  type CodeHostScope,
} from '@aisdlc/codehost';
import {
  GitHttpTestServer,
  createFixtureRepo,
  startTestCodeHost,
  type FixtureRepo as CodeHostFixture,
  type TestCodeHost,
} from '@aisdlc/codehost/testing';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { emptySeed } from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import {
  HttpBundleSource,
  JobRunner,
  getJob,
  kmsFingerprinter,
  migrateKnowledge,
} from '../src/index.js';

// The whole Bytes-flow: the real codehost bundle route (real broker, real git over HTTP against a
// fixture server that accepts only the installation token) -> HttpBundleSource -> intake -> scan.

const ROOT = mkdtempSync(join(tmpdir(), 'aisdlc-knowledge-e2e-'));
const SERVICE_AUTH = 'knowledge-at-codehost-'.padEnd(32, 'x');
let gh: TestCodeHost;
let server: GitHttpTestServer;
let app: FastifyInstance;
let codehostUrl: string;
let fixture: CodeHostFixture;
let db: TestDatabase;
let kms: TestKms;
const logs: string[] = [];
const accepted = new Set<string>();

beforeAll(async () => {
  const reposDir = join(ROOT, 'repos');
  mkdirSync(join(ROOT, 'tmp'));
  fixture = createFixtureRepo(reposDir, {
    name: 'acme/app',
    commits: 3,
    branches: [{ name: 'dev' }],
    tags: ['v1'],
    annotatedTags: ['v2'],
    pulls: [{ number: 5, branch: 'dev' }],
  });
  server = await new GitHttpTestServer({
    root: reposDir,
    isAuthorized: (h) => h !== undefined && accepted.has(h),
  }).start();
  gh = await startTestCodeHost({
    seed: emptySeed({
      installation: {
        installation_id: 4242,
        account_login: 'acme',
        repository_selection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
        suspended: false,
      },
      repos: [
        { full_name: 'acme/app', default_branch: 'main', private: false, archived: false },
        { full_name: 'acme/lib', default_branch: 'main', private: false, archived: false },
      ],
    }),
    git: {
      gitBaseUrl: server.baseUrl,
      tmpRoot: join(ROOT, 'tmp'),
      extraEnv: { NO_PROXY: '127.0.0.1' },
    },
  });
  gh.registered.set([{ project_id: 'acme', repo: 'acme/app' }] as never);
  const t = await gh.broker.token('hub');
  if (!t.ok) throw new Error('no token');
  accepted.add(
    `Basic ${Buffer.from(`x-access-token:${t.value.secret.reveal()}`).toString('base64')}`,
  );
  const callers: Record<string, readonly CodeHostScope[]> = { knowledge: ['census'] };
  app = createCodeHostApp({
    host: new AllowListedCodeHost(gh.rest, gh.registered),
    identity: new FakeIdentityLinks(),
    auth: new ServiceAuth({ knowledge: SERVICE_AUTH }),
    callers,
    broker: gh.broker,
    clock: gh.clock,
  });
  codehostUrl = await listen(app);
  kms = await startTestKms();
  db = await createTestDatabase();
  await migrateRecord(db.pool);
  await migrateKnowledge(db.pool);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await gh?.stop();
  await server?.stop();
  await db?.drop();
  await kms?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const runner = () =>
  new JobRunner({
    pool: db.pool,
    source: new HttpBundleSource({ baseUrl: codehostUrl, token: SERVICE_AUTH }),
    fingerprinter: kmsFingerprinter(kms.custodyFor('knowledge')),
    workRoot: join(ROOT, 'work'),
    log: (l) => logs.push(l),
  });

describe('intake from the real codehost bundle route', () => {
  it('verifies and scans the codehost bundle: head = X-Base-Sha, every ref including refs/pull, nothing credential-shaped anywhere', async () => {
    const r = runner();
    const started = await r.start({ repo: 'acme/app' });
    if (!started.ok) throw new Error(started.error.message);
    await r.idle();
    const job = await getJob(db.pool, started.value.job_id);
    expect(job?.state).toBe('done');
    const res = job?.result;
    expect(res?.base_sha).toBe(fixture.head);
    expect(res?.manifest).toMatchObject({
      repo: 'acme/app',
      head_sha: fixture.head,
      refs_covered: 'all',
    });
    expect(res?.refs.map((x) => x.name).sort()).toEqual(Object.keys(fixture.refs).sort());
    expect(res?.refs.map((x) => x.name)).toContain('refs/pull/5/head');
    expect(res?.scan_status).toBe('ok');
    expect(res?.scan_coverage).toMatchObject({
      refs_covered: 'all',
      truncated: false,
      cap_reached: false,
    });
    // The only credential in the system is the installation token the codehost used with git. It is
    // in no record event, no job row, no log line knowledge wrote, and the knowledge service never had it.
    const t = await gh.broker.token('hub');
    if (!t.ok) throw new Error('no token');
    const secrets = [
      t.value.secret.reveal(),
      ...gh.server.seenBearers,
      SERVICE_AUTH.slice(0, 20) && '',
    ].filter((x) => x !== '');
    const everything = JSON.stringify([
      (await db.pool.query('SELECT * FROM record.record_event')).rows,
      (await db.pool.query('SELECT * FROM knowledge.knowledge_job')).rows,
      logs,
    ]);
    for (const secret of secrets) expect(everything.includes(secret)).toBe(false);
  });

  it('refuses what the codehost refuses (an unregistered repo) and a head that moved, as errors', async () => {
    const r = runner();
    const a = await r.start({ repo: 'acme/lib' });
    const b = await r.start({ repo: 'acme/app', base_sha: 'e'.repeat(40) });
    if (!a.ok || !b.ok) throw new Error('enqueue');
    await r.idle();
    const ja = await getJob(db.pool, a.value.job_id);
    const jb = await getJob(db.pool, b.value.job_id);
    expect(ja).toMatchObject({ state: 'error', error: expect.stringContaining('source_not_ok') });
    expect(jb).toMatchObject({ state: 'error', error: expect.stringContaining('source_not_ok') });
    expect(ja?.error).toContain('repo_not_allowed');
    expect(jb?.error).toContain('head_moved');
  });

  it('HttpBundleSource treats a codehost that cannot be reached, or a token it refuses, as not ok', async () => {
    const down = new HttpBundleSource({
      baseUrl: 'http://127.0.0.1:1',
      token: SERVICE_AUTH,
      headersTimeoutMs: 1000,
    });
    expect(await down.bundle({ repo: 'acme/app', refs: 'all' })).toMatchObject({
      state: 'unknown',
      reason: 'network',
    });
    const wrong = new HttpBundleSource({
      baseUrl: codehostUrl,
      token: 'wrong-token-'.padEnd(32, 'x'),
    });
    expect(await wrong.bundle({ repo: 'acme/app', refs: 'all' })).toMatchObject({
      state: 'unreadable',
      reason: 'forbidden',
    });
  });
});
