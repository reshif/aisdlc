import { STEP_UP_RECONFIRM_STAMP, STEP_UP_TTL_SECONDS, StepUpClaims } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { bindProject } from '@aisdlc/identity/testing';
import type { OidcPort } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeToken } from '../src/stepup/index.js';
import { Browser, SUBJECTS, signIn, startBffStack, type BffStack } from '../src/testing.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let s: BffStack;
/** Lets a test make the IdP "forget" to re-authenticate by reporting an old auth_time. */
const staleness = { seconds: 0 };

beforeAll(async () => {
  s = await startBffStack({
    wrapOidc: (real): OidcPort => ({
      authorizationUrl: (p) => real.authorizationUrl(p),
      endSessionUrl: (p) => real.endSessionUrl(p),
      async exchange(p) {
        const r = await real.exchange(p);
        return r.ok && r.value.auth_time !== null && staleness.seconds > 0
          ? { ok: true, value: { ...r.value, auth_time: r.value.auth_time - staleness.seconds } }
          : r;
      },
    }),
  });
  await bindProject(s.identity, 'acme', { admin: ['alice'], g5: ['alice'] });
});
afterAll(async () => {
  await s.stop();
});

const H = sha256Hex('the AGENTS.md text');
const csrf = async (b: Browser) =>
  ((await (await b.request(`${s.base}/api/me`)).json()) as Json).csrf_token as string;
