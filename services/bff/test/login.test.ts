import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkceChallenge } from '@aisdlc/ports';
import { bindProject, grantFleetRole, setStatusForTest } from '@aisdlc/identity/testing';
import { safeReturnTo } from '../src/app.js';
import { Browser, CLIENT, SUBJECTS, signIn, startBffStack, type BffStack } from '../src/testing.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let s: BffStack;
beforeAll(async () => {
  s = await startBffStack();
  await bindProject(s.identity, 'acme', { admin: ['alice'], intent: ['bob'], kill: ['carol'] });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s.stop();
});

const SID = 'aisdlc_sid';

describe('login', () => {
  it('starts an authorization-code + PKCE request: S256, state, nonce, the bff as the client, no secret in the URL', async () => {
    const b = new Browser();
    const res = await b.request(`${s.base}/auth/login`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.origin + loc.pathname).toBe(`${s.oidc.url}/authorize`);
    const q = loc.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CLIENT.client_id);
    expect(q.get('redirect_uri')).toBe(`${s.base}/auth/callback`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(q.get('nonce')?.length).toBeGreaterThanOrEqual(32);
    expect(q.get('prompt')).toBeNull();
    expect(loc.toString()).not.toContain(CLIENT.client_secret);
    // The verifier is not in the URL: only its challenge is, and the server holds the verifier.
    const row = await s.identity.record.pool.query<{ code_verifier: string; state_hash: string }>(
      'SELECT code_verifier, state_hash FROM bff.oidc_attempt ORDER BY created_at DESC LIMIT 1',
    );
    expect(pkceChallenge(row.rows[0]?.code_verifier as string)).toBe(q.get('code_challenge'));
    expect(loc.toString()).not.toContain(row.rows[0]?.code_verifier as string);
    // The binder cookie is HttpOnly and SameSite=Lax.
    const binder = b.setCookies.find((c) => c.startsWith('aisdlc_login='));
    expect(binder).toMatch(/HttpOnly/);
    expect(binder).toMatch(/SameSite=Lax/);
  });

  it('signs a known principal in, sets one opaque HttpOnly cookie, and keeps only its hash', async () => {
    const { browser, chain } = await signIn(s, 'alice');
    expect(chain.some((u) => u.startsWith(`${s.base}/auth/callback?code=`))).toBe(true);
    const sid = browser.cookie(s.base, SID) as string;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = browser.setCookies.find((c) => c.startsWith(`${SID}=`)) as string;
    expect(raw).toMatch(/; HttpOnly/);
    expect(raw).toMatch(/; SameSite=Lax/);
    expect(raw).toMatch(/; Path=\//);
    expect(raw).not.toMatch(/Secure/); // local plain http is the configured exception
    expect(raw).not.toMatch(/Domain=/);
    const rows = await s.identity.record.pool.query<{ id_hash: string; principal_id: string }>(
      'SELECT id_hash, principal_id FROM bff.session',
    );
    expect(rows.rows.map((r) => r.id_hash)).not.toContain(sid);
    expect(rows.rows.some((r) => r.principal_id === 'alice')).toBe(true);
  });

  it('tokens never reach the browser: not in a body, a header, a cookie or a redirect', async () => {
    const { browser } = await signIn(s, 'bob');
    const me = await browser.request(`${s.base}/api/me`);
    expect(me.status).toBe(200);
    const stored = await s.identity.record.pool.query<{ id_token: string }>(
      "SELECT id_token FROM bff.session WHERE principal_id = 'bob' ORDER BY created_at DESC LIMIT 1",
    );
    const idToken = stored.rows[0]?.id_token as string;
    expect(idToken.split('.')).toHaveLength(3); // the bff has it...
    const seen = browser.transcript.join('\n');
    expect(seen).not.toContain(idToken); // ...the browser never did
    expect(seen).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWT of any kind
    expect(seen).not.toMatch(/dev-at-|dev-rt-/); // no access or refresh token
    expect(seen).not.toContain(CLIENT.client_secret);
    // the cookies hold random ids, which can contain "eyJ" by chance: look for a JWT's shape and the token prefixes
    const cookies = browser.setCookies.join('\n');
    expect(cookies).not.toContain(idToken);
    expect(cookies).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./);
    expect(cookies).not.toMatch(/dev-at-|dev-rt-/);
  });

  it('GET /api/me: the directory summary, the CSRF token and what the PDP permits at the top level', async () => {
    const { browser } = await signIn(s, 'alice');
    const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
    expect(me.principal).toEqual({
      principal_id: 'alice',
      display_handle: 'alice',
      display_name: 'Person alice',
      kind: 'human',
      status: 'active',
    });
    expect(me.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(me.step_up).toEqual({ mode: 'reauth' });
    expect(me.actions.fleet).toEqual([]); // a project admin has nothing at the fleet
    expect(me.actions.projects).toHaveLength(1);
    expect(me.actions.projects[0].project_id).toBe('acme');
    expect(me.actions.projects[0].actions).toEqual(
      expect.arrayContaining([
        'project.view',
        'project.settings.edit',
        'kill.request',
        'config.propose',
      ]),
    );
    expect(me.actions.projects[0].actions).not.toContain('gate.decide'); // that needs a gate, not a project

    const root = await signIn(s, 'root');
    const rme = (await (await root.browser.request(`${s.base}/api/me`)).json()) as Json;
    expect(rme.actions.fleet).toEqual(
      expect.arrayContaining(['project.onboard', 'kill.request', 'config.propose', 'audit.read']),
    );
    expect(rme.actions.projects).toEqual([]);

    const carol = await signIn(s, 'carol');
    const cme = (await (await carol.browser.request(`${s.base}/api/me`)).json()) as Json;
    expect(cme.actions.projects[0].actions).toEqual(
      expect.arrayContaining(['kill.request', 'kill.release']),
    );
    expect(cme.actions.projects[0].actions).not.toContain('project.settings.edit');
  });

  it('an identity that is not linked to a principal is refused, and gets no session', async () => {
    const { browser, res } = await signIn(s, 'ghost');
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe('unknown_principal');
    expect(browser.cookie(s.base, SID)).toBeUndefined();
    expect((await browser.request(`${s.base}/api/me`)).status).toBe(401);
  });

  it('a disabled principal, and a service principal, are refused', async () => {
    await setStatusForTest(s.identity.deps, 'dora', 'disabled');
    const dora = await signIn(s, 'dora');
    expect(dora.res.status).toBe(403);
    expect(((await dora.res.json()) as Json).error.code).toBe('principal_disabled');
    expect(dora.browser.cookie(s.base, SID)).toBeUndefined();
    const bot = await signIn(s, 'bot');
    expect(bot.res.status).toBe(403);
    expect(((await bot.res.json()) as Json).error.code).toBe('service_principal');
    expect(bot.browser.cookie(s.base, SID)).toBeUndefined();
  });

  it('a callback is bound to the browser that started it, and can be played once', async () => {
    // The attacker starts a login and gets as far as a code at the IdP.
    const attacker = new Browser();
    const start = await attacker.request(`${s.base}/auth/login`);
    const idp = new URL(start.headers.get('location') as string);
    idp.searchParams.set('login_hint', SUBJECTS.alice);
    const atIdp = await attacker.request(idp.toString());
    const callback = atIdp.headers.get('location') as string;
    expect(callback).toContain('/auth/callback?code=');
    // The victim's browser is lured into that callback: it has no binder cookie, so it is refused.
    const victim = new Browser();
    const v = await victim.request(callback);
    expect(v.status).toBe(400);
    expect(((await v.json()) as Json).error.code).toBe('invalid_callback');
    expect(victim.cookie(s.base, SID)).toBeUndefined();
    // A foreign binder does not match either, and does not burn the attacker's own attempt.
    victim.setCookie(s.base, 'aisdlc_login', 'x'.repeat(43));
    expect((await victim.request(callback)).status).toBe(400);
    const own = await attacker.request(callback);
    expect(own.status).toBe(302);
    expect(attacker.cookie(s.base, SID)).toBeDefined();
    // The same callback again: used.
    const again = await attacker.request(callback);
    expect(again.status).toBe(400);
  });

  it('refuses an unknown or missing state, and an IdP that sent an error', async () => {
    const b = new Browser();
    expect((await b.request(`${s.base}/auth/callback?code=x`)).status).toBe(400);
    expect((await b.request(`${s.base}/auth/callback?code=x&state=nope`)).status).toBe(400);
    const start = await b.request(`${s.base}/auth/login`);
    const state = new URL(start.headers.get('location') as string).searchParams.get('state');
    const denied = await b.request(`${s.base}/auth/callback?error=access_denied&state=${state}`);
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as Json).error.code).toBe('idp_refused');
  });

  it('only same-site paths are honoured as return_to', async () => {
    for (const [given, want] of [
      ['/floor/acme?x=1', '/floor/acme?x=1'],
      ['//evil.example/x', '/'],
      ['https://evil.example/', '/'],
      ['/\\evil.example', '/'],
      ['floor', '/'],
      ['/config/gateway.models', '/config/gateway.models'],
    ] as const) {
      const { chain } = await signIn(s, 'alice', new Browser(), given);
      expect(
        new URL(chain[chain.length - 1] as string).pathname +
          new URL(chain[chain.length - 1] as string).search,
      ).toBe(want);
    }
  });

  it('P2-18: return_to keeps a same-origin path and nothing that could leave the site', () => {
    for (const [given, want] of [
      [undefined, '/'],
      ['', '/'],
      ['/items/abc?tab=verify#gates', '/items/abc?tab=verify#gates'],
      ['/config/gateway.models', '/config/gateway.models'],
      ['/a/../b', '/b'],
      ['//evil.example', '/'],
      ['/\\evil.example', '/'],
      ['/x\\y', '/'],
      ['/\tevil', '/'],
      ['/%0d%0aSet-Cookie:x', '/%0d%0aSet-Cookie:x'],
      ['https://evil.example/', '/'],
      ['javascript:alert(1)', '/'],
      ['/auth/login?return_to=//evil', '/'],
      ['/auth/logout', '/'],
      [`/${'a'.repeat(3000)}`, '/'],
    ] as const) {
      expect(safeReturnTo(given)).toBe(want);
    }
  });

  it('a new sign-in in a browser ends the session it had (no fixation)', async () => {
    const { browser } = await signIn(s, 'alice');
    const first = browser.cookie(s.base, SID) as string;
    await signIn(s, 'alice', browser);
    const second = browser.cookie(s.base, SID) as string;
    expect(second).not.toBe(first);
    const oldOne = new Browser();
    oldOne.setCookie(s.base, SID, first);
    expect((await oldOne.request(`${s.base}/api/me`)).status).toBe(401);
    expect((await browser.request(`${s.base}/api/me`)).status).toBe(200);
  });

  it('a wrong client secret at the token endpoint fails the exchange', async () => {
    const { HttpOidcClient } = await import('../src/oidc/http-client.js');
    const client = new HttpOidcClient({
      issuer: s.oidc.issuer,
      client_id: CLIENT.client_id,
      client_secret: 'wrong-secret-wrong-secret',
    });
    const r = await client.exchange({
      code: 'c',
      redirect_uri: `${s.base}/auth/callback`,
      code_verifier: 'v'.repeat(43),
      nonce: 'n',
    });
    expect(!r.ok && r.error.code).toBe('invalid_grant');
  });
});
