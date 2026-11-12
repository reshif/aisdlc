import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { buildBundle, bundleWithoutPolicies } from '@aisdlc/pdp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { S0_ID, startFakeCore, type FakeCore } from './portal-fixtures.js';

// PLAN §7a (2026-11-12): the routes that moved off a stand-in now ask the new action. The proof is a real PDP over a
// bundle that withholds exactly the new action from a role that keeps the old one: carol is a factory auditor who
// still holds `audit.read` but not `ops.read` or `quality.read`; alice administers acme and still holds
// `project.view` but not `assistant.use`; root is a factory admin who still holds `config.decide` but not
// `identity.admin`. Every one of them is refused the switched route, the refusal names the new action, and nothing
// reaches core or the audit service. The routes with the full bundle are in portal-lists.test.ts and its neighbours.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
type Json = any;
type Who = 'alice' | 'carol' | 'root';

const WITHHELD = [
  'role/factory.auditor/ops.read',
  'role/factory.auditor/quality.read',
  'role/project.admin/assistant.use',
  'role/factory.admin/identity.admin',
] as const;

let s: BffStack;
let core: FakeCore;
let sc: FakeCore;
let audit: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(who: Who, method: 'GET' | 'POST', path: string, body?: unknown) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

beforeAll(async () => {
  core = await startFakeCore();
  sc = await startFakeCore();
  audit = await startFakeCore();
  s = await startBffStack({
    bundle: bundleWithoutPolicies(buildBundle(), WITHHELD),
    override: { core: core.client, sandboxController: sc.client, audit: audit.client },
  });
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
  await grantFleetRole(s.identity.deps, 'carol', 'factory.auditor');
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
  await sc?.stop();
  await audit?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  sc.seen.length = 0;
  audit.seen.length = 0;
});

/** A 403 that names the action (the portal routes say `<action> denied`, the audit routes `<action> is needed`). */
const refusedFor = (r: { status: number; json: Json }, action: string) => {
  expect(r.status).toBe(403);
  expect(r.json.error.message).toMatch(
    new RegExp(`^${action.replace('.', '\\.')} (denied|is needed)$`),
  );
};

describe('the switched routes ask the new action (PLAN §7a)', () => {
  it('Operate is ops.read: an auditor with audit.read but not ops.read is refused every Operate read', async () => {
    for (const path of ['/api/admission', '/api/slots', '/api/controls', '/api/kills']) {
      refusedFor(await api('carol', 'GET', path), 'ops.read');
    }
    // lifting a control first reads the controls: the same guard, before control.lift
    refusedFor(
      await api('carol', 'POST', '/api/controls/55555555-6666-4777-8888-999999999999/lift', {
        reason: 'done',
      }),
      'ops.read',
    );
    expect(core.seen).toEqual([]);
    expect(sc.seen).toEqual([]);
  });

  it('Quality is quality.read: the same auditor is refused agents, agent stats, evals and scores', async () => {
    for (const path of [
      '/api/agents',
      '/api/agents/A1/stats',
      '/api/agents/A1/scores',
      '/api/evals/summary',
      '/api/evals/runs',
    ]) {
      refusedFor(await api('carol', 'GET', path), 'quality.read');
    }
    expect(core.seen).toEqual([]);
  });

  it('integrations (Quality and Operate Health) need quality.read or ops.read: neither is the first one named', async () => {
    refusedFor(await api('carol', 'GET', '/api/integrations'), 'quality.read');
    expect(core.seen).toEqual([]);
  });

  it('audit.read itself still opens the audit reads that did not move', async () => {
    core.override.set('GET /v1/audit/decisions?on_behalf_of=carol', {
      status: 200,
      json: { decisions: [] },
    });
    expect((await api('carol', 'GET', '/api/audit/decisions')).status).toBe(200);
    core.override.clear();
  });

  it('erasure and legal hold are identity.admin: a factory admin who still holds config.decide is refused', async () => {
    const hold = {
      scope: { kind: 'principal', principal_id: 'carol' },
      matter_ref: 'LA-1',
      reason: 'litigation',
    };
    refusedFor(await api('root', 'POST', '/api/audit/holds', hold), 'identity.admin');
    refusedFor(
      await api('root', 'POST', '/api/audit/erasures', {
        subject: { principal_id: 'carol', project_id: null },
        reason: 'SAR',
      }),
      'identity.admin',
    );
    expect(audit.seen).toEqual([]);
  });

  it('the assistant is assistant.use as well as project.view: the project admin is refused before core', async () => {
    const r = await api('alice', 'POST', '/api/assistant/ask', {
      subject: { kind: 'project', project_id: 'acme' },
      text: 'What waits?',
    });
    refusedFor(r, 'assistant.use');
    const onboarding = await api('alice', 'POST', '/api/assistant/ask', {
      subject: { kind: 's0', s0_id: S0_ID },
      text: 'Why is card 4 waiting?',
    });
    refusedFor(onboarding, 'assistant.use');
    expect(core.seen.some((x) => x.path === '/v1/assistant/ask')).toBe(false);
  });

  it('/api/me lists what the bundle grants: the auditor keeps audit.read and has neither ops.read nor quality.read', async () => {
    const me = (await (
      await (await as('carol')).browser.request(`${s.base}/api/me`)
    ).json()) as Json;
    expect(me.actions.fleet).toContain('audit.read');
    expect(me.actions.fleet).not.toContain('ops.read');
    expect(me.actions.fleet).not.toContain('quality.read');
  });
});
