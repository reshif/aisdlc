import { IssueTwinView } from '@aisdlc/contracts';
import { bindProject, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, syncIssueTwins, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { seedTwinRepo, type Seeded } from './issue-twin-fixtures.js';
import { loadReports } from './prr-fixtures.js';

// The issue twin's routes over HTTP with the real PDP over the real identity read model (PLAN M16): the view needs
// `project.view`, approving a batch and linking a duplicate `config.propose` (the project's admin slot), turning a gap
// into a request `work.request` (the requesters slot); every route needs the work scope.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let t: Seeded;
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'work'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'ria', 'vic', 'eve']);
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
  });
  url = await listen(app);
  t = await seedTwinRepo(s, {});
  await bindProject(s.id, t.project, { admin: ['ada'], requesters: ['ria'], intent: ['vic'] });
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

const view = (who: string) =>
  call('GET', `/v1/projects/${t.project}/issue-twin?on_behalf_of=${who}`);

describe('the issue twin over HTTP', () => {
  it('the view: the work scope and project.view', async () => {
    expect(
      (
        await call(
          'GET',
          `/v1/projects/${t.project}/issue-twin?on_behalf_of=ada`,
          undefined,
          TOKENS.reader,
        )
      ).status,
    ).toBe(403);
    expect((await view('eve')).status).toBe(403);
    expect((await call('GET', `/v1/projects/${t.project}/issue-twin`)).status).toBe(400);
    const v = await view('vic');
    expect(v.status).toBe(200);
    const parsed = IssueTwinView.parse(v.json);
    expect(parsed.repos[0]?.candidates.length).toBe(t.gaps.length);
  });

  it('a batch: config.propose; the twin then shows pending and the sync files it', async () => {
    const gap = t.gaps[0]?.gap_id as string;
    const body = (who: string) => ({
      repo: t.repo,
      rows: [{ gap_id: gap, disposition: 'file_issue' }],
      on_behalf_of: who,
    });
    expect(
      (await call('POST', `/v1/projects/${t.project}/issue-twin/batches`, body('ria'))).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/v1/projects/${t.project}/issue-twin/batches`, {
          ...body('ada'),
          rows: [],
        })
      ).status,
    ).toBe(400);
    const ok = await call('POST', `/v1/projects/${t.project}/issue-twin/batches`, body('ada'));
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ filed: 1, tracked: 0 });
    expect((await view('vic')).json.repos[0].twins).toEqual([
      expect.objectContaining({ gap_id: gap, state: 'pending', number: null }),
    ]);
    const r = await syncIssueTwins(t.sync);
    expect(r.ok && r.value.filed).toBe(1);
    expect((await view('vic')).json.repos[0].twins[0]).toMatchObject({
      state: 'open',
      via: 'created',
    });
  });

  it('a request from a twin: work.request; a link: config.propose', async () => {
    const gap = t.gaps[0]?.gap_id as string;
    const req = (who: string) => ({ repo: t.repo, gap_id: gap, on_behalf_of: who });
    expect(
      (await call('POST', `/v1/projects/${t.project}/issue-twin/requests`, req('vic'))).status,
    ).toBe(403);
    const made = await call('POST', `/v1/projects/${t.project}/issue-twin/requests`, req('ria'));
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ duplicate: false });
    const again = await call('POST', `/v1/projects/${t.project}/issue-twin/requests`, req('ria'));
    expect(again.status).toBe(200);
    expect(again.json.request_id).toBe(made.json.request_id);
    const link = { repo: t.repo, gap_id: gap, number: 99, on_behalf_of: 'ria' };
    expect((await call('POST', `/v1/projects/${t.project}/issue-twin/links`, link)).status).toBe(
      403,
    );
    // the gap is already linked to the issue the sync filed
    expect(
      (
        await call('POST', `/v1/projects/${t.project}/issue-twin/links`, {
          ...link,
          on_behalf_of: 'ada',
        })
      ).status,
    ).toBe(409);
  });
});
