import {
  DECISION_BATCH_MAX,
  DecisionBatchView,
  MyAccessView,
  NOT_VISIBLE_REASON,
  pdpResource,
} from '@aisdlc/contracts';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, grantFleetRole, grantRole } from '@aisdlc/identity/testing';
import { BootstrapPdpEntities } from '@aisdlc/onboarding';
import { MemoryDecisionLog, Pdp, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import type { PdpEntityPort } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// GET /api/me/access and POST /api/me/decisions (portal-coverage §6 step 2) on a real Postgres,
// the real identity read model and the real PDP. The answers are hints for the browser: the last
// test shows that a write the hint called allowed is still refused once the PDP says no.

type Who = 'alice' | 'bob' | 'carol' | 'dora' | 'root';

let s: BffStack;
let core: FakeCore;
// The PDP of this stack, with a bundle the test can take away (a PDP with no bundle denies everything).
const source = new StaticBundleSource(buildBundle());
let entities: PdpEntityPort | null = null;
const log = new MemoryDecisionLog();
const pdp = new Pdp({
  source,
  log,
  entities: {
    principalFacts: (...a) => (entities as PdpEntityPort).principalFacts(...a),
  },
});
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as { csrf_token: string };
  const v = { browser, csrf: me.csrf_token };
  sessions.set(who, v);
  return v;
}

async function call(
  who: Who | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  csrf = true,
) {
  const v = who ? await as(who) : { browser: new Browser(), csrf: '' };
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && csrf) headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as unknown) : null };
}

const decide = async (who: Who, queries: unknown[]) => {
  const r = await call(who, 'POST', '/api/me/decisions', { queries });
  expect(r.status).toBe(200);
  return DecisionBatchView.parse(r.json).decisions;
};

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client, pdp } });
  const pool = s.identity.record.pool;
  entities = new BootstrapPdpEntities(new IdentityPdpEntities({ pool }), { db: pool });
  await bindProject(s.identity, 'acme', {
    admin: ['alice'],
    intent: ['bob'],
    requesters: ['carol'],
  });
  await grantRole(s.identity.deps, 'alice', 'project.viewer', { kind: 'project', ref: 'beta' });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
});

describe('GET /api/me/access', () => {
  it('needs a session: 401 without one', async () => {
    const r = await call(null, 'GET', '/api/me/access');
    expect(r.status).toBe(401);
    expect(r.text).not.toContain('acme');
  });

  it("lists the person's bindings and per project the view level, data class and allowed actions", async () => {
    const r = await call('alice', 'GET', '/api/me/access');
    expect(r.status).toBe(200);
    const v = MyAccessView.parse(r.json);
    expect(v.principal.principal_id).toBe('alice');
    expect(v.bindings.map((b) => `${b.role_id}@${b.scope.kind}:${b.scope.ref}`).sort()).toEqual([
      'project.admin@project:acme',
      'project.viewer@project:beta',
    ]);
    expect(v.bindings.every((b) => b.blockers.length === 0)).toBe(true);
    expect(v.fleet).toMatchObject({ view_level: null, data_class: null, roles: [] });
    const acme = v.projects.find((p) => p.project_id === 'acme');
    const beta = v.projects.find((p) => p.project_id === 'beta');
    expect(acme).toMatchObject({ view_level: 'V3', data_class: 'D1', roles: ['project.admin'] });
    expect(acme?.actions).toContain('project.view');
    expect(beta).toMatchObject({ view_level: 'V1', data_class: 'D0', roles: ['project.viewer'] });
    expect(beta?.actions).not.toContain('work.request');
  });

  it('a fleet role shows as fleet access, with the fleet actions the PDP allows', async () => {
    const v = MyAccessView.parse((await call('root', 'GET', '/api/me/access')).json);
    expect(v.fleet).toMatchObject({ view_level: 'V3', data_class: 'D2', roles: ['factory.admin'] });
    expect(v.fleet.actions).toContain('project.onboard');
    expect(v.projects).toEqual([]);
  });

  it('someone with no role sees no project at all, not even that one exists', async () => {
    const r = await call('dora', 'GET', '/api/me/access');
    const v = MyAccessView.parse(r.json);
    expect(v.bindings).toEqual([]);
    expect(v.projects).toEqual([]);
    expect(r.text).not.toContain('acme');
  });
});

