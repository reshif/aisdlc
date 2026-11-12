import { ONBOARDING_PROBE_UNIT, SessionHeartbeat, type SandboxGrantRef } from '@aisdlc/contracts';
import { FakeSandbox, type SandboxPort, type SandboxSpec } from '@aisdlc/ports';
import { listen, newApp } from '@aisdlc/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxController } from '../src/controller.js';
import { StaticCaps } from '../src/caps.js';
import { FakeGrants } from '../src/grants.js';
import {
  CoreHeartbeats,
  FakeHeartbeatSink,
  HeartbeatReporter,
  unitKeyOf,
} from '../src/heartbeat.js';

// M19: the sandbox-controller is the heartbeat reporter. While a session holds its slot, it beats (at start and on
// every tick) to core's `POST /v1/sessions/heartbeat` with its `activity` token, so a busy session that makes no model
// call is not drawn stuck. A probe (no work item) never beats; a beat that cannot be delivered never touches a run.

const ITEM = '01930000-0000-7000-8000-0000000000a1';
const GRANT: SandboxGrantRef = {
  grant_id: `${ITEM}:main@2`,
  item_id: ITEM,
  unit_id: `${ITEM}:main`,
  lease_epoch: 2,
};
const PROBE: SandboxGrantRef = {
  grant_id: 'probe-0001',
  item_id: '01930000-0000-7000-8000-0000000000b2',
  unit_id: ONBOARDING_PROBE_UNIT,
  lease_epoch: 1,
};
const KEY = `aisk_${'0123456789abcdef'.repeat(2)}`;
const w = (id: string, grant: SandboxGrantRef = GRANT): SandboxSpec => ({
  session_id: id,
  class: 'W',
  command: ['node', 'run.js'],
  repo: [],
  gateway_key: KEY,
  grant,
});

