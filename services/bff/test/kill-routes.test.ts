import { grantFleetRole } from '@aisdlc/identity/testing';
import { startTestKillswitch, type TestKillswitch } from '@aisdlc/killswitch/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreClient } from '../src/core-client.js';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';

// RC-UI-1: the kill switch in the portal. A real kill switch (its own database, its own PDP over its own facts, the
// bff's step-up key read from key custody) behind the bff's routes: a factory admin requests a fleet kill with their
// own re-authentication, the release needs a second factory admin's own step-up, a proof that is not the session's
// own or not for this act is refused before it leaves the bff, and nobody without the right gets as far as the hash.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob' | 'carol';

let s: BffStack;
let ks: TestKillswitch;
let real: CoreClient | null = null;
// the bff is started before the kill switch (the kill switch reads the bff's step-up key from the same custody)
const lazy: CoreClient = {
  call: (m, p, b) => {
    if (!real) throw new Error('no kill switch yet');
    return real.call(m, p, b);
  },
};
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

beforeAll(async () => {
  s = await startBffStack({ override: { killswitch: lazy } });
  ks = await startTestKillswitch({
    custody: s.identity.kms.custodyFor('killswitch'),
    stepUpSigner: s.identity.kms.custodyFor('bff'),
    clock: s.identity.clock,
    admins: ['alice', 'bob'],
  });
  real = new HttpCoreClient({ baseUrl: ks.url, token: ks.tokens['bff'] as string });
  await grantFleetRole(s.identity.deps, 'alice', 'factory.admin');
  await grantFleetRole(s.identity.deps, 'bob', 'factory.admin');
}, 120_000);
afterAll(async () => {
  await ks?.stop();
  await s?.stop();
});

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

/** The person re-authenticates at the dev IdP for exactly `hash` and collects the proof, as the Kill page does. */
async function stepUp(who: Who, hash: string): Promise<string> {
  const started = await api(who, 'POST', '/api/step-up', {
    subject_hash: hash,
    return_to: '/kill',
  });
  expect(started.status).toBe(200);
  const v = await as(who);
  const { chain } = await v.browser.follow(started.json.authorize_url as string);
  const back = new URL(chain.at(-1) as string);
  expect(back.pathname).toBe('/kill');
  const got = await api(who, 'GET', `/api/step-up/${back.searchParams.get('step_up') as string}`);
  expect(got.status).toBe(200);
  return got.json.proof as string;
}

const FLEET = { kind: 'fleet', ref: '*' };

describe('the kill switch in the portal (RC-UI-1)', () => {
  it('a factory admin kills the fleet with their own step-up; two others release it, each with their own', async () => {
    const reason = 'portal drill';
    const prep = await api('alice', 'POST', '/api/kills/prepare', { scope: FLEET, reason });
    expect(prep.status).toBe(200);
    const proof = await stepUp('alice', prep.json.bound_hash);
    // a proof for another reason is not this act: refused at the bff
    const other = await api('alice', 'POST', '/api/kills', {
      scope: FLEET,
      reason: 'another reason',
      step_up: { proof },
    });
    expect(other.status).toBe(401);
    expect(other.json.error.code).toBe('step_up_mismatch');
    const k = await api('alice', 'POST', '/api/kills', {
      scope: FLEET,
      reason,
      step_up: { proof },
    });
    expect(k.status).toBe(201);
    expect(k.json).toMatchObject({ state: 'active', requested_by: 'alice', release_required: 2 });
    // the proof is single-use at the kill switch
    const again = await api('alice', 'POST', '/api/kills', {
      scope: FLEET,
      reason,
      step_up: { proof },
    });
    expect(again.status).toBe(401);

    const active = await api('bob', 'GET', '/api/kills/active');
    expect(active.status).toBe(200);
    expect(active.json.kills).toHaveLength(1);
    expect(active.json.kills[0]).toMatchObject({ may_release: true, approved_by_me: false });

    const id = k.json.kill_id as string;
    const rp = await api('alice', 'POST', `/api/kills/${id}/release/prepare`, {});
    const a1 = await api('alice', 'POST', `/api/kills/${id}/release`, {
      step_up: { proof: await stepUp('alice', rp.json.bound_hash) },
    });
    expect(a1.status).toBe(200);
    expect(a1.json).toMatchObject({ state: 'release_pending', release_approvals: ['alice'] });
    // bob cannot send alice's proof (not his session's) - and alice's second approval is still one person
    const alices = await stepUp('alice', rp.json.bound_hash);
    const stolen = await api('bob', 'POST', `/api/kills/${id}/release`, {
      step_up: { proof: alices },
    });
    expect(stolen.status).toBe(401);
    const twice = await api('alice', 'POST', `/api/kills/${id}/release`, {
      step_up: { proof: alices },
    });
    expect(twice.status).toBe(409);
    const mine = await api('alice', 'GET', '/api/kills/active');
    expect(mine.json.kills[0]).toMatchObject({ approved_by_me: true });

    const rb = await api('bob', 'POST', `/api/kills/${id}/release/prepare`, {});
    const a2 = await api('bob', 'POST', `/api/kills/${id}/release`, {
      step_up: { proof: await stepUp('bob', rb.json.bound_hash) },
    });
    expect(a2.status).toBe(200);
    expect(a2.json).toMatchObject({ state: 'released' });
    expect(a2.json.release_approvals.sort()).toEqual(['alice', 'bob']);
    expect((await api('bob', 'GET', '/api/kills/active')).json.kills).toEqual([]);
  });

  it('nobody without the right gets the hash, the act or the list; a bad body is refused', async () => {
    expect(
      (await api('carol', 'POST', '/api/kills/prepare', { scope: FLEET, reason: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await api('carol', 'POST', '/api/kills', {
          scope: FLEET,
          reason: 'x',
          step_up: { proof: 'su1.x.y' },
        })
      ).status,
    ).toBe(403);
    expect((await api('carol', 'GET', '/api/kills/active')).status).toBe(403);
    expect(
      (
        await api('alice', 'POST', '/api/kills/prepare', {
          scope: { kind: 'team', ref: 'x' },
          reason: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          'alice',
          'POST',
          '/api/kills/00000000-0000-7000-8000-000000000000/release/prepare',
          {},
        )
      ).status,
    ).toBe(404);
  });

  it('answers 503 without a kill switch configured, and CSRF still applies', async () => {
    const t = await startBffStack();
    try {
      await grantFleetRole(t.identity.deps, 'alice', 'factory.admin');
      const { browser } = await signIn(t, 'alice');
      const me = (await (await browser.request(`${t.base}/api/me`)).json()) as Json;
      const noCsrf = await browser.request(`${t.base}/api/kills/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: FLEET, reason: 'x' }),
      });
      expect(noCsrf.status).toBe(403);
      const r = await browser.request(`${t.base}/api/kills/active`, {
        headers: { 'x-csrf-token': me.csrf_token },
      });
      expect(r.status).toBe(503);
    } finally {
      await t.stop();
    }
  });
});
