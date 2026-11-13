import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindProject, setStatusForTest } from '@aisdlc/identity/testing';
import { Browser, signIn, startBffStack, type BffStack } from '../src/testing.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let s: BffStack;
beforeAll(async () => {
  s = await startBffStack({ idleSeconds: 600, absoluteSeconds: 3600 });
  await bindProject(s.identity, 'acme', { admin: ['alice'], kill: ['carol'] });
});
afterAll(async () => {
  await s.stop();
});

const SID = 'aisdlc_sid';
const advance = (seconds: number) => s.identity.clock.advance(seconds * 1000);
const me = async (b: Browser) => (await b.request(`${s.base}/api/me`)).status;
const csrfOf = async (b: Browser) =>
  ((await (await b.request(`${s.base}/api/me`)).json()) as Json).csrf_token as string;
const post = (b: Browser, path: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  b.request(`${s.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('session expiry', () => {
  it('idle timeout: unused for longer than the idle limit, the session is gone for good; use keeps it alive', async () => {
    const { browser } = await signIn(s, 'alice');
    advance(500);
    expect(await me(browser)).toBe(200); // used inside the limit: the idle clock restarts
    advance(500);
    expect(await me(browser)).toBe(200); // 1000 s after login, but never idle for 600
    advance(601);
    const r = await browser.request(`${s.base}/api/me`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as Json).error.message).toMatch(/idle_timeout/);
    // The cookie is cleared, and the row says why it ended.
    expect(browser.cookie(s.base, SID)).toBeUndefined();
    const row = await s.identity.record.pool.query<{ revoke_reason: string }>(
      "SELECT revoke_reason FROM bff.session WHERE principal_id = 'alice' AND revoke_reason = 'idle_timeout'",
    );
    expect(row.rows.length).toBeGreaterThan(0);
  });

  it('absolute timeout: even a session in constant use ends', async () => {
    const { browser } = await signIn(s, 'alice');
    for (let i = 0; i < 6; i++) {
      advance(550);
      expect(await me(browser)).toBe(200);
    }
    advance(550); // 7 x 550 = 3850 s > 3600 s
    const r = await browser.request(`${s.base}/api/me`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as Json).error.message).toMatch(/absolute_timeout/);
  });

  it('an expired session cannot be revived by presenting its cookie again', async () => {
    const { browser } = await signIn(s, 'alice');
    const sid = browser.cookie(s.base, SID) as string;
    advance(601);
    expect(await me(browser)).toBe(401);
    const again = new Browser();
    again.setCookie(s.base, SID, sid);
    expect(await me(again)).toBe(401);
  });

  it('a principal disabled after sign-in loses the session at the next request, and all its other sessions', async () => {
    const a = await signIn(s, 'carol');
    const b = await signIn(s, 'carol');
    expect(await me(a.browser)).toBe(200);
    await setStatusForTest(s.identity.deps, 'carol', 'disabled');
    const r = await a.browser.request(`${s.base}/api/me`);
    expect(r.status).toBe(401);
    expect(await me(b.browser)).toBe(401);
    await setStatusForTest(s.identity.deps, 'carol', 'active');
    expect(await me(a.browser)).toBe(401); // re-enabling does not resurrect a revoked session
  });
});

describe('logout', () => {
  it('revokes the session: the cookie is cleared and the old cookie value is dead', async () => {
    const { browser } = await signIn(s, 'alice');
    const sid = browser.cookie(s.base, SID) as string;
    const token = await csrfOf(browser);
    const out = await post(browser, '/api/logout', { 'x-csrf-token': token });
    expect(out.status).toBe(200);
    expect(browser.cookie(s.base, SID)).toBeUndefined();
    // and the IdP's session too: the browser is sent to its end-session endpoint, with the ID token as the hint,
    // to come back to the portal's root
    const redirect = new URL(((await out.json()) as Json).redirect as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${s.oidc.issuer}/logout`);
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe(`${s.base}/`);
    expect(redirect.searchParams.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const replay = new Browser();
    replay.setCookie(s.base, SID, sid);
    expect(await me(replay)).toBe(401);
    const row = await s.identity.record.pool.query<{ revoke_reason: string }>(
      "SELECT revoke_reason FROM bff.session WHERE principal_id = 'alice' AND revoke_reason = 'logout'",
    );
    expect(row.rows.length).toBeGreaterThan(0);
  });

  it('logout is not a GET (a link or an image cannot sign you out)', async () => {
    const { browser } = await signIn(s, 'alice');
    expect((await browser.request(`${s.base}/api/logout`)).status).toBe(404);
    expect(await me(browser)).toBe(200);
  });
});

