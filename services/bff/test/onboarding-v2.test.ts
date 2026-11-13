import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindProject } from '@aisdlc/identity/testing';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { S0_ID, startFakeCore, type FakeCore } from './portal-fixtures.js';

// Portal v2's agent-led onboarding through the bff (N11-N13): the summary, the one sign-off and "ask the agent again"
// need a session, the CSRF token on a write and the PDP's `project.view`; core gets the principal from the session
// (never one the browser named) and decides the rest (card.decide, the decision kernel).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: BffStack;
let core: FakeCore;
const sessions = new Map<string, { browser: Browser; csrf: string }>();
async function as(who: string) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who as never);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}
async function api(who: string, method: 'GET' | 'POST', path: string, body?: unknown, csrf = true) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && csrf) headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const H = 'a'.repeat(64);
const SUMMARY = {
  s0_id: S0_ID,
  project_id: 'acme',
  repo: 'acme/web',
  status: 'card',
  requested_level: 'census',
  signable_level: 'census',
  steps: [{ step: '0.1', state: 'card', cause: null }],
  waiting: null,
  agent: null,
  fixes: [],
  census: null,
  controls: null,
  role_map: null,
  light: null,
  readiness: { level: 'census', prr: null },
  cards: [],
  sign_off: { state: 'not_ready', note: null, may_sign: true, step_up: null, started_by: null },
  summary_hash: H,
};

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
});
afterAll(async () => {
  await s.stop();
  await core.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  core.projectOfRecords = 'acme';
});

describe('the one onboarding summary and sign-off through the bff', () => {
  it('reads the summary for the signed-in person (core is told who), and a viewer of nothing gets 403', async () => {
    core.override.set(`GET /v1/s0/${S0_ID}/summary?on_behalf_of=alice`, {
      status: 200,
      json: SUMMARY,
    });
    const r = await api('alice', 'GET', `/api/s0/${S0_ID}/summary`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.summary_hash).toBe(H);
    core.projectOfRecords = 'secret';
    expect((await api('alice', 'GET', `/api/s0/${S0_ID}/summary`)).status).toBe(403);
    expect(core.seen.filter((x) => x.path.includes('/summary'))).toHaveLength(1);
  });

  it('a summary that does not match the contract is a 502, never shown', async () => {
    core.override.set(`GET /v1/s0/${S0_ID}/summary?on_behalf_of=alice`, {
      status: 200,
      json: { ...SUMMARY, sign_off: { state: 'approved_by_magic' } },
    });
    expect((await api('alice', 'GET', `/api/s0/${S0_ID}/summary`)).status).toBe(502);
  });

  it('the sign-off goes to core as the session principal; a body naming someone else is refused; CSRF is required', async () => {
    core.override.set(`POST /v1/s0/${S0_ID}/sign-off`, {
      status: 200,
      json: { state: 'in_progress', note: null, decided: [], step_up: null },
    });
    const ok = await api('alice', 'POST', `/api/s0/${S0_ID}/sign-off`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const sent = core.seen.find((x) => x.method === 'POST' && x.path.endsWith('/sign-off'));
    expect(sent?.body).toEqual({ on_behalf_of: 'alice' });
    const forged = await api('alice', 'POST', `/api/s0/${S0_ID}/sign-off`, {
      on_behalf_of: 'root',
    });
    expect(forged.status).toBe(400);
    expect((await api('alice', 'POST', `/api/s0/${S0_ID}/sign-off`, {}, false)).status).toBe(403);
    // core's refusal is relayed
    core.override.set(`POST /v1/s0/${S0_ID}/sign-off`, {
      status: 403,
      json: { error: { code: 'forbidden', message: 'only a person signs off' } },
    });
    expect((await api('alice', 'POST', `/api/s0/${S0_ID}/sign-off`, {})).status).toBe(403);
  });

  it('asks the agent again as the session principal', async () => {
    core.override.set(`POST /v1/s0/${S0_ID}/agent/run`, {
      status: 200,
      json: { state: 'proposed', output_hash: H, fixes: 'x2_pending' },
    });
    const r = await api('alice', 'POST', `/api/s0/${S0_ID}/agent/run`, {});
    expect(r.status).toBe(200);
    expect(core.seen.find((x) => x.path.endsWith('/agent/run'))?.body).toEqual({
      on_behalf_of: 'alice',
    });
  });
});
