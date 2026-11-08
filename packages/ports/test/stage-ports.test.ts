import { describe, expect, it } from 'vitest';
import { FakeStagePort, FakeStagePorts, defaultStageOutcome } from '../src/index.js';

const req = (over: Record<string, unknown> = {}) =>
  ({
    command_key: 'k1',
    item_id: '00000000-0000-4000-8000-000000000001',
    project_id: 'acme',
    repo: 'acme/app',
    lane: 'L3',
    step: '3.2',
    attempt: 1,
    approved_gates: [],
    catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
    ...over,
  }) as never;

describe('the deterministic stage-port fakes (PLAN M9.2)', () => {
  it('answer deterministically and do the work once per command key', async () => {
    const p = new FakeStagePort('planning');
    const a = await p.run(req());
    const b = await p.run(req());
    expect(a).toEqual(b);
    expect(p.calls).toHaveLength(2);
    expect(p.effects).toEqual(['k1']);
    expect((await p.run(req({ command_key: 'k2' }))).ok).toBe(true);
    expect(p.effects).toEqual(['k1', 'k2']);
    // a new instance answers the same way: a pure function of the request
    expect(await new FakeStagePort('planning').run(req())).toEqual(a);
  });

  it('classify as asked at 1.3 and grant a lease at 6.0', () => {
    expect(defaultStageOutcome(req({ step: '1.3', lane: 'L5' }))).toMatchObject({
      outcome: 'classified',
      lane: 'L5',
    });
    expect(defaultStageOutcome(req({ step: '6.0' }))).toMatchObject({
      outcome: 'completed',
      lease_epoch: 1,
    });
  });

  it('can be scripted, but only with what a real port could say', async () => {
    const p = new FakeStagePort('verify').scriptStep('7.1', [
      { outcome: 'failed', code: 'ci_red' },
    ]);
    expect(await p.run(req({ step: '7.1' }))).toEqual({
      ok: true,
      value: { outcome: 'failed', code: 'ci_red' },
    });
    // attempt 2 has no script: the default
    expect(await p.run(req({ step: '7.1', attempt: 2, command_key: 'k9' }))).toMatchObject({
      ok: true,
      value: { outcome: 'completed' },
    });
    const bad = new FakeStagePort('coding').script(
      () => ({ outcome: 'gate_needed', gate: 'G4', reason_code: 'x' }) as never,
    );
    await expect(bad.run(req())).rejects.toThrow();
  });

  it('can lose a response after the effect, and be unreachable', async () => {
    const p = new FakeStagePort('coding').loseResponse('k1', 1);
    expect((await p.run(req())).ok).toBe(false);
    expect(p.effects).toEqual(['k1']); // the work was done
    expect((await p.run(req())).ok).toBe(true); // redelivery answered from memory
    expect(p.effects).toEqual(['k1']);
    p.breakIt();
    expect((await p.run(req({ command_key: 'k3' }))).ok).toBe(false);
    expect(p.effects).toEqual(['k1']); // nothing was done while it was down
  });

  it('come as a set of four with the effects of all', async () => {
    const all = new FakeStagePorts();
    await all.planning.run(req());
    await all.coding.run(req({ command_key: 'c1', step: '6.4' }));
    expect(all.effects()).toEqual(['k1', 'c1']);
    expect(all.calls()).toHaveLength(2);
  });
});
