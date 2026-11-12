import {
  GATES,
  GATE_POLICIES,
  GateIdValues,
  TWO_PERSON_GATES,
  TWO_PERSON_KILL_RELEASE,
  gatePolicy,
  type GateId,
  type PolicyKey,
  type Tier,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  evaluateVote,
  isT2,
  planQuorum,
  type PolicyContext,
  type VoteInput,
} from '../src/index.js';
import { pr } from './helpers.js';

const ctx = (tier: Tier | null, enabled = true, locked = false): PolicyContext => ({
  tier,
  two_person: { enabled: locked ? true : enabled, default: 'on_if_2plus', locked_on: locked },
});
const T0 = ctx('T0');
const T0_OFF = ctx('T0', false);
const T2 = ctx('T2');
const T2_LOCKED_UNKNOWN_TIER = ctx(null, true, true);
const people = (n: number) => ['ann', 'bob', 'cy', 'di'].slice(0, n).map(pr);

const TWO_PERSON_KEYS: PolicyKey[] = [...TWO_PERSON_GATES, TWO_PERSON_KILL_RELEASE];
const ONE_PERSON_KEYS: GateId[] = GateIdValues.filter((g) => gatePolicy(g).two_person === 'never');

describe('gate policy table', () => {
  it('has a policy for every gate, and the two-person gates are exactly the contract list', () => {
    expect(Object.keys(GATE_POLICIES).sort()).toEqual([...GateIdValues].sort());
    const flagged = GateIdValues.filter((g) => GATE_POLICIES[g].two_person === 'project');
    expect([...flagged].sort()).toEqual([...TWO_PERSON_GATES].sort());
    expect(gatePolicy(TWO_PERSON_KILL_RELEASE).two_person).toBe('project');
    expect(gatePolicy(TWO_PERSON_KILL_RELEASE).slot).toBe('kill');
  });

  it('never consolidates X, E, M or Q gates, nor G4 (FL PROFILES: SOLO consolidates, X/E/Q stay separate)', () => {
    for (const g of GateIdValues) {
      const fam = GATES[g].family;
      if (['action', 'exception', 'quarantine', 'meta', 'onboarding'].includes(fam) || g === 'G4') {
        expect(gatePolicy(g).consolidatable, g).toBe(false);
      }
    }
    // The SOLO cards of the flow: G0+G1, G2(+oracles), G3d+G3+G3s, G5+G6.
    for (const g of ['G0', 'G1', 'G2', 'G3', 'G3d', 'G3s', 'G5', 'G6'] as const) {
      expect(gatePolicy(g).consolidatable, g).toBe(true);
    }
  });

  it('M4 and G5 need a step-up; nothing else does by default', () => {
    expect(GateIdValues.filter((g) => GATE_POLICIES[g].step_up).sort()).toEqual(['G5', 'M4']);
  });
});

