import {
  DEFAULT_SANDBOX_CAPS,
  ONBOARDING_PROBE_UNIT,
  SANDBOX_CAPS_KEY,
  SandboxSlots,
} from '@aisdlc/contracts';
import { err } from '@aisdlc/kernel';
import {
  FakeSandbox,
  HttpSandbox,
  freeCodingSlots,
  sandboxError,
  type SandboxPort,
  type SandboxSpec,
} from '@aisdlc/ports';
import { CONTRACT_GRANT, sandboxContract } from '@aisdlc/ports/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigCaps, StaticCaps } from '../src/caps.js';
import { FakeGrants } from '../src/grants.js';
import { workerImageWhyNot } from '../src/controller.js';
import { startTestController, type TestController } from '../src/testing.js';

// M14.2: the sandbox-controller in front of a FakeSandbox, through HttpSandbox (the adapter core uses). The same
// contract suite the fake passes on its own; then what the controller adds: the grant, the two caps, the slot always
// released, the slots H2 reads, the caller's scopes.

sandboxContract('sandbox-controller + HttpSandbox', async (script) => {
  const fake = new FakeSandbox(script);
  const tc = await startTestController({
    driver: fake,
    grants: new FakeGrants().grant(CONTRACT_GRANT),
  });
  return { port: tc.client, fake, stop: () => tc.close() };
});

const KEY = `aisk_${'0123456789abcdef'.repeat(2)}`;
const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  session_id: 'ctl-0001',
  class: 'O',
  command: ['npm', 'test'],
  repo: [{ path: 'package.json', content: '{}' }],
  grant: CONTRACT_GRANT,
  ...over,
});

/** A driver whose sessions wait until released, so a test can hold slots open. */
class HeldDriver implements SandboxPort {
  readonly fake = new FakeSandbox();
  private readonly waiting = new Map<string, () => void>();
  started: string[] = [];
  async run(s: SandboxSpec) {
    this.started.push(s.session_id);
    await new Promise<void>((r) => this.waiting.set(s.session_id, r));
    return this.fake.run(s);
  }
  release(id: string) {
    this.waiting.get(id)?.();
  }
}

let tc: TestController | undefined;
afterEach(async () => {
  await tc?.close();
  tc = undefined;
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('timed out waiting');
};
const slots = async (c: TestController) => {
  const r = await c.client.slots();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('the grant: nothing starts that core did not grant', () => {
  it('a request with no grant reference is refused (403 refused) and starts nothing', async () => {
    const fake = new FakeSandbox();
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
    });
    const res = await fetch(new URL('/v1/sessions', tc.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${tc.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        spec: { session_id: 'ctl-0001', class: 'O', command: ['npm', 'test'], repo: [] },
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'refused' } });
    expect(fake.runs).toHaveLength(0);
  });

  it('a grant that is not active (unknown, revoked, another epoch, another item) is refused; an unreadable record is unavailable', async () => {
    const fake = new FakeSandbox();
    const grants = new FakeGrants().grant(CONTRACT_GRANT);
    tc = await startTestController({ driver: fake, grants });
    const code = async (s: SandboxSpec) => {
      const r = await tc!.client.run(s);
      return r.ok ? 'ran' : r.error.code;
    };
    expect(await code(spec({ grant: { ...CONTRACT_GRANT, lease_epoch: 2 } }))).toBe('refused');
    expect(await code(spec({ grant: { ...CONTRACT_GRANT, item_id: 'other' } }))).toBe('refused');
    expect(await code(spec({ grant: { ...CONTRACT_GRANT, grant_id: 'nope@1' } }))).toBe('refused');
    expect(await code(spec())).toBe('ran');
    grants.revoke(CONTRACT_GRANT.grant_id);
    expect(await code(spec())).toBe('refused');
    grants.grant(CONTRACT_GRANT).breakIt();
    expect(await code(spec())).toBe('unavailable');
    expect(fake.runs).toHaveLength(1);
  });
});

