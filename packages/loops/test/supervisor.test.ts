import { describe, expect, it } from 'vitest';
import { LoopSupervisor, type LoopSpec } from '../src/index.js';
import { ManualScheduler } from '../src/testing.js';

const MIN = 60_000;

function setup() {
  const sched = new ManualScheduler();
  const lines: string[] = [];
  const sup = new LoopSupervisor({
    clock: sched.clock,
    sleep: sched.sleep,
    log: (l) => lines.push(l),
    stallGraceMs: 30_000,
    stopTimeoutMs: 50,
  });
  return { sched, lines, sup };
}

describe('LoopSupervisor', () => {
  it('runs a loop at its interval, starting at once', async () => {
    const { sched, sup } = setup();
    const ran: number[] = [];
    sup.add({
      name: 'steady',
      intervalMs: 10 * MIN,
      tick: async () => void ran.push(sched.clock.nowMs() - Date.parse('2026-11-08T00:00:00Z')),
    });
    sup.start();
    await sched.advance(35 * MIN);
    expect(ran).toEqual([0, 10 * MIN, 20 * MIN, 30 * MIN]);
    expect(sup.metrics()[0]).toMatchObject({ ticks_ok: 4, ticks_failed: 0 });
    await sup.stop();
  });

  it('backs off a loop that throws (exponential, capped), then resumes its interval when it recovers', async () => {
    const { sched, sup } = setup();
    const start = Date.parse('2026-11-08T00:00:00Z');
    const at: number[] = [];
    let failing = true;
    sup.add({
      name: 'flaky',
      intervalMs: 10 * MIN,
      retry: { baseMs: 30_000, maxMs: 4 * MIN },
      tick: async () => {
        at.push(sched.clock.nowMs() - start);
        if (failing) throw new Error('codehost down');
      },
    });
    sup.start();
    await sched.advance(8 * MIN);
    // t=0 fails -> +30 s, +1 min, +2 min, +4 min (cap), +4 min
    expect(at).toEqual([0, 30_000, 90_000, 210_000, 450_000]);
    failing = false;
    await sched.advance(4 * MIN);
    // The next retry (t=690 s) succeeds; from then on the normal 10-minute interval.
    expect(at.slice(-1)[0]).toBe(690_000);
    await sched.advance(10 * MIN);
    expect(at.slice(-1)[0]).toBe(690_000 + 10 * MIN);
    expect(sup.health().loops[0]).toMatchObject({ state: 'ok', consecutive_failures: 0 });
    await sup.stop();
  });

  it('a throwing, a hanging and a poison-item loop never stall a healthy one', async () => {
    const { sched, sup } = setup();
    const healthy: number[] = [];
    sup.add({
      name: 'healthy',
      intervalMs: MIN,
      tick: async () => void healthy.push(sched.clock.nowMs()),
    });
    sup.add({
      name: 'thrower',
      intervalMs: MIN,
      tick: async () => {
        throw new Error('always');
      },
    });
    sup.add({
      name: 'hanger',
      intervalMs: MIN,
      tick: () => new Promise<void>(() => undefined), // never returns
    });
    const processed: string[] = [];
    sup.add({
      name: 'poison',
      intervalMs: MIN,
      async tick(ctx) {
        return ctx.eachItem(
          ['a', 'poison', 'c'],
          (x) => x,
          async (x) => {
            if (x === 'poison') throw new Error('cannot handle');
            processed.push(x);
          },
        );
      },
    });
    sup.start();
    await sched.advance(30 * MIN);
    expect(healthy.length).toBe(31); // every minute, on time, throughout
    // The poison loop served its other items on every tick (normal cadence, no backoff).
    expect(processed.length).toBe(62);
    expect(sup.metrics().find((m) => m.name === 'poison')).toMatchObject({
      ticks_failed: 31,
      items_ok: 62,
      items_failed: 31,
    });
    const h = sup.health();
    const state = Object.fromEntries(h.loops.map((l) => [l.name, l.state]));
    expect(state).toEqual({
      healthy: 'ok',
      thrower: 'failing',
      hanger: 'stalled',
      poison: 'failing',
    });
    expect(h.status).toBe('unhealthy');
    await sup.stop();
  });

  it('health: degraded within the threshold, failing past it (503), ok again after a clean tick', async () => {
    const { sched, sup } = setup();
    let failing = false;
    sup.add({
      name: 'poll',
      intervalMs: MIN,
      unhealthyAfterMs: 5 * MIN,
      retry: { baseMs: MIN, maxMs: MIN },
      tick: async () => {
        if (failing) throw new Error('boom');
      },
    });
    sup.start();
    await sched.advance(2 * MIN);
    expect(sup.health().status).toBe('ok');
    failing = true;
    await sched.advance(3 * MIN);
    expect(sup.health().loops[0]?.state).toBe('degraded');
    expect(sup.health().status).toBe('ok'); // failing, but not for longer than N
    await sched.advance(4 * MIN);
    expect(sup.health().loops[0]?.state).toBe('failing');
    expect(sup.health().status).toBe('unhealthy');
    expect(sup.health().loops[0]?.last_error).toBe('boom');
    failing = false;
    await sched.advance(2 * MIN);
    expect(sup.health()).toMatchObject({
      status: 'ok',
      loops: [{ state: 'ok', failing_since: null }],
    });
    await sup.stop();
  });

  it('a loop that has not run when due is stalled; one not yet due is starting', async () => {
    const { sched, sup } = setup();
    sup.add({
      name: 'late_start',
      intervalMs: MIN,
      startDelayMs: 10 * MIN,
      tick: async () => undefined,
    });
    sup.start();
    await sched.advance(5 * MIN);
    expect(sup.health().loops[0]?.state).toBe('starting');
    await sched.advance(5 * MIN + 1);
    expect(sup.health().loops[0]?.state).toBe('ok');
    await sup.stop();
  });

  it('an active alert makes the aggregate unhealthy until cleared', async () => {
    const { sched, sup } = setup();
    sup.add({ name: 'x', intervalMs: MIN, tick: async () => undefined });
    sup.start();
    await sched.advance(MIN);
    sup.setAlert('outbox_dead', { code: 'outbox_dead', message: '2 dead', count: 2 });
    expect(sup.health()).toMatchObject({ status: 'unhealthy', alerts: [{ code: 'outbox_dead' }] });
    expect(sup.prometheus()).toContain('aisdlc_alert_active{code="outbox_dead"} 2');
    sup.setAlert('outbox_dead', null);
    expect(sup.health().status).toBe('ok');
    await sup.stop();
  });

  it('log lines carry the loop name as a prefix and are structured', async () => {
    const { sched, sup, lines } = setup();
    sup.add({
      name: 'head_poll',
      intervalMs: MIN,
      tick: async () => {
        throw new Error('nope');
      },
    });
    sup.start();
    await sched.advance(1);
    await sup.stop();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.startsWith('head_poll: ')).toBe(true);
      const j = JSON.parse(l.slice('head_poll: '.length));
      expect(j).toHaveProperty('level');
      expect(j).toHaveProperty('msg');
    }
    expect(lines.some((l) => l.includes('"msg":"tick failed"') && l.includes('nope'))).toBe(true);
  });

  it('exposes per-loop metrics in Prometheus text', async () => {
    const { sched, sup } = setup();
    sup.add({ name: 'a_loop', intervalMs: MIN, tick: async () => ({ ok: 3 }) });
    sup.add({
      name: 'b_loop',
      intervalMs: MIN,
      tick: async () => {
        throw new Error('x');
      },
    });
    sup.start();
    await sched.advance(2 * MIN);
    const text = sup.prometheus();
    expect(text).toContain('aisdlc_loop_ticks_total{loop="a_loop",outcome="ok"} 3');
    expect(text).toContain('aisdlc_loop_items_total{loop="a_loop",outcome="ok"} 9');
    expect(text).toMatch(/aisdlc_loop_ticks_total\{loop="b_loop",outcome="failed"\} [1-9]/);
    expect(text).toContain('aisdlc_loop_unhealthy{loop="a_loop"} 0');
    await sup.stop();
  });

  it('poke runs a sleeping loop now; stop ends sleeping loops and awaits running ticks', async () => {
    const { sched, sup } = setup();
    const ran: number[] = [];
    sup.add({ name: 'p', intervalMs: 10 * MIN, tick: async () => void ran.push(ran.length) });
    sup.start();
    await sched.settle();
    expect(ran).toEqual([0]);
    expect(sup.poke('p')).toBe(true);
    await sched.settle();
    expect(ran).toEqual([0, 1]);
    expect(sup.poke('missing')).toBe(false);
    await sup.stop();
  });

  it('refuses a bad or duplicate name', () => {
    const { sup } = setup();
    const spec: LoopSpec = { name: 'ok_name', intervalMs: 1, tick: async () => undefined };
    sup.add(spec);
    expect(() => sup.add(spec)).toThrow(/already added/);
    expect(() => sup.add({ ...spec, name: 'Bad Name' })).toThrow(/bad loop name/);
    expect(() => sup.add({ ...spec, name: 'zero', intervalMs: 0 })).toThrow(/intervalMs/);
  });
});