const startStepUp = async (b: Browser, body: unknown = { text_sha256: H }) =>
  b.request(`${s.base}/api/step-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': await csrf(b) },
    body: JSON.stringify(body),
  });

/** Follows the authorization URL like a browser would (with the user hint the bff sent). */
async function reauth(b: Browser, authorizeUrl: string, hintOverride?: string) {
  const u = new URL(authorizeUrl);
  if (hintOverride) u.searchParams.set('login_hint', hintOverride);
  return b.follow(u.toString());
}

describe('step-up by re-authentication (D37)', () => {
  it('asks the IdP for a NEW sign-in (prompt=login, max_age=0) and returns a proof bound to the hash', async () => {
    const { browser } = await signIn(s, 'alice');
    s.identity.clock.advance(120_000); // the first sign-in is two minutes old
    const started = await startStepUp(browser);
    expect(started.status).toBe(200);
    const body = (await started.json()) as Json;
    expect(body).toMatchObject({ status: 'redirect', method: 'reauth' });
    const u = new URL(body.authorize_url);
    expect(u.searchParams.get('prompt')).toBe('login');
    expect(u.searchParams.get('max_age')).toBe('0');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(body.authorize_url).not.toContain(H); // the hash is the bff's business, not the IdP's

    const { res, chain } = await reauth(browser, body.authorize_url);
    expect(res.status).toBe(404); // the SPA route after the redirect; there is no SPA in this test
    const back = new URL(chain[chain.length - 1] as string);
    expect(back.pathname).toBe('/');
    const attempt = back.searchParams.get('step_up') as string;
    expect(attempt).toBe(body.attempt_id);
    // The IdP was asked, and a provider session that already existed did not stand in for it.
    const req = s.oidc.authorizeRequests.at(-1);
    expect(req).toMatchObject({ prompt: 'login', max_age: '0', login_hint: SUBJECTS.alice });

    const got = await browser.request(`${s.base}/api/step-up/${attempt}`);
    expect(got.status).toBe(200);
    const proof = (await got.json()) as Json;
    expect(proof).toMatchObject({ status: 'ready', method: 'reauth', bound_hash: H });
    const claims = decodeToken(proof.proof)?.claims;
    expect(StepUpClaims.safeParse(claims).success).toBe(true);
    expect(claims).toMatchObject({ principal: 'alice', bound_hash: H, method: 'reauth', v: 1 });
    // auth_time is the new sign-in (now), not the login two minutes ago; the proof lives 5 minutes.
    const now = s.identity.clock.nowMs();
    expect(Math.abs(Date.parse(claims?.auth_time as string) - now)).toBeLessThan(5_000);
    expect(Date.parse(claims?.expires_at as string) - Date.parse(claims?.issued_at as string)).toBe(
      STEP_UP_TTL_SECONDS * 1000,
    );
    expect(STEP_UP_TTL_SECONDS).toBe(300);
  });

  it('hands the proof over once, and only to the session that asked', async () => {
    const { browser } = await signIn(s, 'alice');
    const body = (await (await startStepUp(browser, { subject_hash: H })).json()) as Json;
    await reauth(browser, body.authorize_url);
    // Another session of the same principal cannot collect it.
    const other = (await signIn(s, 'alice')).browser;
    expect((await other.request(`${s.base}/api/step-up/${body.attempt_id}`)).status).toBe(404);
    expect((await browser.request(`${s.base}/api/step-up/${body.attempt_id}`)).status).toBe(200);
    expect((await browser.request(`${s.base}/api/step-up/${body.attempt_id}`)).status).toBe(404);
    const row = await s.identity.record.pool.query<{ proof_token: string | null }>(
      'SELECT proof_token FROM bff.oidc_attempt WHERE attempt_id = $1',
      [body.attempt_id],
    );
    expect(row.rows[0]?.proof_token).toBeNull(); // the stored token is gone once collected
  });

  it('a sign-in that is not new (the IdP ignored prompt=login) gives no proof', async () => {
    const { browser } = await signIn(s, 'alice');
    s.identity.clock.advance(300_000);
    staleness.seconds = 300; // the IdP reports the old authentication time
    try {
      const body = (await (await startStepUp(browser)).json()) as Json;
      const { res } = await reauth(browser, body.authorize_url);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe('step_up_not_fresh');
      expect((await browser.request(`${s.base}/api/step-up/${body.attempt_id}`)).status).toBe(404);
    } finally {
      staleness.seconds = 0;
    }
  });

  it('someone else signing in at the IdP during alice’s step-up gives no proof', async () => {
    const { browser } = await signIn(s, 'alice');
    const body = (await (await startStepUp(browser)).json()) as Json;
    const { res } = await reauth(browser, body.authorize_url, SUBJECTS.bob);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe('step_up_principal_mismatch');
    expect((await browser.request(`${s.base}/api/step-up/${body.attempt_id}`)).status).toBe(404);
  });

  it('a step-up callback needs the session that started it, and expires', async () => {
    const { browser } = await signIn(s, 'alice');
    const body = (await (await startStepUp(browser)).json()) as Json;
    // The browser lost its session cookie before returning.
    const idp = new URL(body.authorize_url);
    const atIdp = await browser.request(idp.toString());
    browser.setCookie(s.base, 'aisdlc_sid', 'z'.repeat(43));
    const cb = await browser.request(atIdp.headers.get('location') as string);
    expect(cb.status).toBe(401);
    // And an attempt left for longer than ten minutes is refused.
    const { browser: b2 } = await signIn(s, 'alice');
    const body2 = (await (await startStepUp(b2)).json()) as Json;
    const at2 = await b2.request(new URL(body2.authorize_url).toString());
    s.identity.clock.advance(11 * 60_000);
    const late = await b2.request(at2.headers.get('location') as string);
    expect(late.status).toBe(400);
  });

  it('validates the request: exactly one hash, well-formed; and it needs a session and the CSRF token', async () => {
    const { browser } = await signIn(s, 'alice');
    for (const bad of [
      {},
      { subject_hash: H, text_sha256: H },
      { subject_hash: 'nothex' },
      { text_sha256: H, extra: 1 },
    ]) {
      expect((await startStepUp(browser, bad)).status).toBe(400);
    }
    const noToken = await browser.request(`${s.base}/api/step-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text_sha256: H }),
    });
    expect(noToken.status).toBe(403);
    expect((await startStepUp(new Browser())).status).toBe(401);
  });
});

describe('step-up by plain confirm (DEC-11(c-ii) fallback, a config flag)', () => {
  it('issues a proof at once with no re-authentication, stamped as a reconfirm', async () => {
    const t = await startBffStack({ stepUpMode: 'reconfirm' });
    try {
      await bindProject(t.identity, 'acme', { admin: ['alice'] });
      const { browser } = await signIn(t, 'alice');
      const before = t.oidc.authorizeRequests.length;
      const token = ((await (await browser.request(`${t.base}/api/me`)).json()) as Json)
        .csrf_token as string;
      const res = await browser.request(`${t.base}/api/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ text_sha256: H }),
      });
      const body = (await res.json()) as Json;
      expect(body).toMatchObject({
        status: 'ready',
        method: 'reconfirm',
        stamp: STEP_UP_RECONFIRM_STAMP,
        bound_hash: H,
      });
      expect(t.oidc.authorizeRequests.length).toBe(before); // the IdP was not asked again
      expect(decodeToken(body.proof)?.claims).toMatchObject({
        method: 'reconfirm',
        principal: 'alice',
        bound_hash: H,
      });
      const me = (await (await browser.request(`${t.base}/api/me`)).json()) as Json;
      expect(me.step_up).toEqual({ mode: 'reconfirm' });
    } finally {
      await t.stop();
    }
  });
});