describe('the two caps of the host', () => {
  it('the total cap across classes: the fifth session is busy and starts nothing, a freed slot is taken again', async () => {
    const d = new HeldDriver();
    tc = await startTestController({
      driver: d,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      caps: new StaticCaps({ total: 4, coding: 1 }),
    });
    const c = tc;
    const runs = ['ctl-a1', 'ctl-a2', 'ctl-a3', 'ctl-a4'].map((id, i) =>
      c.client.run(
        spec({
          session_id: id,
          ...(i === 0 ? { class: 'W' as const, gateway_key: KEY } : { class: 'O' as const }),
        }),
      ),
    );
    await until(() => d.started.length === 4);
    const s = await slots(c);
    expect(s).toMatchObject({ used_total: 4, caps: { total: 4, coding: 1 } });
    expect(Object.values(s.free).every((n) => n === 0)).toBe(true);
    const over = await c.client.run(spec({ session_id: 'ctl-a5' }));
    expect(!over.ok && over.error.code).toBe('busy');
    expect(d.started).not.toContain('ctl-a5');
    d.release('ctl-a1');
    expect((await runs[0])!.ok).toBe(true);
    expect((await slots(c)).free.O).toBe(1);
    const again = c.client.run(spec({ session_id: 'ctl-a6' }));
    await until(() => d.started.includes('ctl-a6'));
    for (const id of ['ctl-a2', 'ctl-a3', 'ctl-a4', 'ctl-a6']) d.release(id);
    for (const r of [...runs.slice(1), again]) expect((await r).ok).toBe(true);
    expect((await slots(c)).used_total).toBe(0);
  });

  it('the coding cap is class W: a second W is busy while one runs, other classes still start; coding 0 starts no W', async () => {
    const d = new HeldDriver();
    const caps = new StaticCaps({ total: 4, coding: 1 });
    tc = await startTestController({
      driver: d,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      caps,
    });
    const c = tc;
    const w1 = c.client.run(spec({ session_id: 'ctl-w1', class: 'W', gateway_key: KEY }));
    await until(() => d.started.length === 1);
    const s = await slots(c);
    expect(freeCodingSlots(s)).toBe(0);
    expect(s.free.O).toBe(3);
    expect(s.used.W).toBe(1);
    expect(s.sessions).toEqual([
      expect.objectContaining({
        session_id: 'ctl-w1',
        class: 'W',
        grant_id: CONTRACT_GRANT.grant_id,
      }),
    ]);
    const w2 = await c.client.run(spec({ session_id: 'ctl-w2', class: 'W', gateway_key: KEY }));
    expect(!w2.ok && w2.error.code).toBe('busy');
    const o1 = c.client.run(spec({ session_id: 'ctl-o1' }));
    await until(() => d.started.includes('ctl-o1'));
    d.release('ctl-w1');
    d.release('ctl-o1');
    expect((await w1).ok && (await o1).ok).toBe(true);
    caps.caps = { total: 4, coding: 0 };
    expect(freeCodingSlots(await slots(c))).toBe(0);
    const w3 = await c.client.run(spec({ session_id: 'ctl-w3', class: 'W', gateway_key: KEY }));
    expect(!w3.ok && w3.error.code).toBe('busy');
  });

  it('a session id that is running already is refused, not run twice', async () => {
    const d = new HeldDriver();
    tc = await startTestController({ driver: d, grants: new FakeGrants().grant(CONTRACT_GRANT) });
    const c = tc;
    const a = c.client.run(spec({ session_id: 'ctl-dup1' }));
    await until(() => d.started.length === 1);
    const b = await c.client.run(spec({ session_id: 'ctl-dup1' }));
    expect(!b.ok && b.error.code).toBe('refused');
    d.release('ctl-dup1');
    expect((await a).ok).toBe(true);
  });
});