describe('planQuorum, two-person gates (table per gate)', () => {
  type Row = {
    name: string;
    ctx: PolicyContext;
    holders: number;
    want: { required: number; basis: string; waiver: boolean } | 'infeasible';
  };
  const rows: Row[] = [
    {
      name: 'T2, 2 holders',
      ctx: T2,
      holders: 2,
      want: { required: 2, basis: 'two_person', waiver: false },
    },
    {
      name: 'T2, 3 holders',
      ctx: T2,
      holders: 3,
      want: { required: 2, basis: 'two_person', waiver: false },
    },
    { name: 'T2, 1 holder: no waiver, infeasible', ctx: T2, holders: 1, want: 'infeasible' },
    {
      name: 'T2 by locked flag only, 1 holder',
      ctx: T2_LOCKED_UNKNOWN_TIER,
      holders: 1,
      want: 'infeasible',
    },
    {
      name: 'T2 by locked flag only, 2 holders',
      ctx: T2_LOCKED_UNKNOWN_TIER,
      holders: 2,
      want: { required: 2, basis: 'two_person', waiver: false },
    },
    { name: 'T2, nobody', ctx: T2, holders: 0, want: 'infeasible' },
    {
      name: 'T0 on, 2 holders',
      ctx: T0,
      holders: 2,
      want: { required: 2, basis: 'two_person', waiver: false },
    },
    {
      name: 'T0 on, 1 holder decides alone with waiver',
      ctx: T0,
      holders: 1,
      want: { required: 1, basis: 'single_holder', waiver: true },
    },
    {
      name: 'T0 off, 2 holders decide alone with waiver',
      ctx: T0_OFF,
      holders: 2,
      want: { required: 1, basis: 'two_person_off', waiver: true },
    },
    {
      name: 'T0 off, 1 holder',
      ctx: T0_OFF,
      holders: 1,
      want: { required: 1, basis: 'two_person_off', waiver: true },
    },
    {
      name: 'unknown tier, on, 2 holders',
      ctx: ctx(null),
      holders: 2,
      want: { required: 2, basis: 'two_person', waiver: false },
    },
    { name: 'T0 on, nobody', ctx: T0, holders: 0, want: 'infeasible' },
  ];
  describe.each(TWO_PERSON_KEYS)('%s', (key) => {
    it.each(rows)('$name', (r) => {
      const plan = planQuorum(key, r.ctx, people(r.holders), null);
      if (r.want === 'infeasible') {
        expect(plan.ok).toBe(false);
        expect(!plan.ok && plan.error.code).toBe('quorum_infeasible');
      } else {
        expect(
          plan.ok && {
            required: plan.value.required,
            basis: plan.value.basis,
            waiver: plan.value.waiver,
          },
        ).toEqual(r.want);
      }
    });
  });

  it('a duplicate holder listed twice is one person', () => {
    const plan = planQuorum('M4', T2, [pr('ann'), pr('ann')], null);
    expect(plan.ok).toBe(false);
  });

  it('the requester does not count toward the two approvers', () => {
    // X1 with holders ann+bob where ann is the requester: only bob can approve, two are needed.
    const plan = planQuorum('X1', T0, [pr('ann'), pr('bob')], pr('ann'));
    expect(plan.ok).toBe(false);
    const ok3 = planQuorum('X1', T0, [pr('ann'), pr('bob'), pr('cy')], pr('ann'));
    expect(ok3.ok && ok3.value.required).toBe(2);
  });
});

describe('planQuorum, single-approval gates', () => {
  it.each(ONE_PERSON_KEYS)('%s: one approval, no waiver, whatever the project (even T2)', (g) => {
    for (const c of [T0, T0_OFF, T2]) {
      const p = planQuorum(g, c, people(2), null);
      expect(p.ok && [p.value.required, p.value.waiver]).toEqual([1, false]);
    }
    expect(planQuorum(g, T0, [], null).ok).toBe(false);
  });
});

