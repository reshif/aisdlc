import { bindProject } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { S0_ID, startFakeCore, type FakeCore } from './portal-fixtures.js';

// PLAN M18: the bff's assistant routes in front of core. The person is the session's, their data class on the
// subject's project is read from their roles and sent along (never taken from the body), the PDP is asked here
// (`project.view`) before core is, and what core answers is passed through checked against the contracts.
// The assistant's own behaviour is services/core/test/assistant.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob';

let s: BffStack;
let core: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();
const THREAD = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a00';
const ASK = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a01';
const PAYLOAD = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a02';
const H = 'a'.repeat(64);

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
  if (method !== 'GET') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const thread = {
  thread_id: THREAD,
  owner: 'alice',
  subject: { kind: 's0', s0_id: S0_ID, project_id: 'acme' },
  title: 'Why is card 4 waiting?',
  turns: 2,
  created_at: '2026-11-12T10:00:00.000Z',
  updated_at: '2026-11-12T10:00:01.000Z',
};
const turn = (seq: number, role: 'person' | 'assistant') => ({
  thread_id: THREAD,
  seq,
  role,
  kind: role === 'person' ? 'message' : 'answer',
  at: '2026-11-12T10:00:00.000Z',
  payload: { payload_id: PAYLOAD, sha256: H, redactions: [], erased_at: null },
  text: role === 'person' ? 'Why is card 4 waiting?' : 'Step 0.4 waits on card 4.',
  citations: role === 'person' ? [] : [{ kind: 'record', ref: `s0:${S0_ID}` }],
  proposals: [],
  drafts: [],
  flags: [],
  refusal: null,
  grounding_sha: role === 'person' ? null : 'b'.repeat(40),
  ask_id: ASK,
});
const budget = {
  group_id: `assistant_user_day:${'c'.repeat(24)}:2026-11-12`,
  max_tokens: 200000,
  max_cost_micro_usd: 2000000,
  used_tokens: 10,
  used_cost_micro_usd: 20,
  exhausted: false,
  resets_at: '2026-11-13T00:00:00.000Z',
};
const askResult = {
  thread,
  turns: [turn(1, 'person'), turn(2, 'assistant')],
  ask: {
    ask_id: ASK,
    thread_id: THREAD,
    principal: 'alice',
    budget_group: budget.group_id,
    vkey_id: 'k1',
    grounding_sha: 'b'.repeat(40),
    context_sha256: H,
    outcome: 'answered',
    refusal: null,
    attempts: 1,
    tokens_in: 5,
    tokens_out: 5,
    started_at: '2026-11-12T10:00:00.000Z',
    finished_at: '2026-11-12T10:00:01.000Z',
  },
  budget,
};

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
});

describe('the bff assistant routes (PLAN M18)', () => {
  it('asks as the session, with the data class of its roles, after the PDP said project.view', async () => {
    core.override.set('POST /v1/assistant/ask', { status: 201, json: askResult });
    const r = await api('alice', 'POST', '/api/assistant/ask', {
      subject: { kind: 's0', s0_id: S0_ID },
      text: 'Why is card 4 waiting?',
    });
    expect(r.status).toBe(201);
    expect(r.json.turns).toHaveLength(2);
    const sent = core.seen.find((x) => x.path === '/v1/assistant/ask');
    expect(sent?.body).toMatchObject({
      subject: { kind: 's0', s0_id: S0_ID },
      on_behalf_of: 'alice',
      viewer_data_class: expect.stringMatching(/^D[0-2]$/),
    });
  });

  it('refuses a body that names a person or a data class, and a person without the project', async () => {
    for (const extra of [{ on_behalf_of: 'bob' }, { viewer_data_class: 'D2' }]) {
      const r = await api('alice', 'POST', '/api/assistant/ask', {
        subject: { kind: 'project', project_id: 'acme' },
        text: 'hi',
        ...extra,
      });
      expect(r.status).toBe(400);
    }
    const r = await api('bob', 'POST', '/api/assistant/ask', {
      subject: { kind: 'project', project_id: 'acme' },
      text: 'hi',
    });
    expect(r.status).toBe(403);
    expect(core.seen.some((x) => x.path === '/v1/assistant/ask')).toBe(false);
  });

  it('reads the session’s own threads and budget, and passes core’s refusal', async () => {
    core.override.set(`GET /v1/assistant/threads?on_behalf_of=alice&s0=${S0_ID}`, {
      status: 200,
      json: { threads: [thread] },
    });
    const list = await api('alice', 'GET', `/api/assistant/threads?s0=${S0_ID}`);
    expect(list.json.threads).toHaveLength(1);
    core.override.set(`GET /v1/assistant/threads/${THREAD}?on_behalf_of=alice`, {
      status: 200,
      json: {
        thread,
        turns: askResult.turns,
        grounding: { repo: 'acme/web', census_sha: 'b'.repeat(40), stale: true },
        budget,
      },
    });
    const one = await api('alice', 'GET', `/api/assistant/threads/${THREAD}`);
    expect(one.json.grounding.stale).toBe(true);
    core.override.set(`GET /v1/assistant/threads/${THREAD}?on_behalf_of=bob`, {
      status: 404,
      json: { error: { code: 'not_found', message: 'no such thread' } },
    });
    expect((await api('bob', 'GET', `/api/assistant/threads/${THREAD}`)).status).toBe(404);
    core.override.set('GET /v1/assistant/budget?on_behalf_of=alice', { status: 200, json: budget });
    expect((await api('alice', 'GET', '/api/assistant/budget')).json.exhausted).toBe(false);
    core.override.set('GET /v1/assistant/budget?on_behalf_of=alice', {
      status: 503,
      json: { error: { code: 'unavailable', message: 'off' } },
    });
    expect((await api('alice', 'GET', '/api/assistant/budget')).status).toBe(502);
  });
});
