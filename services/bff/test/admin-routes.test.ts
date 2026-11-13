import { OVERRIDE_REASON_HEADER } from '@aisdlc/contracts';
import { listen } from '@aisdlc/service-kit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCoreClient, type CoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';

// Portal v2 at the bff (docs/specs/deletion.md §5, screen map N19, N26): the delete and the identity writes are carried
// for the signed-in person (the session's principal, never the body's), and the factory admin's override reason rides
// along in its header to the service that decides. The bff decides nothing here: an upstream refusal is relayed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: BffStack;
let upstream: FastifyInstance;
let upstreamUrl = '';
const seen: Array<{ method: string; url: string; body: Json; reason: string | undefined }> = [];
let browser: Browser;
let csrf = '';

beforeAll(async () => {
  upstream = Fastify();
  upstream.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, b, done) =>
    done(null, b === '' ? {} : JSON.parse(String(b))),
  );
  upstream.all('/*', async (req, reply) => {
    const h = req.headers[OVERRIDE_REASON_HEADER];
    seen.push({
      method: req.method,
      url: req.url,
      body: req.body,
      reason: typeof h === 'string' ? decodeURIComponent(h) : undefined,
    });
    if (req.url.startsWith('/v1/teams')) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'identity.admin denied' } });
    }
    return reply.code(200).send({ ok: true });
  });
  upstreamUrl = await listen(upstream);
  const client = (): CoreClient =>
    new HttpCoreClient({ baseUrl: upstreamUrl, token: 't'.repeat(32) });
  // core and identity are the recorder: the bff only carries
  s = await startBffStack({ override: { identity: client(), core: client() } });
  ({ browser } = await signIn(s, 'alice'));
  csrf = ((await (await browser.request(`${s.base}/api/me`)).json()) as Json).csrf_token;
}, 120_000);
afterAll(async () => {
  await s?.stop();
  await upstream?.close();
});

async function api(method: string, path: string, body: unknown, reason?: string) {
  const res = await browser.request(`${s.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      ...(reason === undefined ? {} : { [OVERRIDE_REASON_HEADER]: encodeURIComponent(reason) }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

describe('the identity writes for the signed-in person', () => {
  it('names the session principal, not the body’s, and carries the override reason', async () => {
    const r = await api(
      'POST',
      '/api/people',
      { principal: { principal_id: 'newbie' }, on_behalf_of: 'mallory' },
      'onboarding a contractor',
    );
    expect(r.status).toBe(200);
    const last = seen.at(-1);
    expect(last).toMatchObject({
      method: 'POST',
      url: '/v1/principals',
      reason: 'onboarding a contractor',
    });
    expect(last?.body.on_behalf_of).toBe('alice');
    expect(last?.body.principal).toEqual({ principal_id: 'newbie' });
  });

  it('relays the PDP refusal of the service that decides', async () => {
    const r = await api('POST', '/api/teams', { team: { team_id: 't1' } });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/identity.admin denied/);
    expect(seen.at(-1)?.reason).toBeUndefined();
  });

  it('a binding revoke goes to its identity path', async () => {
    await api('POST', '/api/bindings/b-1/revoke', { reason: 'left' });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/bindings/b-1/revoke' });
  });
});

describe('deletion through the bff', () => {
  it('needs a reason and the confirm; is forwarded as DELETE to core for the person', async () => {
    const bad = await api('DELETE', '/api/projects/acme', { reason: 'x' });
    expect(bad.status).toBe(400);
    const ok = await api(
      'DELETE',
      '/api/projects/acme',
      { reason: 'the customer left', confirm: 'acme', on_behalf_of: 'mallory' },
      'the owner asked',
    );
    expect(ok.status).toBe(400); // on_behalf_of is not the browser's to send
    const r = await api(
      'DELETE',
      '/api/projects/acme',
      { reason: 'the customer left', confirm: 'acme' },
      'the owner asked',
    );
    expect(r.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/v1/projects/acme',
      reason: 'the owner asked',
      body: { reason: 'the customer left', confirm: 'acme', on_behalf_of: 'alice' },
    });
    const p = await api('POST', '/api/deletions/preview', { kind: 'item', id: 'i-1' });
    expect(p.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({
      url: '/v1/deletions/preview',
      body: { kind: 'item', id: 'i-1', on_behalf_of: 'alice' },
    });
  });
});