describe('own request (requester is not the approver)', () => {
  it('blocks the requester when someone else can decide', () => {
    const v = evaluateVote({
      key: 'G4',
      ctx: T0,
      holders: people(2),
      requester: pr('ann'),
      voter: pr('ann'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
    });
    expect(!v.ok && v.error.code).toBe('own_request');
  });
  it('lets the sole holder decide their own request, stamped sod_waiver (not T2)', () => {
    const v = evaluateVote({
      key: 'G4',
      ctx: T0,
      holders: people(1),
      requester: pr('ann'),
      voter: pr('ann'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
    });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['decided', true]);
  });
  it('T2: the sole holder cannot decide their own request at all', () => {
    const v = evaluateVote({
      key: 'G4',
      ctx: T2,
      holders: people(1),
      requester: pr('ann'),
      voter: pr('ann'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
    });
    expect(v.ok).toBe(false);
    expect(planQuorum('G4', T2, people(1), pr('ann')).ok).toBe(false);
  });
  it('G6 is the requester accepting: allowed, no waiver', () => {
    const v = evaluateVote({
      key: 'G6',
      ctx: T2,
      holders: people(2),
      requester: pr('ann'),
      voter: pr('ann'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
    });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['decided', false]);
  });
  it('a requester who is not a holder is simply not eligible', () => {
    const v = evaluateVote({
      key: 'G4',
      ctx: T0,
      holders: people(2),
      requester: pr('zed'),
      voter: pr('zed'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
    });
    expect(!v.ok && v.error.code).toBe('not_eligible');
  });
});

describe('plan author (B5): barred like the requester on G3', () => {
  const vote = (over: Partial<VoteInput>): ReturnType<typeof evaluateVote> =>
    evaluateVote({
      key: 'G3',
      ctx: T0,
      holders: people(2),
      requester: pr('cy'),
      authors: [pr('ann')],
      voter: pr('ann'),
      decision: 'approve',
      approvers: [],
      frozenQuorum: 1,
      ...over,
    });
  it('refuses the author when someone else can decide', () => {
    const v = vote({});
    expect(!v.ok && v.error.code).toBe('own_request');
    // reject is a decision too: the author does not end the gate either
    const r = vote({ decision: 'reject' });
    expect(!r.ok && r.error.code).toBe('own_request');
  });
  it('lets the other holder decide, no waiver', () => {
    const v = vote({ voter: pr('bob') });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['decided', false]);
  });
  it('the sole holder who wrote the plan decides with a stamped sod_waiver (not T2)', () => {
    const v = vote({ holders: people(1) });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['decided', true]);
  });
  it('T2: the sole holder who wrote the plan cannot decide, and the gate cannot open', () => {
    expect(vote({ ctx: T2, holders: people(1) }).ok).toBe(false);
    expect(planQuorum('G3', T2, people(1), pr('cy'), [pr('ann')]).ok).toBe(false);
  });
  it('two holders who are both the requester and the author: nobody may decide (no waiver for two)', () => {
    expect(planQuorum('G3', T0, people(2), pr('ann'), [pr('bob')]).ok).toBe(false);
  });
  it('a gate that allows the own request (G6) ignores authors', () => {
    const v = vote({ key: 'G6', ctx: T2 });
    expect(v.ok && v.value.sod_waiver).toBe(false);
  });
});

describe('evaluateVote', () => {
  const base: VoteInput = {
    key: 'X1',
    ctx: T0,
    holders: people(3),
    requester: null,
    voter: pr('ann'),
    decision: 'approve',
    approvers: [],
    frozenQuorum: 2,
  };
  it('refuses a voter who does not hold the slot', () => {
    const v = evaluateVote({ ...base, voter: pr('zed') });
    expect(!v.ok && v.error.code).toBe('not_eligible');
  });
  it('first approval of two is pending; the second decides; no waiver', () => {
    const a = evaluateVote(base);
    expect(a.ok && [a.value.outcome, a.value.approvals_after, a.value.sod_waiver]).toEqual([
      'pending',
      1,
      false,
    ]);
    const b = evaluateVote({ ...base, voter: pr('bob'), approvers: [pr('ann')] });
    expect(b.ok && [b.value.outcome, b.value.approvals_after, b.value.sod_waiver]).toEqual([
      'decided',
      2,
      false,
    ]);
  });
  it('the same principal twice counts once: the repeat is refused', () => {
    const v = evaluateVote({ ...base, approvers: [pr('ann')] });
    expect(!v.ok && v.error.code).toBe('already_voted');
  });
  it('reject and request_changes by any eligible voter end the gate at once', () => {
    for (const decision of ['reject', 'request_changes'] as const) {
      const v = evaluateVote({ ...base, decision });
      expect(v.ok && v.value.outcome).toBe('decided');
      const after = evaluateVote({ ...base, decision, voter: pr('bob'), approvers: [pr('ann')] });
      expect(after.ok && after.value.outcome).toBe('decided');
    }
  });
  it('single holder on a two-person gate: one approval decides, stamped', () => {
    const v = evaluateVote({ ...base, holders: people(1), frozenQuorum: 1 });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['decided', true]);
  });
  it('refuses when the policy now needs more approvals than the gate was opened for', () => {
    const v = evaluateVote({ ...base, frozenQuorum: 1 });
    expect(!v.ok && v.error.code).toBe('policy_changed');
  });
  it('keeps the frozen (stricter) quorum when the policy has relaxed since', () => {
    const v = evaluateVote({ ...base, ctx: T0_OFF, frozenQuorum: 2 });
    expect(v.ok && [v.value.outcome, v.value.sod_waiver]).toEqual(['pending', false]);
  });
  it('refuses a T2 two-person gate with one holder', () => {
    const v = evaluateVote({ ...base, key: 'M4', ctx: T2, holders: people(1), frozenQuorum: 1 });
    expect(!v.ok && v.error.code).toBe('quorum_infeasible');
  });
});

