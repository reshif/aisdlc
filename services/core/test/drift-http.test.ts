import { ProjectDriftView, bypassListHash } from '@aisdlc/contracts';
import { bindProject, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeGitHub, emptySeed } from '@aisdlc/ports';
import { rawRules } from '@aisdlc/ports/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeKnowledge, createCoreApp, type CoreScope } from '../src/index.js';
import { cardDeps, setSlots, startCoreStack, type CoreStack } from '../src/testing.js';
import { seedActivePrr } from './work-fixtures.js';
import { loadReports } from './prr-fixtures.js';

// The after-onboarding routes over HTTP with the real PDP over the real identity read model (PLAN M16; DEC-21): the
// view needs `project.view`; "Poll now" `config.propose`; a restore `project.settings.edit` AND, in core, a holder of
// the project's admin slot; every route needs the work scope; a refusal keeps its code.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let project = '';
let repo = '';
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'work'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'vic', 'eve']);
  const seeded = await seedActivePrr(s, { level: 'light' });
  project = seeded.project;
  repo = seeded.repo;
  const host = new FakeGitHub(
    emptySeed({
      repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo, branch: 'main', sha: '1'.repeat(40) }],
      // the CODEOWNERS file card 4 observed (the fixtures' controls report)
      files: [{ repo, sha: '1'.repeat(40), path: '.github/CODEOWNERS', content: '* @alice-gh\n' }],
      rules: [
        {
          repo,
          branch: 'main',
          rules: [
            rawRules.pr({}),
            rawRules.checks([{ context: 'aisdlc/gate', integration_id: 99 }], false),
            rawRules.simple('non_fast_forward'),
            rawRules.simple('deletion'),
          ],
        },
      ],
    }),
  );
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
    cards: cardDeps(s, host, new FakeKnowledge()),
    bypass: () => ({}),
  });
  url = await listen(app);
  await bindProject(s.id, project, { admin: ['ada'], intent: ['vic'] });
  // the decision kernel's eligibility (core's slot check): ada holds the admin slot, vic does not
  setSlots(s, project, { admin: ['ada'], intent: ['vic'] });
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown, token = TOKENS.bff) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const restore = (who: string) => ({
  repo,
  bypass: { logins: [], list_hash: bypassListHash([]) },
  attestation: { bypass_matches_list: true, bypass_has_no_app: true },
  on_behalf_of: who,
});

describe('the after-onboarding routes over HTTP', () => {
  it('the view: the work scope and project.view; it parses as the contract', async () => {
    const path = `/v1/projects/${project}/drift?on_behalf_of=vic`;
    expect((await call('GET', path, undefined, TOKENS.reader)).status).toBe(403);
    expect((await call('GET', `/v1/projects/${project}/drift?on_behalf_of=eve`)).status).toBe(403);
    expect((await call('GET', `/v1/projects/${project}/drift`)).status).toBe(400);
    const v = await call('GET', path);
    expect(v.status).toBe(200);
    const parsed = ProjectDriftView.parse(v.json);
    expect(parsed.repos[0]).toMatchObject({ repo, prr: { status: 'active', level: 'light' } });
  });

  it('poll now: config.propose; it records the facts and answers the repo’s view', async () => {
    expect(
      (await call('POST', `/v1/projects/${project}/drift/recheck`, { repo, on_behalf_of: 'vic' }))
        .status,
    ).toBe(403);
    const r = await call('POST', `/v1/projects/${project}/drift/recheck`, {
      repo,
      on_behalf_of: 'ada',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ repo, head_sha: '1'.repeat(40), findings: [] });
  });

  it('a restore: the PDP first, then the facts (a record that is not suspended is a conflict)', async () => {
    expect(
      (await call('POST', `/v1/projects/${project}/drift/restore`, restore('vic'))).status,
    ).toBe(403);
    const r = await call('POST', `/v1/projects/${project}/drift/restore`, restore('ada'));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('conflict');
    expect(
      (
        await call('POST', `/v1/projects/${project}/drift/restore`, {
          ...restore('ada'),
          attestation: { bypass_matches_list: false, bypass_has_no_app: true },
        })
      ).status,
    ).toBe(400);
  });

  it('a level-up: project.onboard (a fleet role); without it the request is refused', async () => {
    const r = await call('POST', `/v1/projects/${project}/onboarding-versions`, {
      repo,
      reason: 'level_up',
      level: 'full',
      on_behalf_of: 'ada',
    });
    expect(r.status).toBe(403);
  });
});