/** A driver whose sessions wait until released (a long, quiet session). */
class HeldDriver implements SandboxPort {
  readonly fake = new FakeSandbox();
  private readonly waiting = new Map<string, () => void>();
  async run(s: SandboxSpec) {
    await new Promise<void>((r) => this.waiting.set(s.session_id, r));
    return this.fake.run(s);
  }
  release(id: string) {
    this.waiting.get(id)?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

function rig(o: { sink?: FakeHeartbeatSink; grants?: FakeGrants } = {}) {
  const driver = new HeldDriver();
  const sink = o.sink ?? new FakeHeartbeatSink();
  const grants = o.grants ?? new FakeGrants().grant(GRANT, 'proj-a');
  let now = new Date('2026-11-12T10:00:00.000Z');
  const ref: { reporter?: HeartbeatReporter } = {};
  const controller: SandboxController = new SandboxController({
    driver,
    caps: new StaticCaps({ total: 4, coding: 2 }),
    grants,
    hostId: 'test',
    now: () => now,
    onStart: (s) => void ref.reporter?.beat(s),
  });
  const reporter = new HeartbeatReporter({
    sessions: () => controller.sessions(),
    grants,
    sink,
    now: () => now,
  });
  ref.reporter = reporter;
  return {
    driver,
    sink,
    grants,
    controller,
    reporter,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('the heartbeat reporter', () => {
  it('beats a running session at start and on every tick, content-free, with the Unit key', async () => {
    const r = rig();
    const run = r.controller.run(w('sess-0001'));
    await flush();
    expect(r.sink.beats).toHaveLength(1);
    const first = r.sink.beats[0];
    expect(SessionHeartbeat.parse(first)).toEqual({
      item_id: ITEM,
      project_id: 'proj-a',
      session_id: 'sess-0001',
      unit_id: 'main',
      sandbox_class: 'W',
      at: '2026-11-12T10:00:00.000Z',
    });
    r.advance(30_000);
    await r.reporter.tick();
    r.advance(30_000);
    await r.reporter.tick();
    expect(r.sink.beats.map((b) => b.at)).toEqual([
      '2026-11-12T10:00:00.000Z',
      '2026-11-12T10:00:30.000Z',
      '2026-11-12T10:01:00.000Z',
    ]);
    expect(r.reporter.stats()).toMatchObject({
      sent: 3,
      last_recorded_at: '2026-11-12T10:01:00.000Z',
    });
    r.driver.release('sess-0001');
    expect((await run).ok).toBe(true);
    // the session ended: nothing beats for it any more
    await r.reporter.tick();
    expect(r.sink.beats).toHaveLength(3);
    expect(r.controller.sessions()).toEqual([]);
  });

  it('never beats an onboarding probe (it has no work item)', async () => {
    const grants = new FakeGrants().grant(PROBE, 'proj-a');
    const r = rig({ grants });
    expect(
      await r.reporter.heartbeatOf({
        session_id: 'probe-s',
        class: 'K-exec',
        grant_id: PROBE.grant_id,
        item_id: PROBE.item_id,
        unit_id: PROBE.unit_id,
        started_at: '2026-11-12T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('a grant whose project cannot be read is skipped and asked again on the next tick', async () => {
    const grants = new FakeGrants().grant(GRANT, 'proj-a');
    const r = rig({ grants });
    const run = r.controller.run(w('sess-0002'));
    // the grant was checked already (synchronously above); the project lookup at start fails
    grants.breakIt();
    await flush();
    expect(r.sink.beats).toHaveLength(0);
    expect(r.reporter.stats().skipped).toBe(1);
    grants.breakIt(false);
    await r.reporter.tick();
    expect(r.sink.beats).toHaveLength(1);
    r.driver.release('sess-0002');
    await run;
  });

  it('core refusing or unreachable never touches the session; it is counted', async () => {
    const sink = new FakeHeartbeatSink();
    sink.answer = 'unreachable';
    const r = rig({ sink });
    const run = r.controller.run(w('sess-0003'));
    await flush();
    sink.answer = 'refused';
    await r.reporter.tick();
    r.driver.release('sess-0003');
    expect((await run).ok).toBe(true);
    expect(r.reporter.stats()).toMatchObject({ sent: 0, unreachable: 1, refused: 1 });
  });

  it('a reporter that throws in onStart never fails the run', async () => {
    const driver = new HeldDriver();
    const c = new SandboxController({
      driver,
      caps: new StaticCaps({ total: 4, coding: 2 }),
      grants: new FakeGrants().grant(GRANT),
      hostId: 'test',
      onStart: () => {
        throw new Error('boom');
      },
    });
    const run = c.run(w('sess-0004'));
    await flush();
    driver.release('sess-0004');
    expect((await run).ok).toBe(true);
  });

  it('the Unit key: the grant Unit id without its item prefix, null when it does not fit', () => {
    expect(unitKeyOf(ITEM, `${ITEM}:main`)).toBe('main');
    expect(unitKeyOf(ITEM, 'unit-contract')).toBe('unit-contract');
    expect(unitKeyOf(ITEM, 'a:b')).toBeNull();
  });
});

describe('CoreHeartbeats: the HTTP sink', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('posts to /v1/sessions/heartbeat with the bearer token; 201 and 200 are recorded, 4xx refused, 5xx unreachable', async () => {
    const got: unknown[] = [];
    let status = 201;
    const app = newApp();
    app.post('/v1/sessions/heartbeat', async (req, reply) => {
      if (req.headers.authorization !== 'Bearer tok-activity') return reply.code(403).send({});
      got.push(req.body);
      return reply.code(status).send({ duplicate: status === 200 });
    });
    const url = await listen(app);
    close = () => app.close();
    const hb = SessionHeartbeat.parse({
      item_id: ITEM,
      project_id: 'proj-a',
      session_id: 'sess-1',
      unit_id: 'main',
      sandbox_class: 'W',
      at: '2026-11-12T10:00:00.000Z',
    });
    const sink = new CoreHeartbeats({ baseUrl: url, token: 'tok-activity' });
    expect(await sink.post(hb)).toBe('recorded');
    status = 200;
    expect(await sink.post(hb)).toBe('recorded');
    status = 400;
    expect(await sink.post(hb)).toBe('refused');
    status = 503;
    expect(await sink.post(hb)).toBe('unreachable');
    expect(await new CoreHeartbeats({ baseUrl: url, token: 'wrong' }).post(hb)).toBe('refused');
    expect(got[0]).toEqual(hb);
    await app.close();
    close = undefined;
    expect(await sink.post(hb)).toBe('unreachable');
  });
});
