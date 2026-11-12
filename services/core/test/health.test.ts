import { HealthView, FACTORY_SERVICES } from '@aisdlc/contracts';
import { LoopSupervisor } from '@aisdlc/loops';
import { ServiceAuth, listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectHealth,
  createCoreApp,
  probeService,
  readHealthSnapshots,
  snapshotsOfReport,
  writeHealthSnapshots,
  type CoreScope,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// M19: HealthSnapshot / HealthTile on a real Postgres. core-worker's `health_snapshot` loop reads its own supervisor
// and each configured service's /healthz into `core.health_snapshot` (the newest reading per tile); core serves the
// tiles with the HealthSnapshot rule applied at read time (older than two minutes reads unknown, never ok; a service
// nobody read is unknown).

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const T = {
  portal: 'portal-at-core-health'.padEnd(32, 'x'),
  nobody: 'nobody-at-core-health'.padEnd(32, 'x'),
};

beforeAll(async () => {
  s = await startCoreStack();
  const callers: Record<string, readonly CoreScope[]> = { portal: ['portal'], nobody: ['read'] };
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(T),
    callers,
    registry: s.registry,
    clock: s.clock,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

const view = async (token = T.portal) => {
  const r = await fetch(new URL('/v1/health', url), {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: (await r.json()) as unknown };
};

/** A fake service: answers its /healthz with the status and body it is given. */
async function fakeService(answer: { status: number; body: unknown }) {
  const a = newApp();
  a.get('/healthz', async (_req, reply) => reply.code(answer.status).send(answer.body));
  const u = await listen(a);
  return { url: u, close: () => a.close(), answer };
}

describe('probeService', () => {
  it('2xx is ok with its latency, non-2xx is down (unhealthy), no answer is down (unreachable)', async () => {
    const svc = await fakeService({ status: 200, body: { ok: true } });
    const now = () => new Date('2026-11-12T12:00:00.000Z');
    try {
      const [ok] = await probeService('notary', { url: svc.url }, now);
      expect(ok).toMatchObject({ tile_id: 'service.notary', state: 'ok', detail_code: 'ok' });
      expect(typeof ok?.sli_value).toBe('number');
      svc.answer.status = 503;
      expect((await probeService('notary', { url: svc.url }, now))[0]).toMatchObject({
        state: 'down',
        detail_code: 'unhealthy',
      });
    } finally {
      await svc.close();
    }
    expect((await probeService('notary', { url: svc.url }, now))[0]).toMatchObject({
      state: 'down',
      detail_code: 'unreachable',
      sli_value: null,
    });
  });

  it("a loop host's answer gives a tile per loop and its own from the same report", async () => {
    const svc = await fakeService({
      status: 200,
      body: {
        status: 'ok',
        loops: [
          { name: 'gate_watch', state: 'ok', consecutive_failures: 0 },
          { name: 'merge_watch', state: 'degraded', consecutive_failures: 2 },
          { name: 'Bad Name', state: 'ok', consecutive_failures: 0 },
        ],
        alerts: [],
      },
    });
    try {
      const snaps = await probeService('gate-check', { url: svc.url }, () => new Date());
      expect(snaps.map((x) => [x.tile_id, x.state])).toEqual([
        ['loop.gate-check.gate_watch', 'ok'],
        ['loop.gate-check.merge_watch', 'degraded'],
        ['service.gate-check', 'degraded'],
      ]);
    } finally {
      await svc.close();
    }
  });
});

describe('snapshotsOfReport (a supervisor report)', () => {
  it('maps loop states: starting unknown, failing and stalled down; unhealthy or an alert marks the host', () => {
    const at = new Date('2026-11-12T12:00:00.000Z');
    const loop = (name: string, state: string) =>
      ({ name, state, consecutive_failures: 0 }) as never;
    const r = snapshotsOfReport(
      'core-worker',
      {
        status: 'unhealthy',
        loops: [loop('a', 'starting'), loop('b', 'failing'), loop('c', 'stalled'), loop('d', 'ok')],
        alerts: [],
      },
      at,
    );
    expect(r.map((x) => [x.tile_id, x.state, x.detail_code])).toEqual([
      ['loop.core-worker.a', 'unknown', 'starting'],
      ['loop.core-worker.b', 'down', 'failing'],
      ['loop.core-worker.c', 'down', 'stalled'],
      ['loop.core-worker.d', 'ok', 'ok'],
      ['service.core-worker', 'down', 'unhealthy'],
    ]);
    const alerted = snapshotsOfReport(
      'core-worker',
      { status: 'ok', loops: [], alerts: [{ code: 'dead_letter', message: 'x' }] },
      at,
    );
    expect(alerted.at(-1)).toMatchObject({ state: 'degraded', detail_code: 'alert' });
  });
});

describe('the snapshot table and GET /v1/health', () => {
  it('nothing read: every service is unknown (no_report), never ok', async () => {
    const r = await view();
    expect(r.status).toBe(200);
    const v = HealthView.parse(r.body);
    expect(v.overall).toBe('unknown');
    expect(v.tiles.filter((t) => t.domain === 'service')).toHaveLength(FACTORY_SERVICES.length);
    expect(v.tiles.every((t) => t.state === 'unknown')).toBe(true);
  });

  it('a collection writes the host loops and each target; the view reads them; a stale one reads unknown', async () => {
    const svc = await fakeService({ status: 200, body: { ok: true } });
    const supervisor = new LoopSupervisor({ log: () => undefined });
    supervisor.add({ name: 'outbox_watch', intervalMs: 1_000, tick: async () => undefined });
    try {
      const at = s.clock.now();
      const written = await collectHealth({
        pool: s.record.pool,
        own: () => supervisor.health(),
        targets: { notary: { url: svc.url }, witness: { url: 'http://127.0.0.1:1' } },
        now: () => at,
      });
      expect(written.map((x) => x.tile_id).sort()).toEqual([
        'loop.core-worker.outbox_watch',
        'service.core-worker',
        'service.notary',
        'service.witness',
      ]);
      const v = HealthView.parse((await view()).body);
      const by = new Map(v.tiles.map((t) => [t.tile_id, t]));
      expect(by.get('service.notary')?.state).toBe('ok');
      expect(by.get('service.witness')).toMatchObject({
        state: 'down',
        detail_code: 'unreachable',
      });
      // a loop not run yet is starting: unknown, not ok
      expect(by.get('loop.core-worker.outbox_watch')?.state).toBe('unknown');
      expect(by.get('service.gateway')).toMatchObject({
        state: 'unknown',
        detail_code: 'no_report',
      });
      expect(v.overall).toBe('down');

      // three minutes later and nothing read again: the notary's ok is unknown (stale), never ok
      s.clock.advance(180_000);
      const later = HealthView.parse((await view()).body);
      expect(later.tiles.find((t) => t.tile_id === 'service.notary')).toMatchObject({
        state: 'unknown',
        stale: true,
        detail_code: 'stale',
      });
    } finally {
      await svc.close();
    }
  });

  it('an older reading never overwrites a newer one', async () => {
    const base = {
      tile_id: 'service.kms-local',
      domain: 'service' as const,
      detail_code: 'ok',
      sli_value: 1,
      reporter: 'core-worker',
    };
    await writeHealthSnapshots(s.record.pool, [
      { ...base, state: 'down', as_of: '2026-11-12T12:10:00.000Z' },
    ]);
    await writeHealthSnapshots(s.record.pool, [
      { ...base, state: 'ok', as_of: '2026-11-12T12:05:00.000Z' },
    ]);
    const kms = (await readHealthSnapshots(s.record.pool)).find(
      (x) => x.tile_id === 'service.kms-local',
    );
    expect(kms?.state).toBe('down');
  });

  it('needs the portal scope', async () => {
    expect((await view(T.nobody)).status).toBe(403);
  });
});
