import { manualClock } from '@aisdlc/kernel';
import { bindProject } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, TokenBuckets } from '../src/rate-limit.js';
import { Browser, SUBJECTS, signIn, startBffStack, type BffStack } from '../src/testing.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('TokenBuckets', () => {
  it('allows the burst, then one per refill interval, and says how long to wait', () => {
    const clock = manualClock(0);
    const b = new TokenBuckets({ capacity: 3, refillPerSecond: 0.5 }, clock);
    expect([1, 2, 3].map(() => b.take('k').ok)).toEqual([true, true, true]);
    const refused = b.take('k');
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 2 });
    clock.advance(1000);
    expect(b.take('k')).toEqual({ ok: false, retryAfterSeconds: 1 });
    clock.advance(1000);
    expect(b.take('k').ok).toBe(true);
    expect(b.take('k').ok).toBe(false);
    clock.advance(60_000); // never more than the capacity, however long it rests
    expect([1, 2, 3, 4].map(() => b.take('k').ok)).toEqual([true, true, true, false]);
  });

  it('keeps keys apart and drops full buckets when it holds too many', () => {
    const clock = manualClock(0);
    const b = new TokenBuckets({ capacity: 1, refillPerSecond: 1 }, clock, 3);
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
    expect(b.take('b').ok).toBe(true);
    clock.advance(5000); // a and b are full again
    for (const k of ['c', 'd', 'e']) expect(b.take(k).ok).toBe(true);
    expect(b.size).toBeLessThanOrEqual(3);
  });

  it('documents limits an honest user does not meet: a sign-in every few seconds is fine', () => {
    expect(DEFAULT_RATE_LIMITS.login.capacity).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_RATE_LIMITS.stepUpPrincipal.capacity).toBeLessThan(
      DEFAULT_RATE_LIMITS.stepUpIp.capacity,
    );
  });
});

describe('the bff routes', () => {
  let s: BffStack;
  beforeAll(async () => {
    s = await startBffStack({
      override: {
        rateLimits: {
          login: { capacity: 2, refillPerSecond: 1 / 30 },
          stepUpIp: { capacity: 10, refillPerSecond: 1 / 30 },
          stepUpPrincipal: { capacity: 2, refillPerSecond: 1 / 30 },
        },
      },
    });
    await bindProject(s.identity, 'acme', { admin: ['alice'] });
  });
  afterAll(async () => {
    await s.stop();
  });

  it('/auth/login: 429 with Retry-After once the IP has used its burst, and again after the wait', async () => {
    const b = new Browser();
    expect((await b.request(`${s.base}/auth/login`)).status).toBe(302);
    expect((await b.request(`${s.base}/auth/login`)).status).toBe(302);
    const third = await b.request(`${s.base}/auth/login`);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('30');
    expect(((await third.json()) as Json).error.code).toBe('rate_limited');
    expect(third.headers.get('location')).toBeNull();
    // A refused request started no sign-in attempt.
    const before = await s.identity.record.pool.query(
      'SELECT count(*)::int AS n FROM bff.oidc_attempt',
    );
    await b.request(`${s.base}/auth/login`);
    const after = await s.identity.record.pool.query(
      'SELECT count(*)::int AS n FROM bff.oidc_attempt',
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    s.identity.clock.advance(31_000);
    expect((await b.request(`${s.base}/auth/login`)).status).toBe(302);
  });

  it('the step-up start: limited per principal, not for another principal, and Retry-After says when', async () => {
    s.identity.clock.advance(120_000); // the login bucket is not in play here
    const alice = (await signIn(s, 'alice')).browser;
    const bob = (await signIn(s, 'bob')).browser;
    const csrf = async (b: Browser) =>
      ((await (await b.request(`${s.base}/api/me`)).json()) as Json).csrf_token as string;
    const start = async (b: Browser) =>
      b.request(`${s.base}/api/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': await csrf(b) },
        body: JSON.stringify({ text_sha256: 'a'.repeat(64) }),
      });
    expect((await start(alice)).status).toBe(200);
    expect((await start(alice)).status).toBe(200);
    const limited = await start(alice);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Bob is another principal, from the same IP (this test process): he has his own bucket.
    expect((await start(bob)).status).toBe(200);
    s.identity.clock.advance(31_000);
    expect((await start(alice)).status).toBe(200);
  });

  it('the IP bucket of the step-up start limits across principals', async () => {
    const who = ['alice', 'bob', 'carol', 'root', 'dora'] as const;
    const browsers = new Map<string, Browser>();
    for (const w of who) {
      s.identity.clock.advance(61_000); // one sign-in per refill: the login bucket is not under test
      browsers.set(w, (await signIn(s, w)).browser);
    }
    let ok = 0;
    let refused = 0;
    for (let i = 0; i < 12; i++) {
      const b = browsers.get(who[i % who.length] as string) as Browser;
      const me = (await (await b.request(`${s.base}/api/me`)).json()) as Json;
      const r = await b.request(`${s.base}/api/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
        body: JSON.stringify({ text_sha256: 'a'.repeat(64) }),
      });
      if (r.status === 200) ok++;
      else if (r.status === 429) refused++;
    }
    // 12 requests, 5 principals with 2 each (10 would pass the principal buckets) but the IP has 10;
    // the principal buckets (2 each) and the IP bucket (10) together let through at most 10.
    expect(ok).toBeLessThanOrEqual(10);
    expect(refused).toBeGreaterThanOrEqual(2);
    expect(SUBJECTS.alice).toBe('sub-alice');
  });
});
