import { describe, expect, it } from 'vitest';
import { FakeCapacity } from '../src/index.js';

const scope = { project_id: 'acme', repo: 'acme/app' };

describe('the deterministic capacity fake (PLAN M9.3)', () => {
  it('grants nothing until a test says so, and spends what it grants', async () => {
    const c = new FakeCapacity();
    expect(await c.take('H2', scope, 3)).toEqual({ ok: true, value: 0 });
    c.grant('H2', 2);
    expect(await c.take('H2', scope, 5)).toEqual({ ok: true, value: 2 });
    expect(await c.take('H2', scope, 1)).toEqual({ ok: true, value: 0 });
    // another reason is its own pool
    c.grant('WIP', 1);
    expect(await c.take('H2', scope, 1)).toEqual({ ok: true, value: 0 });
    expect(await c.take('WIP', scope, 1)).toEqual({ ok: true, value: 1 });
  });

  it('an unreachable capacity is an error, never "free"', async () => {
    const c = new FakeCapacity().grant('H1', 4).breakIt();
    const r = await c.take('H1', scope, 1);
    expect(r.ok).toBe(false);
    c.breakIt(false);
    expect(await c.take('H1', scope, 1)).toEqual({ ok: true, value: 1 });
  });
});
