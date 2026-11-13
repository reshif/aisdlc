import { describe, expect, it } from 'vitest';
import { signoffFeasibility } from '../src/index.js';
import { pr } from './helpers.js';

// Can the onboarding signer gate (M4) be decided at a tier by the people a role map would name? Before it opens.

const on = { enabled: true, default: 'on_if_2plus', locked_on: false } as const;

describe('signoffFeasibility', () => {
  it('T2 with one other signer is infeasible, whatever the two-person setting says', () => {
    const r = signoffFeasibility({
      tier: 'T2',
      twoPerson: { ...on, enabled: false },
      holders: [pr('a'), pr('req')],
      requester: pr('req'),
    });
    expect(r.state).toBe('infeasible');
    expect(r.reason).toMatch(/T2 needs two approvers/);
    expect(r.eligible).toBe(1);
  });

  it('T2 with two other signers needs two', () => {
    const r = signoffFeasibility({
      tier: 'T2',
      twoPerson: { ...on, locked_on: true },
      holders: [pr('a'), pr('b')],
      requester: pr('req'),
    });
    expect(r).toMatchObject({ state: 'feasible', required: 2, eligible: 2 });
  });

  it('T1 with a sole holder who is the requester decides by the waiver; T2 does not', () => {
    const t1 = signoffFeasibility({
      tier: 'T1',
      twoPerson: on,
      holders: [pr('req')],
      requester: pr('req'),
    });
    expect(t1).toMatchObject({ state: 'feasible', required: 1 });
    const t2 = signoffFeasibility({
      tier: 'T2',
      twoPerson: on,
      holders: [pr('req')],
      requester: pr('req'),
    });
    expect(t2.state).toBe('infeasible');
  });

  it('nobody holds the slot: infeasible', () => {
    expect(
      signoffFeasibility({ tier: 'T0', twoPerson: on, holders: [], requester: pr('req') }),
    ).toMatchObject({
      state: 'infeasible',
      eligible: 0,
    });
  });
});
