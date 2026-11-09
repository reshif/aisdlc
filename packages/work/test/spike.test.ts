import { describe, expect, it } from 'vitest';
import { PROFILE_ALL_ON, Sim } from './sim.js';

// M13.7 in the engine (PLAN M13.7; FL FIX 6 "L7 SPIKE REPORT: findings + recommendation, branch archived, no Push Broker PR,
// never reaches G4"): the route of a spike has the throwaway S6 up to 6.5, then the close-out 9.3. It never asks the coding
// port for 6.6 (the Push Broker's step), never runs S7, never opens G4.

describe('the L7 spike path in the engine', () => {
  const run = (): Sim => new Sim('spike-route', { lane: 'L7', profile: PROFILE_ALL_ON }).run_();

  it('runs 6.1 to 6.5 and 9.3, and ends Done', () => {
    const sim = run();
    const steps = sim.executed
      .filter((c) => c.type === 'run_stage')
      .map((c) => (c as { step: string }).step);
    for (const s of ['6.0', '6.1', '6.2', '6.3', '6.4', '6.5', '9.3'])
      expect(steps, s).toContain(s);
    expect(sim.state.terminal).toBe('Done');
  });

  it('never asks for 6.6 (the Push Broker), never runs S7, never opens G4', () => {
    const sim = run();
    const steps = sim.executed
      .filter((c) => c.type === 'run_stage')
      .map((c) => (c as { step: string }).step);
    expect(steps).not.toContain('6.6');
    expect(steps.filter((s) => s.startsWith('7.') || s.startsWith('8.'))).toEqual([]);
    expect(sim.gateLog.flatMap((g) => g.gates)).not.toContain('G4');
  });

  it('6.5 is followed directly by 9.3', () => {
    const sim = run();
    const steps = sim.executed
      .filter((c) => c.type === 'run_stage')
      .map((c) => (c as { step: string }).step);
    expect(steps[steps.indexOf('6.5') + 1]).toBe('9.3');
  });
});
