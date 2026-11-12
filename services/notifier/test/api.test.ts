import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationList, NotificationPreferencesView } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootNotifier } from '../src/boot.js';
import { startWorld, type World } from './fixture.js';

// PLAN M18: the notifier as a process boundary. It boots as its least-privilege role from the environment, serves
// only the bff (scope `people`), answers health without a credential, reads the published channel rows (none by
// default, so nothing can be chosen) and refuses a preference that names a channel that is not there.

let w: World;
let dir: string;
let svc: Awaited<ReturnType<typeof bootNotifier>>;
const TOKEN = 'bff-notifier-token-0123456789';
const logs: string[] = [];

beforeAll(async () => {
  // the booted service runs on the real clock: memberships and events must not be in its future
  w = await startWorld({ start: new Date(Date.now() - 60_000).toISOString() });
  dir = mkdtempSync(join(tmpdir(), 'notifier-api-'));
  writeFileSync(join(dir, 'tok'), TOKEN);
  writeFileSync(join(dir, 'db'), w.roleUrl);
  svc = await bootNotifier(
    {
      NOTIFIER_DATABASE_URL: `file:${join(dir, 'db')}`,
      NOTIFIER_CALLERS: JSON.stringify({
        bff: { token_ref: `file:${join(dir, 'tok')}`, scopes: ['people'] },
      }),
      NOTIFIER_PORTAL_URL: 'https://factory.example',
      NOTIFIER_PORT: '0',
      NOTIFIER_RAISE_INTERVAL_MS: '50',
      NOTIFIER_DELIVER_INTERVAL_MS: '50',
    },
    { factory: w.factory, log: (l) => logs.push(l) },
  );
}, 120_000);
afterAll(async () => {
  await svc?.close();
  await w?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(new URL(path, svc.url), {
    ...init,
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });

describe('the notifier API', () => {
  it('answers health without a credential and everything else only to its callers', async () => {
    expect((await call('/healthz', { token: null })).status).toBeLessThan(600);
    expect((await call('/v1/people/dana/preferences', { token: null })).status).toBe(401);
    expect((await call('/v1/people/dana/preferences', { token: 'x'.repeat(30) })).status).toBe(401);
    expect((await call('/v1/people/bad%20id/preferences')).status).toBe(400);
  });

  it('serves the defaults, refuses an unknown channel, and stores a choice as a record event', async () => {
    const r = await call('/v1/people/dana/preferences');
    const v = NotificationPreferencesView.parse(await r.json());
    expect(v).toMatchObject({ principal_id: 'dana', set_at: null, channels: [] });
    expect(v.preferences.channels).toBeNull();
    const bad = await call('/v1/people/dana/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { channels: ['team-slack'], muted_kinds: [], slack_member_id: null },
      }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('unknown_channel');
    const mute = await call('/v1/people/dana/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { channels: [], muted_kinds: ['kill_engaged'], slack_member_id: null },
      }),
    });
    expect(mute.status).toBe(400);
    const ok = await call('/v1/people/dana/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { channels: [], muted_kinds: ['quarantine'], slack_member_id: 'U0DANA1' },
      }),
    });
    expect(ok.status).toBe(200);
    const after = NotificationPreferencesView.parse(await ok.json());
    expect(after.preferences.muted_kinds).toEqual(['quarantine']);
    const ev = await w.db.pool.query<{ actor: string }>(
      `SELECT actor FROM record.record_event WHERE stream = 'notifier-pref:dana'`,
    );
    expect(ev.rows).toEqual([{ actor: 'system.notifier' }]);
  });

  it('raises from the record on its own loop and lists the person’s notifications', async () => {
    // the loop placed its cursor at the head when it started; a gate opened now is notified
    await new Promise((r) => setTimeout(r, 300));
    await w.gateOpened({ gate: 'G3d', slot: 'design' });
    let list = NotificationList.parse({ notifications: [] });
    for (let i = 0; i < 60 && list.notifications.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      list = NotificationList.parse(
        await (await call('/v1/people/dana/notifications?limit=10')).json(),
      );
    }
    expect(list.notifications[0]?.content.gate_id).toBe('G3d');
    // dana chose no channel: the inbox only
    expect(list.notifications[0]?.deliveries).toEqual([]);
    expect((await call('/v1/people/dana/notifications?limit=0')).status).toBe(400);
    expect(logs.join('\n')).not.toMatch(/@example\.com|token/);
  });
});