describe('the slot is always released', () => {
  it('on a driver that throws (driver_failure) and on a driver error (its own code)', async () => {
    let mode: 'throw' | 'error' | 'ok' = 'throw';
    const driver: SandboxPort = {
      run: async (s) => {
        if (mode === 'throw') throw new Error('docker went away');
        if (mode === 'error') return err(sandboxError('unavailable', 'the proxy refused'));
        return new FakeSandbox().run(s);
      },
    };
    tc = await startTestController({
      driver,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      caps: new StaticCaps({ total: 1, coding: 1 }),
    });
    const w = spec({ class: 'W', gateway_key: KEY });
    const thrown = await tc.client.run(w);
    expect(!thrown.ok && thrown.error).toMatchObject({ code: 'driver_failure' });
    expect(!thrown.ok && thrown.error.message).toContain('docker went away');
    expect((await slots(tc)).used_total).toBe(0);
    mode = 'error';
    expect(await tc.client.run(w)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect((await slots(tc)).used_total).toBe(0);
    mode = 'ok';
    expect((await tc.client.run(w)).ok).toBe(true);
    expect((await slots(tc)).used_total).toBe(0);
  });
});

describe('the HTTP surface', () => {
  it('/v1/slots is the SandboxSlots shape with the caps and their source; /healthz needs no token', async () => {
    tc = await startTestController({ driver: new FakeSandbox() });
    const res = await fetch(new URL('/v1/slots', tc.url), {
      headers: { authorization: `Bearer ${tc.token}` },
    });
    const body = SandboxSlots.parse(await res.json());
    expect(body).toMatchObject({
      host_id: 'test',
      caps: DEFAULT_SANDBOX_CAPS,
      caps_source: 'default',
      used_total: 0,
      free: { W: 1, O: 4, K: 4 },
    });
    expect((await fetch(new URL('/healthz', tc.url))).status).toBe(200);
  });

  it('a caller without a token is 401; one without the scope is 403', async () => {
    tc = await startTestController({ driver: new FakeSandbox(), scopes: ['read'] });
    expect((await fetch(new URL('/v1/slots', tc.url))).status).toBe(401);
    const other = new HttpSandbox({ baseUrl: tc.url, token: 'x'.repeat(32) });
    expect(await other.slots()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    // `read` only: no session
    const r = await tc.client.run(spec());
    expect(r.ok).toBe(false);
    const res = await fetch(new URL('/v1/admin/reload', tc.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${tc.token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('the caps fall back closed', () => {
  const readerOf = (o: {
    value: unknown;
    rejected?: string[];
    factory?: string | null;
    fail?: boolean;
  }) =>
    ({
      current: () => ({
        rejected: o.rejected ?? [],
        revisions: { factory: o.factory === undefined ? 'rev1' : o.factory, project: null },
        get: () => o.value,
      }),
      refresh: async () => {
        if (o.fail) throw new Error('db down');
        return false;
      },
    }) as never;

  it('a published value the schema no longer takes, or a malformed one, is the defaults', () => {
    expect(
      new ConfigCaps(
        readerOf({ value: { total: 8, coding: 2 }, rejected: [SANDBOX_CAPS_KEY] }),
        'h',
      ).current(),
    ).toEqual({ caps: DEFAULT_SANDBOX_CAPS, source: 'default' });
    expect(new ConfigCaps(readerOf({ value: 'eight' }), 'h').current().caps).toEqual(
      DEFAULT_SANDBOX_CAPS,
    );
    expect(new ConfigCaps(readerOf({ value: { total: 8, coding: 2 } }), 'h').current()).toEqual({
      caps: { total: 8, coding: 2 },
      source: 'config',
    });
  });

  it('a reload that fails keeps no caps above the defaults until one works', async () => {
    const o = { value: { total: 8, coding: 2 }, fail: true };
    const errors: unknown[] = [];
    const c = new ConfigCaps(readerOf(o), 'h', (e) => errors.push(e));
    await c.reload();
    expect(c.current()).toEqual({ caps: DEFAULT_SANDBOX_CAPS, source: 'default' });
    expect(errors).toHaveLength(1);
    o.fail = false;
    await c.reload();
    expect(c.current().caps).toEqual({ total: 8, coding: 2 });
    // a lower published value stays lower when stale
    const low = { value: { total: 2, coding: 0 }, fail: true };
    const c2 = new ConfigCaps(readerOf(low), 'h');
    await c2.reload();
    expect(c2.current().caps).toEqual({ total: 2, coding: 0 });
  });
});

describe('M16: the onboarding probe image and grant', () => {
  const IMG = `aisdlc/sandbox-onboarding@sha256:${'1'.repeat(64)}`;
  const PROBE_GRANT = {
    grant_id: `probe-${'b'.repeat(32)}`,
    item_id: '01930000-0000-7000-8000-0000000000dd',
    unit_id: ONBOARDING_PROBE_UNIT,
    lease_epoch: 1,
  };
  const probe = (over: Partial<SandboxSpec> = {}): SandboxSpec =>
    spec({
      class: 'K-exec',
      session_id: 'probe-bbbbbbbb',
      grant: PROBE_GRANT,
      image: IMG,
      ...over,
    });

  it('a K-exec session runs only the approved image; none approved: nothing runs', async () => {
    const fake = new FakeSandbox();
    let approved: string | null = null;
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(PROBE_GRANT),
      probeImage: () => approved,
    });
    const none = await tc.client.run(probe());
    expect(none.ok ? null : none.error.code).toBe('refused');
    approved = IMG;
    const other = await tc.client.run(probe({ image: `sha256:${'2'.repeat(64)}` }));
    expect(other.ok ? null : other.error.code).toBe('refused');
    const noImage: SandboxSpec = { ...probe() };
    delete (noImage as { image?: string }).image;
    const missing = await tc.client.run(noImage);
    expect(missing.ok).toBe(false);
    const good = await tc.client.run(probe());
    expect(good.ok).toBe(true);
    expect(fake.runs.map((r) => r.image)).toEqual([IMG]);
  });

  it('an image named by tag is invalid; another class may not name an image', async () => {
    const fake = new FakeSandbox();
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(CONTRACT_GRANT).grant(PROBE_GRANT),
      probeImage: () => IMG,
    });
    const tag = await tc.client.run(probe({ image: 'aisdlc/sandbox-onboarding:local' }));
    expect(tag.ok ? null : tag.error.code).toBe('invalid_spec');
    const o = await tc.client.run(spec({ image: IMG }));
    expect(o.ok ? null : o.error.code).toBe('refused');
    expect(fake.runs).toEqual([]);
  });

  it('a probe grant starts a K-exec session and nothing else', async () => {
    const fake = new FakeSandbox();
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(PROBE_GRANT),
      probeImage: () => IMG,
    });
    const o = await tc.client.run(
      spec({ class: 'O', session_id: 'probe-cccccccc', grant: PROBE_GRANT }),
    );
    expect(o.ok ? null : o.error.code).toBe('refused');
    expect(fake.runs).toEqual([]);
    expect((await tc.client.run(probe())).ok).toBe(true);
  });
});

describe('M16 part 3: W runs only the image LF4 was recorded for', () => {
  const LF4 = `sha256:${'a'.repeat(64)}`;
  const OTHER = `sha256:${'b'.repeat(64)}`;
  const w = (id: string) => spec({ session_id: id, class: 'W', gateway_key: KEY });

  it('the reasons, pure: none named, the host not by digest, another image; the same digest under a name is the image', () => {
    expect(workerImageWhyNot(null, LF4)).toMatch(/names no worker_image/);
    expect(workerImageWhyNot(LF4, null)).toMatch(/not named by digest/);
    expect(workerImageWhyNot(LF4, OTHER)).toMatch(/not sha256:aaaa/);
    expect(workerImageWhyNot(`aisdlc/sandbox-agent@${LF4}`, LF4)).toBeNull();
  });

  it('a mismatch, or no image named, refuses W with image_unverified and starts nothing; O is not concerned; the match runs', async () => {
    const fake = new FakeSandbox();
    const cfg: { lf4: string | null } = { lf4: null };
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      workerImage: { lf4: () => cfg.lf4, host: LF4 },
    });
    const none = await tc.client.run(w('ctl-li-1'));
    expect(none.ok ? null : none.error).toMatchObject({
      code: 'image_unverified',
      message: expect.stringMatching(/names no worker_image/),
    });
    cfg.lf4 = OTHER;
    const other = await tc.client.run(w('ctl-li-2'));
    expect(other.ok ? null : other.error.code).toBe('image_unverified');
    expect(fake.runs).toEqual([]);
    expect((await tc.client.run(spec({ session_id: 'ctl-li-o' }))).ok).toBe(true);
    cfg.lf4 = LF4;
    expect((await tc.client.run(w('ctl-li-3'))).ok).toBe(true);
    expect(fake.runs.map((r) => r.session_id)).toEqual(['ctl-li-o', 'ctl-li-3']);
  });

  it('a config read that throws is no image (fail closed); a host whose W image is not named refuses too', async () => {
    const fake = new FakeSandbox();
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      workerImage: {
        lf4: () => {
          throw new Error('reader down');
        },
        host: LF4,
      },
    });
    const r = await tc.client.run(w('ctl-li-4'));
    expect(r.ok ? null : r.error.code).toBe('image_unverified');
    await tc.close();
    tc = await startTestController({
      driver: fake,
      grants: new FakeGrants().grant(CONTRACT_GRANT),
      workerImage: { lf4: () => LF4, host: null },
    });
    const h = await tc.client.run(w('ctl-li-5'));
    expect(h.ok ? null : h.error.code).toBe('image_unverified');
    expect(fake.runs).toEqual([]);
  });
});
