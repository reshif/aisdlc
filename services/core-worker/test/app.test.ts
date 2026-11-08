import { LoopSupervisor } from '@aisdlc/loops';
import { ManualScheduler } from '@aisdlc/loops/testing';
import { describe, expect, it } from 'vitest';
import { createCoreWorkerApp } from '../src/index.js';

const MIN = 60_000;

describe('GET /healthz and /metrics', () => {
  it('one aggregated healthz: 200 while ok, 503 when a loop fails past N, stalls, or an alert is active', async () => {
    const sched = new ManualScheduler();
    const sup = new LoopSupervisor({
      clock: sched.clock,
      sleep: sched.sleep,
      log: () => undefined,
      stopTimeoutMs: 50,
    });
    let poison = false;
    sup.add({ name: 'good', intervalMs: MIN, tick: async () => undefined });
    sup.add({
      name: 'bad',
      intervalMs: MIN,
      unhealthyAfterMs: 5 * MIN,
      tick: async () => {
        if (poison) throw new Error('boom');
      },
    });
    const app = createCoreWorkerApp(sup);
    sup.start();
    await sched.advance(3 * MIN);
    let res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', alerts: [] });

    poison = true;
    await sched.advance(10 * MIN);
    res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { loops: Array<{ name: string; state: string }> };
    expect(Object.fromEntries(body.loops.map((l) => [l.name, l.state]))).toEqual({
      good: 'ok',
      bad: 'failing',
    });

    poison = false;
    await sched.advance(2 * MIN);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    sup.setAlert('outbox_dead', { code: 'outbox_dead', message: '1 dead', count: 1 });
    res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ alerts: [{ code: 'outbox_dead', count: 1 }] });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('aisdlc_loop_ticks_total{loop="good",outcome="ok"}');
    expect(metrics.body).toContain('aisdlc_alert_active{code="outbox_dead"} 1');
    await sup.stop();
    await app.close();
  });
});