describe('CSRF on state-changing routes', () => {
  it('needs the per-session token: missing, wrong and another session’s are refused; the right one works', async () => {
    const a = await signIn(s, 'alice');
    const b = await signIn(s, 'alice');
    const own = await csrfOf(a.browser);
    const other = await csrfOf(b.browser);
    for (const headers of [{}, { 'x-csrf-token': 'x'.repeat(43) }, { 'x-csrf-token': other }]) {
      const r = await post(a.browser, '/api/logout', headers);
      expect(r.status).toBe(403);
      expect(((await r.json()) as Json).error.code).toBe('csrf_failed');
    }
    expect(await me(a.browser)).toBe(200); // none of those logged it out
    expect((await post(a.browser, '/api/logout', { 'x-csrf-token': own })).status).toBe(200);
  });

  it('refuses a foreign Origin even with the right token, and accepts our own', async () => {
    const { browser } = await signIn(s, 'alice');
    const token = await csrfOf(browser);
    const evil = await post(
      browser,
      '/api/step-up',
      { 'x-csrf-token': token, origin: 'https://evil.example' },
      { subject_hash: 'a'.repeat(64) },
    );
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as Json).error.message).toMatch(/origin/);
    const ours = await post(
      browser,
      '/api/step-up',
      { 'x-csrf-token': token, origin: s.base },
      { subject_hash: 'a'.repeat(64) },
    );
    expect(ours.status).toBe(200);
  });

  it('a form post (what a cross-site page can send) carries no token and is refused', async () => {
    const { browser } = await signIn(s, 'alice');
    const r = await browser.request(`${s.base}/api/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: 'x=1',
    });
    expect([403, 415]).toContain(r.status);
    expect(await me(browser)).toBe(200);
  });

  it('GET routes are not CSRF-gated, and an unauthenticated call is 401 before anything else', async () => {
    const b = new Browser();
    expect((await post(b, '/api/logout')).status).toBe(401);
    expect(await me(b)).toBe(401);
  });
});

describe('cookie attributes when Secure is on', () => {
  it('uses the __Host- prefix, Secure, HttpOnly, SameSite=Lax and no Domain', async () => {
    // Secure cookies are not sent back over plain http by a real browser, so this only reads the
    // header the bff emits; the jar here would need https to continue.
    const t = await startBffStack({ cookieSecure: true });
    try {
      const b = new Browser();
      const first = await b.request(`${t.base}/auth/login`);
      const binder = first.headers.getSetCookie().find((c) => c.startsWith('__Host-aisdlc_login='));
      expect(binder).toMatch(/; Secure/);
      expect(binder).toMatch(/; HttpOnly/);
      expect(binder).toMatch(/SameSite=Lax/);
      expect(binder).toMatch(/Path=\//);
      expect(binder).not.toMatch(/Domain=/);
      const idp = new URL(first.headers.get('location') as string);
      idp.searchParams.set('login_hint', 'sub-alice');
      const atIdp = await b.request(idp.toString());
      // Replay the callback with the binder by hand (a browser would refuse the Secure cookie on http).
      const jar = (first.headers.getSetCookie()[0] as string).split(';')[0] as string;
      const cb = await fetch(atIdp.headers.get('location') as string, {
        redirect: 'manual',
        headers: { cookie: jar },
      });
      expect(cb.status).toBe(302);
      const sid = cb.headers.getSetCookie().find((c) => c.startsWith('__Host-aisdlc_sid='));
      expect(sid).toMatch(/; Secure/);
      expect(sid).toMatch(/; HttpOnly/);
      expect(sid).toMatch(/SameSite=Lax/);
      expect(sid).not.toMatch(/Domain=/);
    } finally {
      await t.stop();
    }
  });
});
