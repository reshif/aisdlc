import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SANDBOX_CAPS } from '@aisdlc/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeSandbox,
  FakeSandboxSlots,
  HttpSandbox,
  freeCodingSlots,
  sandboxRunFromWire,
  sandboxRunToWire,
  slotsUnder,
  type SandboxSpec,
} from '../src/index.js';
import { CONTRACT_GRANT, sandboxContract } from '../src/testing.js';

// M14.2: the SandboxPort contract on the fake itself (the controller runs the same suite through HttpSandbox), and
// the adapter's fail-closed edges against a server that misbehaves.

sandboxContract('FakeSandbox', async (script) => {
  const fake = new FakeSandbox(script);
  return { port: fake, fake };
});

const KEY = `aisk_${'0123456789abcdef'.repeat(2)}`;
const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  session_id: 'http-0001',
  class: 'O',
  command: ['npm', 'test'],
  repo: [],
  grant: CONTRACT_GRANT,
  ...over,
});

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
});
async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const client = (baseUrl: string, o: Partial<ConstructorParameters<typeof HttpSandbox>[0]> = {}) =>
  new HttpSandbox({ baseUrl, token: 't'.repeat(32), ...o });

describe('HttpSandbox fails closed', () => {
  it('refuses a session with no grant before anything is sent', async () => {
    let hits = 0;
    const url = await serve((_q, res) => {
      hits += 1;
      res.end();
    });
    const { grant, ...noGrant } = spec();
    void grant;
    const r = await client(url).run(noGrant);
    expect(!r.ok && r.error.code).toBe('refused');
    expect(hits).toBe(0);
  });

  it('an unreachable controller is unavailable, for a session and for the slots', async () => {
    const c = client('http://127.0.0.1:1');
    expect(await c.run(spec())).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await c.slots()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('a non-2xx answer is the code the controller named, else unavailable; a malformed run is a driver failure', async () => {
    const answers: Array<[number, string]> = [
      [409, JSON.stringify({ error: { code: 'busy', message: 'at the coding cap' } })],
      [500, 'oops'],
      [418, JSON.stringify({ error: { code: 'approved', message: 'not a code' } })],
      [200, JSON.stringify({ session_id: 'http-0001' })],
    ];
    const url = await serve((_q, res) => {
      const [status, body] = answers.shift()!;
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
    const c = client(url);
    expect(await c.run(spec())).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await c.run(spec())).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await c.run(spec())).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await c.run(spec())).toMatchObject({ ok: false, error: { code: 'driver_failure' } });
  });

  it('a session that does not end before its deadline is unavailable (never a run)', async () => {
    const url = await serve(() => undefined); // never answers
    const r = await client(url, { marginMs: 50 }).run(spec({ limits: { time_s: 1 } }));
    expect(!r.ok && r.error.code).toBe('unavailable');
  });

  it('an /out file whose bytes do not match the hash it is named with is refused', async () => {
    const ran = await new FakeSandbox(() => ({ exit_code: 0, out: { 'a.txt': 'hello' } })).run(
      spec(),
    );
    if (!ran.ok) throw new Error(ran.error.message);
    const w = sandboxRunToWire(ran.value);
    expect(sandboxRunFromWire(w).ok).toBe(true);
    const bad = {
      ...w,
      out: w.out.map((f) => ({ ...f, content_b64: Buffer.from('hellO').toString('base64') })),
    };
    expect(sandboxRunFromWire(bad)).toMatchObject({ ok: false, error: { code: 'driver_failure' } });
    // and an answer for another session is refused too
    const url = await serve((_q, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...w, session_id: 'someone-else' }));
    });
    expect(await client(url).run(spec())).toMatchObject({
      ok: false,
      error: { code: 'driver_failure' },
    });
  });

  it('sends the token and the grant; malformed slots are unavailable', async () => {
    const seen: Array<{ auth?: string; body: string }> = [];
    const url = await serve((q, res) => {
      let body = '';
      q.on('data', (c: Buffer) => (body += c.toString()));
      q.on('end', () => {
        seen.push({ ...(q.headers.authorization ? { auth: q.headers.authorization } : {}), body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"free":1}');
      });
    });
    const c = client(url);
    await c.run(spec({ class: 'W', gateway_key: KEY }));
    expect(seen[0]?.auth).toBe(`Bearer ${'t'.repeat(32)}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      grant: CONTRACT_GRANT,
      spec: { class: 'W' },
    });
    expect(await c.slots()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
});

describe('slots under two caps', () => {
  const none = { K: 0, 'K-exec': 0, P: 0, W: 0, O: 0, V: 0 };
  it('W is free under both the coding cap and the total; the other classes under the total', () => {
    expect(slotsUnder(DEFAULT_SANDBOX_CAPS, none).free).toEqual({
      K: 4,
      'K-exec': 4,
      P: 4,
      W: 1,
      O: 4,
      V: 4,
    });
    expect(slotsUnder(DEFAULT_SANDBOX_CAPS, { ...none, W: 1 }).free.W).toBe(0);
    const full = slotsUnder({ total: 4, coding: 2 }, { ...none, O: 3, K: 1 });
    expect(full).toEqual({ used_total: 4, free: { K: 0, 'K-exec': 0, P: 0, W: 0, O: 0, V: 0 } });
    expect(slotsUnder({ total: 4, coding: 2 }, { ...none, O: 3 }).free.W).toBe(1);
  });
  it('the fake reports the same, and is unavailable when broken', async () => {
    const f = new FakeSandboxSlots();
    const a = await f.slots();
    expect(a.ok && freeCodingSlots(a.value)).toBe(1);
    f.occupy('W', 1);
    const b = await f.slots();
    expect(b.ok && freeCodingSlots(b.value)).toBe(0);
    expect((await f.breakIt().slots()).ok).toBe(false);
  });
});
