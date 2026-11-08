import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowListedCodeHost, FakeIdentityLinks, createCodeHostApp } from '@aisdlc/codehost';
import {
  GitHttpTestServer,
  createFixtureRepo,
  startTestCodeHost,
  type FixtureRepo,
  type TestCodeHost,
} from '@aisdlc/codehost/testing';
import { S0_EVENT, s0Stream } from '@aisdlc/contracts';
import {
  FakeDecisionVerifier,
  FakePrincipalDirectory,
  HttpBundleSource,
  JobRunner,
  createKnowledgeApp,
  kmsFingerprinter,
  migrateKnowledge,
} from '@aisdlc/knowledge';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { HttpCodeHostReads, HttpRegisteredRepos, emptySeed } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HttpKnowledge,
  createCoreApp,
  driveS0,
  readS0,
  requestOnboarding,
  withdrawS0,
  type DriverDeps,
} from '../src/index.js';
import { pid, request, startCoreStack, type CoreStack } from '../src/testing.js';

// Step 0.1 end to end through the HTTP APIs of the REAL services (PLAN M7.2): core's registry feeds
// the codehost's allow-list (`HttpRegisteredRepos` over core's app), the driver reads the codehost
// (`HttpCodeHostReads`) and starts the census-intake job on the real knowledge service
// (`HttpKnowledge`), which pulls its bundle from the codehost's bundle route, which runs real git
// against a fixture repository. Only GitHub itself is a fake server.

const ROOT = mkdtempSync(join(tmpdir(), 'aisdlc-core-e2e-'));
const tok = (n: string) => `${n}-token-`.padEnd(32, 'x');
let s: CoreStack;
let kms: TestKms;
let gh: TestCodeHost;
let git: GitHttpTestServer;
let fixture: FixtureRepo;
let runner: JobRunner;
const apps: FastifyInstance[] = [];
let driver: DriverDeps;
const accepted = new Set<string>();

beforeAll(async () => {
  s = await startCoreStack();
  kms = await startTestKms();
  const reposDir = join(ROOT, 'repos');
  mkdirSync(join(ROOT, 'tmp'));
  fixture = createFixtureRepo(reposDir, { name: 'acme/app', commits: 3 });
  git = await new GitHttpTestServer({
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
        { full_name: 'acme/blank', default_branch: 'main', private: true, archived: false },
      ],
      heads: [{ repo: 'acme/app', branch: 'main', sha: fixture.head }],
    }),
    git: {
      gitBaseUrl: git.baseUrl,
      tmpRoot: join(ROOT, 'tmp'),
      extraEnv: { NO_PROXY: '127.0.0.1' },
    },
  });
  const t = await gh.broker.token('hub');
  if (!t.ok) throw new Error('no token');
  accepted.add(
    `Basic ${Buffer.from(`x-access-token:${t.value.secret.reveal()}`).toString('base64')}`,
  );

  // core: the registry route the codehost reads.
  const core = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth({ codehost: tok('codehost-at-core') }),
    callers: { codehost: ['registry'] },
    registry: s.registry,
    clock: s.clock,
  });
  apps.push(core);
  const coreUrl = await listen(core);

  // codehost: the allow-list is the installation's repos ∩ core's registered repos.
  const codehost = createCodeHostApp({
    host: new AllowListedCodeHost(
      gh.rest,
      new HttpRegisteredRepos({ baseUrl: coreUrl, token: tok('codehost-at-core') }),
    ),
    identity: new FakeIdentityLinks(),
    auth: new ServiceAuth({ knowledge: tok('knowledge-at-ch'), core: tok('core-at-ch') }),
    callers: { knowledge: ['census'], core: ['census', 'posture'] },
    broker: gh.broker,
    clock: gh.clock,
  });
  apps.push(codehost);
  const codehostUrl = await listen(codehost);

  // knowledge, on the same record database.
  await migrateKnowledge(s.record.pool);
  runner = new JobRunner({
    pool: s.record.pool,
    source: new HttpBundleSource({ baseUrl: codehostUrl, token: tok('knowledge-at-ch') }),
    fingerprinter: kmsFingerprinter(kms.custodyFor('knowledge')),
    workRoot: join(ROOT, 'work'),
    log: () => undefined,
  });
  const knowledge = createKnowledgeApp({
    pool: s.record.pool,
    auth: new ServiceAuth({ core: tok('core-at-kn') }),
    callers: { core: ['census'] },
    runner,
    principals: new FakePrincipalDirectory(),
    decisions: new FakeDecisionVerifier(),
  });
  apps.push(knowledge);
  const knowledgeUrl = await listen(knowledge);

  driver = {
    pool: s.record.pool,
    clock: s.clock,
    source: new HttpCodeHostReads({ baseUrl: codehostUrl, token: tok('core-at-ch') }),
    knowledge: new HttpKnowledge({ baseUrl: knowledgeUrl, token: tok('core-at-kn') }),
  };
}, 120_000);

