import { LEARN_CONFIG_KEY } from '@aisdlc/contracts';
import { readFactoryM1Policy } from '@aisdlc/config';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FactoryM1Eligibility,
  createCoreApp,
  identityFleetRoleHolders,
  proposeConfigKey,
  submitRequest,
  type CoreScope,
} from '../src/index.js';
import { pid, pr, publishSettings, startCoreStack, type CoreStack } from '../src/testing.js';
import { GATING_OFF, approvers, loadReports, seedActivePrr } from './work-fixtures.js';

// PLAN M15.5 over HTTP with the real PDP over the real identity read model: every new route asks its PDP action for
// the person first (a person without it is refused before anything is read or written), then the function, which
// checks the rest. B14, B17, the close-out read, the 9.5 audit, 9.4 Learn and the factory M1 decide path.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'work'],
  reader: ['read'],
};
let project: string;
let item: string;

const factoryConfig = () => ({
  ...s.config,
  eligibility: new FactoryM1Eligibility(s.elig, {
    policy: () => readFactoryM1Policy(s.record.pool),
    holders: identityFleetRoleHolders(s.record.pool, s.clock),
  }),
});

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ria', 'gus', 'ada', 'ben', 'vic', 'xan', 'bob']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'ben', 'factory.admin');
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  project = seeded.project;
  approvers(s, project, ['bob']);
  await bindProject(s.id, project, {
    requesters: ['ria'],
    g4: ['gus'],
    x: ['xan'],
    admin: ['bob'],
  });
  const sub = await submitRequest(s.deps, {
    project_id: pid(project),
    repo: seeded.repo,
    lane: 'L3',
    requester: pr('ria'),
    channel: 'N1',
    text: 'A governance route test.',
  });
  if (!sub.ok) throw new Error(sub.error.message);
  item = sub.value.item_id as string;
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
    config: factoryConfig(),
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

