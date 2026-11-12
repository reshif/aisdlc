import { gatePolicy, type GateId, type GateOpenedPayload } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { FakeEligibility, gateFeasibility } from '../src/index.js';
import { hash, pid, pr, uuid } from './helpers.js';

// GateFeasibility (M19): the vote's own rules against the people eligible now. Pure over FakeEligibility.

const P = pid('pay');

function opened(
  gate: GateId,
  o: { required?: number; requester?: string | null; deciders?: string[]; authors?: string[] } = {},
): GateOpenedPayload {
  return {
    gate_instance_id: uuid(),
    gate_id: gate,
    project_id: P,
    subject_kind: 'item',
    subject_id: uuid(),
    subject_hash: hash('s'),
    evidence_pack_hash: null,
    requester:
      o.requester === undefined ? pr('req') : o.requester === null ? null : pr(o.requester),
    ...(o.authors ? { authors: o.authors.map(pr) } : {}),
    ...(o.deciders ? { deciders: o.deciders.map(pr) } : {}),
    facts: { expires_at: '2027-01-01T00:00:00.000Z' },
    quorum: { required: o.required ?? 1, slot: gatePolicy(gate).slot, basis: 'single' },
    step_up: { required: false, bound_hash: hash('s') },
    supersedes: null,
    opened_by: 'system.work',
  } as unknown as GateOpenedPayload;
}

const elig = (slotHolders: string[], tier: 'T0' | 'T2' = 'T0') =>
  new FakeEligibility()
    .setHolders(P, gatePolicy('G1').slot, slotHolders.map(pr))
    .setHolders(P, gatePolicy('X1').slot, slotHolders.map(pr))
    .setPolicy(P, { tier });

describe('gateFeasibility', () => {
  it('is feasible when an eligible holder other than the requester remains', async () => {
    const f = await gateFeasibility(elig(['ann', 'req']), opened('G1'), []);
    expect(f).toMatchObject({ state: 'feasible', needed: 1, eligible: 1, reason: null });
  });

  it('is infeasible when nobody holds the slot (no eligible decider)', async () => {
    const f = await gateFeasibility(elig([]), opened('G1'), []);
    expect(f.state).toBe('infeasible');
    expect(f.eligible).toBe(0);
    expect(f.reason).toMatch(/nobody holds the slot/);
  });

  it('is infeasible when the gate deciders narrow the slot to nobody who holds it', async () => {
    const f = await gateFeasibility(elig(['ann']), opened('G1', { deciders: ['zed'] }), []);
    expect(f.state).toBe('infeasible');
  });

  it('a two-person gate on T2 with one approver besides the requester is infeasible (quorum)', async () => {
    const f = await gateFeasibility(elig(['ann', 'req'], 'T2'), opened('X1', { required: 2 }), []);
    expect(f.state).toBe('infeasible');
    expect(f.reason).toMatch(/T2 needs two approvers/);
  });

  it('counts the approvals already on the ledger, and the people who cast them are not eligible again', async () => {
    const e = elig(['ann', 'bob', 'req']);
    expect((await gateFeasibility(e, opened('X1', { required: 2 }), [pr('ann')])).state).toBe(
      'feasible',
    );
    // the role map changed after ann voted: bob left the slot, only ann (already voted) and the requester remain
    const after = elig(['ann', 'req', 'cy']);
    after.setHolders(P, gatePolicy('X1').slot, [pr('ann'), pr('req')]);
    const f = await gateFeasibility(after, opened('X1', { required: 2 }), [pr('ann')]);
    expect(f).toMatchObject({ state: 'infeasible', needed: 1, eligible: 0 });
  });

  it('the sole holder who is the requester decides by the waiver: feasible', async () => {
    const f = await gateFeasibility(elig(['req']), opened('G1'), []);
    expect(f.state).toBe('feasible');
  });

  it('an identity outage is unknown, never feasible (fail closed)', async () => {
    const e = elig(['ann']).breakProject(P);
    const f = await gateFeasibility(e, opened('G1'), []);
    expect(f.state).toBe('unknown');
    expect(f.eligible).toBeNull();
  });
});