afterAll(async () => {
  for (const a of apps) await a.close();
  await runner?.idle();
  await gh?.stop();
  await git?.stop();
  await kms?.stop();
  await s?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('step 0.1 through the real services', () => {
  it('registers the repo in core, reads the installation, runs the census job and raises card 1', async () => {
    const r = await requestOnboarding(
      s.deps,
      request({ project_id: pid('e2e'), repo: 'acme/app', level: 'census' }),
    );
    if (!r.ok) throw new Error(r.error.message);
    const id = r.value.s0_id;

    // Before the first tick nothing has touched the code host.
    expect(gh.server.apiRequests.filter((x) => !x.path.startsWith('/app'))).toEqual([]);

    expect((await driveS0(driver, id)).action).toBe('job_pending'); // App found, 0.1 starts
    expect((await driveS0(driver, id)).action).toBe('job_started'); // head read, job started
    await runner.idle();
    expect((await driveS0(driver, id)).action).toBe('card_raised');

    const st = (await readS0(s.record.pool, id))!;
    expect(st.record.status).toBe('card');
    expect(st.steps.get('0.1')?.state).toBe('card');
    expect(st.census).toMatchObject({
      census_id: `census:acme.app:${fixture.head}`,
      b1_blocked: false,
    });
    expect(st.census?.census_hash).toMatch(/^[0-9a-f]{64}$/);

    // The census on the S0 stream is the census knowledge holds.
    const row = await s.record.pool.query<{ census_hash: string }>(
      "SELECT census_hash FROM knowledge.census WHERE repo = 'acme/app'",
    );
    expect(row.rows[0]?.census_hash).toBe(st.census?.census_hash);

    const cards = await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [s0Stream(id), S0_EVENT.card_required],
    );
    expect(cards.rows.map((c) => c.body.card)).toEqual(['C1']);

    // The code host saw reads only, and only of the registered repo.
    const api = gh.server.apiRequests.filter((x) => !x.path.startsWith('/app'));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((x) => x.method === 'GET')).toBe(true);
    expect(api.some((x) => x.path.includes('acme/blank'))).toBe(false);
  });

  it('a repo the App is not installed on waits ("0.1 waiting: App not installed") and starts no job', async () => {
    const r = await requestOnboarding(
      s.deps,
      request({ project_id: pid('e2e-lib'), repo: 'acme/lib', level: 'census' }),
    );
    if (!r.ok) throw new Error(r.error.message);
    const jobs = await s.record.pool.query(
      "SELECT count(*)::int AS n FROM knowledge.knowledge_job WHERE repo = 'acme/lib'",
    );
    expect((await driveS0(driver, r.value.s0_id)).action).toBe('waiting_app');
    expect((await readS0(s.record.pool, r.value.s0_id))?.waiting).toBe(
      '0.1 waiting: App not installed',
    );
    const after = await s.record.pool.query(
      "SELECT count(*)::int AS n FROM knowledge.knowledge_job WHERE repo = 'acme/lib'",
    );
    expect(after.rows[0]).toEqual(jobs.rows[0]);
  });

  it('a blank repo goes to starter; withdrawing a record takes its repo off the allow-list', async () => {
    const r = await requestOnboarding(
      s.deps,
      request({ project_id: pid('e2e-blank'), repo: 'acme/blank', level: 'census' }),
    );
    if (!r.ok) throw new Error(r.error.message);
    await driveS0(driver, r.value.s0_id);
    expect((await driveS0(driver, r.value.s0_id)).action).toBe('starter');
    expect((await readS0(s.record.pool, r.value.s0_id))?.record.status).toBe('starter');

    // Withdrawn: core stops registering the repo, so the codehost refuses to read it.
    const reads = driver.source;
    expect((await reads.branch_head({ repo: 'acme/blank', branch: 'main' })).state).not.toBe('ok');
    await withdrawS0(s.deps, r.value.s0_id, { actor: 'alice' });
    expect(await reads.branch_head({ repo: 'acme/blank', branch: 'main' })).toMatchObject({
      state: 'unreadable',
      reason: 'repo_not_allowed',
    });
  });
});
