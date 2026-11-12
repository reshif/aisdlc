import { bindProject } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// PLAN M18: the bff's notification routes. The person is always the session's (no route names a principal), a
// notification about a project the person can no longer view is left out by the PDP, a preference document is
// checked here and again by the notifier, and a missing or failing notifier answers for these routes only.
// The notifier's own side is services/notifier/test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob';

let s: BffStack;
let notifier: FakeCore;
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

async function api(who: Who, method: 'GET' | 'PUT', path: string, body?: unknown) {
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

const note = (id: string, project: string | null) => ({
  notification_id: id,
  content: {
    kind: project === null ? 'kill_engaged' : 'gate_waiting',
    project_id: project,
    gate_id: project === null ? null : 'G3',
    gate_instance_id: null,
    card_id: null,
    kill_id: null,
    due_at: null,
    link_path: '/inbox',
  },
  reason: 'slot_holder',
  raised_at: '2026-11-12T10:00:00.000Z',
  deliveries: [],
});
const PREFS = {
  principal_id: 'alice',
  preferences: { channels: null, muted_kinds: [], slack_member_id: null },
  set_at: null,
  channels: [
    {
      channel_id: 'team-slack',
      kind: 'slack_webhook',
      display_name: 'Team channel',
      default_on: true,
      data_class_max: 'D1',
    },
  ],
};

beforeAll(async () => {
  notifier = await startFakeCore();
  s = await startBffStack({ override: { notifier: notifier.client } });
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
});
afterAll(async () => {
  await s?.stop();
  await notifier?.stop();
});
beforeEach(() => {
  notifier.seen.length = 0;
  notifier.override.clear();
});

describe('the bff notification routes', () => {
  it('lists the session’s notifications, without those of a project the person cannot view', async () => {
    notifier.override.set('GET /v1/people/alice/notifications?limit=50', {
      status: 200,
      json: {
        notifications: [
          note('0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a71', 'acme'),
          note('0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a72', 'secret'),
          note('0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a73', null),
        ],
      },
    });
    const r = await api('alice', 'GET', '/api/me/notifications');
    expect(r.status).toBe(200);
    expect(r.json.notifications.map((n: Json) => n.content.project_id)).toEqual(['acme', null]);
    expect(notifier.seen.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/people/alice/notifications?limit=50',
    ]);
    expect((await api('alice', 'GET', '/api/me/notifications?limit=500')).status).toBe(400);
  });

  it('reads and replaces the session’s own preferences only, with the CSRF check', async () => {
    notifier.override.set('GET /v1/people/bob/preferences', {
      status: 200,
      json: { ...PREFS, principal_id: 'bob' },
    });
    expect((await api('bob', 'GET', '/api/me/notifications/preferences')).json.principal_id).toBe(
      'bob',
    );
    notifier.override.set('POST /v1/people/bob/preferences', {
      status: 200,
      json: {
        ...PREFS,
        principal_id: 'bob',
        preferences: { channels: [], muted_kinds: [], slack_member_id: null },
      },
    });
    const body = { preferences: { channels: [], muted_kinds: [], slack_member_id: null } };
    const r = await api('bob', 'PUT', '/api/me/notifications/preferences', body);
    expect(r.status).toBe(200);
    expect(notifier.seen.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/people/bob/preferences',
      body,
    });
    // a body naming someone else is not a body this route takes
    const other = await api('bob', 'PUT', '/api/me/notifications/preferences', {
      ...body,
      principal_id: 'alice',
    });
    expect(other.status).toBe(400);
    // a kill cannot be muted (the contract, checked before the notifier is asked)
    const n = notifier.seen.length;
    const mute = await api('bob', 'PUT', '/api/me/notifications/preferences', {
      preferences: { channels: [], muted_kinds: ['kill_engaged'], slack_member_id: null },
    });
    expect(mute.status).toBe(400);
    expect(notifier.seen.length).toBe(n);
    // without the CSRF token: refused before anything is sent
    const v = await as('bob');
    const raw = await v.browser.request(`${s.base}/api/me/notifications/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(raw.status).toBe(403);
  });

  it('passes the notifier’s refusal, and answers 502 when it fails, for these routes only', async () => {
    notifier.override.set('POST /v1/people/alice/preferences', {
      status: 400,
      json: { error: { code: 'unknown_channel', message: 'no enabled channel x' } },
    });
    const r = await api('alice', 'PUT', '/api/me/notifications/preferences', {
      preferences: { channels: ['x-chan'], muted_kinds: [], slack_member_id: null },
    });
    expect(r).toMatchObject({ status: 400, json: { error: { code: 'unknown_channel' } } });
    notifier.override.set('GET /v1/people/alice/preferences', { status: 500, json: {} });
    expect((await api('alice', 'GET', '/api/me/notifications/preferences')).status).toBe(502);
    // the rest of the portal does not depend on it
    expect((await api('alice', 'GET', '/api/me')).status).toBe(200);
  });
});

describe('without a notifier', () => {
  it('answers 503 on the notification routes', async () => {
    const t = await startBffStack();
    try {
      const { browser } = await signIn(t, 'alice');
      const r = await browser.request(`${t.base}/api/me/notifications`);
      expect(r.status).toBe(503);
    } finally {
      await t.stop();
    }
  });
});