describe('POST /api/me/decisions', () => {
  it('needs a session (401) and the CSRF token (403)', async () => {
    const q = [{ action: 'project.view', resource: pdpResource.project('acme') }];
    expect((await call(null, 'POST', '/api/me/decisions', { queries: q })).status).toBe(401);
    expect((await call('alice', 'POST', '/api/me/decisions', { queries: q }, false)).status).toBe(
      403,
    );
  });

  it('refuses an empty batch, one over the limit, an unknown action and a malformed resource', async () => {
    const one = { action: 'project.view', resource: pdpResource.project('acme') };
    for (const queries of [
      [],
      Array.from({ length: DECISION_BATCH_MAX + 1 }, () => one),
      [{ action: 'project.nuke', resource: pdpResource.project('acme') }],
      [{ action: 'project.view', resource: { type: 'Project', id: 'acme' } }],
    ]) {
      expect((await call('alice', 'POST', '/api/me/decisions', { queries })).status).toBe(400);
    }
  });

  it('answers each pair with the real PDP: allow with the permitting policy, deny with its reason', async () => {
    const [view, onboard, gate, request] = await decide('alice', [
      { action: 'project.view', resource: pdpResource.project('acme') },
      { action: 'project.onboard', resource: pdpResource.fleet() },
      { action: 'gate.decide', resource: pdpResource.gate('acme', 'g-1', 'G2') },
      { action: 'work.request', resource: pdpResource.project('beta') },
    ]);
    expect(view).toMatchObject({ allow: true });
    expect(view?.reasons.join(' ')).toContain('project.admin');
    expect(onboard?.allow).toBe(false);
    expect(onboard?.reasons.length).toBeGreaterThan(0);
    expect(gate?.allow).toBe(false); // G2 is the intent slot's, not the admin's
    expect(request?.allow).toBe(false);
    expect(request?.reasons).not.toEqual([NOT_VISIBLE_REASON]); // beta is visible to alice
    const [bobGate] = await decide('bob', [
      { action: 'gate.decide', resource: pdpResource.gate('acme', 'g-1', 'G2') },
    ]);
    expect(bobGate?.allow).toBe(true);
  });

  it('a project the person cannot view answers exactly like one that does not exist', async () => {
    const strip = (ds: Awaited<ReturnType<typeof decide>>) =>
      ds.map((d) => ({ action: d.action, allow: d.allow, reasons: d.reasons }));
    const real = await decide('dora', [
      { action: 'project.view', resource: pdpResource.project('acme') },
      { action: 'item.view_floor', resource: pdpResource.item('acme', 'i-1') },
      { action: 'gate.decide', resource: pdpResource.gate('acme', 'g-1', 'G2') },
    ]);
    const none = await decide('dora', [
      { action: 'project.view', resource: pdpResource.project('no-such') },
      { action: 'item.view_floor', resource: pdpResource.item('no-such', 'i-1') },
      { action: 'gate.decide', resource: pdpResource.gate('no-such', 'g-1', 'G2') },
    ]);
    expect(strip(real)).toEqual(strip(none));
    expect(real.every((d) => !d.allow && d.reasons[0] === NOT_VISIBLE_REASON)).toBe(true);
  });

  it('writes nothing to the decision log (capability probes)', async () => {
    const before = log.records.length;
    await decide('dora', [{ action: 'project.onboard', resource: pdpResource.fleet() }]);
    await decide('alice', [{ action: 'project.view', resource: pdpResource.project('acme') }]);
    expect(log.records.length).toBe(before);
    // a real refusal on a route is logged, so the log is wired
    await call('dora', 'POST', '/api/onboard', {
      project_id: 'x1',
      repo: 'acme/x1',
      level: 'census',
    });
    expect(log.records.length).toBeGreaterThan(before);
  });
});

describe('the hint never grants', () => {
  it('a write the browser was told is allowed is refused once the PDP says no', async () => {
    const body = { project_id: 'acme', repo: 'acme/web', lane: 'L3', text: 'Add pagination.' };
    const [hint] = await decide('carol', [
      { action: 'work.request', resource: pdpResource.project('acme') },
    ]);
    expect(hint?.allow).toBe(true);

    // The PDP loses its bundle (fail closed): the browser still holds the old "allowed".
    source.set(null);
    try {
      core.seen.length = 0;
      const r = await call('carol', 'POST', '/api/requests', body);
      expect(r.status).toBe(403);
      expect(core.seen).toEqual([]);
    } finally {
      source.set(buildBundle());
    }
    const r = await call('carol', 'POST', '/api/requests', body);
    expect(r.status).toBe(201);
  });
});