async function call(method: string, path: string, body?: unknown, token = TOKENS.bff) {
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
const post = (path: string, body: unknown, token?: string) => call('POST', path, body, token);
const get = (path: string, token?: string) => call('GET', path, undefined, token);

describe('the PDP guard of every M15.5 route', () => {
  it('B14 unsure: only the g4 slot; past the PDP the function says G4 is not open', async () => {
    const path = `/v1/items/${item}/review/unsure`;
    expect((await post(path, { on_behalf_of: 'ria', key: 'u1' })).status).toBe(403);
    expect((await post(path, { on_behalf_of: 'gus', key: 'u1' }, TOKENS.reader)).status).toBe(403);
    expect((await post(path, { on_behalf_of: 'gus' })).status).toBe(400);
    expect((await post(path, { on_behalf_of: 'gus', key: 'u1' })).status).toBe(409);
  });

  it('B17 escape: requesters, g4, x, admin; a person with no binding is refused; no close-out is a conflict', async () => {
    const path = `/v1/items/${item}/escape`;
    const body = (who: string) => ({
      on_behalf_of: who,
      lane: 'L0',
      reason_code: 'bug',
      key: 'e1',
    });
    expect((await post(path, body('vic'))).status).toBe(403);
    expect((await post(path, { ...body('ria'), lane: 'L4' })).status).toBe(400);
    expect((await post(path, body('ria'))).status).toBe(409);
  });

  it('the close-out record: V2 on the item; none recorded yet is 404', async () => {
    expect((await get(`/v1/items/${item}/closeout?on_behalf_of=vic`)).status).toBe(403);
    expect((await get(`/v1/items/${item}/closeout?on_behalf_of=ria`)).status).toBe(404);
  });

  it('9.5 audit: only the g4 slot; no sample drawn is 404', async () => {
    const path = `/v1/items/${item}/audit`;
    const body = (who: string) => ({ on_behalf_of: who, outcome: 'ok', reason_code: 'reviewed' });
    expect((await post(path, body('ria'))).status).toBe(403);
    expect((await post(path, body('xan'))).status).toBe(403);
    expect((await post(path, body('gus'))).status).toBe(404);
  });

  it('9.4 Learn: reading is audit.read (V3), running and asking for a lift is learn.propose (the admin slot)', async () => {
    expect((await get(`/v1/projects/${project}/learn?on_behalf_of=ria`)).status).toBe(403);
    const v = await get(`/v1/projects/${project}/learn?on_behalf_of=bob`);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json).toMatchObject({ project_id: project, proposals: [], mode_e_suspended: false });
    expect((await post(`/v1/projects/${project}/learn/run`, { on_behalf_of: 'ria' })).status).toBe(
      403,
    );
    const run = await post(`/v1/projects/${project}/learn/run`, { on_behalf_of: 'bob' });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json).toEqual({ proposed: [], settled: [] });
    const lift = `/v1/projects/${project}/learn/mode-e-lift`;
    expect((await post(lift, { on_behalf_of: 'gus' })).status).toBe(403);
    expect((await post(lift, { on_behalf_of: 'bob' })).status).toBe(409);
    // a factory admin holds learn.propose everywhere
    expect((await post(lift, { on_behalf_of: 'ada' })).status).toBe(409);
  });

  it('the factory M1 decide path: config.decide for the person, then the kernel bars the proposer', async () => {
    const p = await proposeConfigKey(factoryConfig(), {
      key: LEARN_CONFIG_KEY,
      value: {
        window: 40,
        clean_streak: 10,
        variance_rework: 3,
        edge_hotspot: 5,
        break_glass: 3,
        single_approver: 10,
      },
      principal: pr('ada'),
      parent_rev_hash: null,
    });
    if (!p.ok) throw new Error(p.error.message);
    const gate = p.value.gate_instance_id;
    const view = await get(`/v1/config/revisions/${gate}`, TOKENS.reader);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ proposed_by: 'ada', deciders: ['ben'], quorum: 1 });
    // a project admin is not a factory admin; the reader token has no portal scope
    expect(
      (await post(`/v1/config/revisions/${gate}/prepare`, { on_behalf_of: 'bob' })).status,
    ).toBe(403);
    expect(
      (await post(`/v1/config/revisions/${gate}/prepare`, { on_behalf_of: 'ben' }, TOKENS.reader))
        .status,
    ).toBe(403);
    // the proposer passes the PDP (a factory admin) and the kernel refuses the vote
    const own = await post(`/v1/config/revisions/${gate}/prepare`, { on_behalf_of: 'ada' });
    if (own.status === 200) {
      await post(`/v1/config/revisions/${gate}/evidence`, {
        on_behalf_of: 'ada',
        nonce: own.json.nonce,
        evidence_hash: own.json.evidence_hash,
      });
      const v = await post(`/v1/config/revisions/${gate}/decide`, {
        on_behalf_of: 'ada',
        nonce: own.json.nonce,
        decision: 'approve',
      });
      expect(v.status, JSON.stringify(v.json)).toBe(422);
      expect(v.json.error.message).toMatch(/own_request/);
    }
    const prep = await post(`/v1/config/revisions/${gate}/prepare`, { on_behalf_of: 'ben' });
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    expect(
      (
        await post(`/v1/config/revisions/${gate}/evidence`, {
          on_behalf_of: 'ben',
          nonce: prep.json.nonce,
          evidence_hash: prep.json.evidence_hash,
        })
      ).status,
    ).toBe(200);
    const d = await post(`/v1/config/revisions/${gate}/decide`, {
      on_behalf_of: 'ben',
      nonce: prep.json.nonce,
      decision: 'approve',
    });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ outcome: 'approve', published: true });
    // a project's M1 is not a factory revision
    const proj = await publishSettings(s, project, { wip_limit: 2 }, 'bob');
    expect((await get(`/v1/config/revisions/${proj.gate_instance_id}`)).status).toBe(404);
    expect(
      (await post(`/v1/config/revisions/${proj.gate_instance_id}/prepare`, { on_behalf_of: 'ben' }))
        .status,
    ).toBe(404);
  });
});