describe('T2 never gets a sod_waiver (exhaustive over gates, holders, requesters, votes)', () => {
  it('no accepted vote in a T2 project is stamped', () => {
    let accepted = 0;
    const keys: PolicyKey[] = [...GateIdValues, TWO_PERSON_KILL_RELEASE];
    for (const key of keys) {
      for (const c of [T2, T2_LOCKED_UNKNOWN_TIER]) {
        for (let n = 0; n <= 3; n++) {
          const holders = people(n);
          for (const requester of [null, pr('ann'), pr('zed')]) {
            for (const voter of [...holders, pr('zed')]) {
              for (const decision of ['approve', 'reject', 'request_changes'] as const) {
                for (const frozenQuorum of [1, 2]) {
                  for (const approvers of [[], holders.slice(0, 1)]) {
                    const v = evaluateVote({
                      key,
                      ctx: c,
                      holders,
                      requester,
                      voter,
                      decision,
                      approvers,
                      frozenQuorum,
                    });
                    if (v.ok) {
                      accepted += 1;
                      expect(v.value.sod_waiver, `${key} n=${n} ${voter} ${decision}`).toBe(false);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });

  it('isT2 follows the tier or the locked flag', () => {
    expect(isT2(T2)).toBe(true);
    expect(isT2(T2_LOCKED_UNKNOWN_TIER)).toBe(true);
    expect(isT2(T0)).toBe(false);
    expect(isT2(ctx(null))).toBe(false);
  });
});

describe('the factory M1 (M15.5): never the proposer, no waiver, the policy decides how many', () => {
  const factory = (approvers: number): PolicyContext => ({
    ...ctx(null),
    factory_m1: { approvers },
  });
  const [ann, bob, cyd] = people(3) as [
    ReturnType<typeof pr>,
    ReturnType<typeof pr>,
    ReturnType<typeof pr>,
  ];

  it('the sole holder who proposed cannot decide: infeasible, not a waiver', () => {
    expect(planQuorum('M1', factory(1), [ann], ann).ok).toBe(false);
    // the same project rule without the factory policy would waive it
    expect(planQuorum('M1', ctx('T1'), [ann], ann)).toMatchObject({
      ok: true,
      value: { waiver: true },
    });
  });

  it('one other holder decides at one approver; the proposer is refused as own request', () => {
    expect(planQuorum('M1', factory(1), [ann, bob], ann)).toMatchObject({
      ok: true,
      value: { required: 1, waiver: false },
    });
    const base = {
      key: 'M1' as const,
      ctx: factory(1),
      holders: [ann, bob],
      requester: ann,
      decision: 'approve' as const,
      approvers: [],
      frozenQuorum: 1,
    };
    expect(evaluateVote({ ...base, voter: ann })).toMatchObject({
      ok: false,
      error: { code: 'own_request' },
    });
    expect(evaluateVote({ ...base, voter: bob })).toMatchObject({
      ok: true,
      value: { outcome: 'decided', sod_waiver: false },
    });
  });

  it('two approvers need two holders besides the proposer', () => {
    expect(planQuorum('M1', factory(2), [ann, bob], ann).ok).toBe(false);
    expect(planQuorum('M1', factory(2), [ann, bob, cyd], ann)).toMatchObject({
      ok: true,
      value: { required: 2, basis: 'two_person', waiver: false },
    });
  });

  it('only M1 follows it: another gate of the context keeps its own rule', () => {
    expect(planQuorum('M5', factory(2), [ann], ann)).toMatchObject({
      ok: true,
      value: { waiver: true },
    });
  });
});
