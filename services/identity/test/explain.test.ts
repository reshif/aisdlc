import { GateIdValues, ROLE_CATALOGUE, roleForSlot, type RoleDef } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createBinding,
  createGroup,
  explainGate,
  explainProject,
  grantQualification,
  identityProjection,
  queryGrants,
  reconcileProject,
  setPrincipalStatus,
  type GateExplanation,
} from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

let s: IdentityStack;
const A = 'system.test';
beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol', 'dave']);
});
afterAll(async () => {
  await s.stop();
});

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function setup(
  project: string,
  slots: Parameters<typeof settingsOf>[1],
  over: Parameters<typeof settingsOf>[2] = {},
  tier: 'T0' | 'T1' | 'T2' = 'T1',
) {
  s.settings.set(settingsOf(project, slots, over), tier);
  must(await reconcileProject({ ...s.deps, settings: s.settings }, { project_id: pid(project) }));
}
const rd = () => ({ pool: s.record.pool, settings: s.settings, clock: s.clock });
const explain = async (
  project: string,
  gate: (typeof GateIdValues)[number],
): Promise<GateExplanation> => must(await explainGate(rd(), pid(project), gate));

describe('explain(project, gate)', () => {
  it('lists who can decide a gate and why: slot, role, binding, group, source', async () => {
    await setup('p1', {
      admin: ['alice'],
      intent: ['bob', 'carol'],
      x: ['alice', 'bob'],
      m4: ['alice'],
    });
    const e = await explain('p1', 'G1');
    expect(e).toMatchObject({
      project_id: 'p1',
      gate_id: 'G1',
      slot: 'intent',
      role_id: 'project.intent_approver',
      step_up: false,
    });
    expect(e.deciders.map((d) => d.principal_id)).toEqual(['bob', 'carol']);
    const path = e.deciders[0]?.paths[0];
    expect(path).toMatchObject({
      slot: 'intent',
      role_id: roleForSlot('intent'),
      scope: { kind: 'project', ref: 'p1' },
      group_id: 'rm.p1.intent',
      membership_source: 'role_map',
      generated: true,
    });
    expect(path?.binding_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.deciders[0]?.display_handle).toBe('bob');
    expect(e.blocked).toEqual([]);
  });

  it('two-person: covered gates need two approvers when the setting is on, and say so', async () => {
    const x = await explain('p1', 'X1');
    expect(x.policy).toMatchObject({
      gate_is_two_person: true,
      two_person_in_force: true,
      t2: false,
    });
    expect(x.quorum).toEqual({
      feasible: true,
      required: 2,
      basis: 'two_person',
      sod_waiver: false,
    });
    const g = await explain('p1', 'G0');
    expect(g.policy).toMatchObject({ gate_is_two_person: false, two_person_in_force: false });
    expect(g.quorum).toMatchObject({ feasible: true, required: 1, basis: 'single' });
  });

  it('sod_waiver applies for a single holder and when two-person is off, never for T2', async () => {
    const single = await explain('p1', 'M4'); // one M4 holder
    expect(single.quorum).toEqual({
      feasible: true,
      required: 1,
      basis: 'single_holder',
      sod_waiver: true,
    });
    await setup('p-off', { admin: ['alice'], x: ['alice', 'bob'] }, { two_person: false });
    const off = await explain('p-off', 'X1');
    expect(off.policy).toMatchObject({ two_person_enabled: false, two_person_in_force: false });
    expect(off.quorum).toEqual({
      feasible: true,
      required: 1,
      basis: 'two_person_off',
      sod_waiver: true,
    });
    await setup(
      'p-t2',
      { admin: ['alice'], x: ['alice'], m4: ['alice', 'bob'] },
      { locked: true },
      'T2',
    );
    const t2x = await explain('p-t2', 'X1');
    expect(t2x.policy.t2).toBe(true);
    expect(t2x.quorum).toMatchObject({ feasible: false, code: 'quorum_infeasible' });
    const t2m4 = await explain('p-t2', 'M4');
    expect(t2m4.quorum).toEqual({
      feasible: true,
      required: 2,
      basis: 'two_person',
      sod_waiver: false,
    });
    expect(t2m4.step_up).toBe(true);
  });

  it('own-request rule per decider: blocked, sod_waiver for a sole holder, allowed for G6', async () => {
    const intent = await explain('p1', 'G0'); // bob and carol
    expect(intent.deciders.map((d) => d.own_request)).toEqual(['blocked', 'blocked']);
    await setup('p-solo', { admin: ['alice'], intent: ['bob'], requesters: ['carol'] });
    const solo = await explain('p-solo', 'G0');
    expect(solo.deciders).toHaveLength(1);
    expect(solo.deciders[0]?.own_request).toBe('sod_waiver');
    const g6 = await explain('p-solo', 'G6');
    expect(g6.policy.own_request_rule).toBe('allowed');
    expect(g6.deciders[0]?.own_request).toBe('allowed');
    await setup('p-solo-t2', { admin: ['alice'], intent: ['bob'] }, { locked: true }, 'T2');
    expect((await explain('p-solo-t2', 'G0')).deciders[0]?.own_request).toBe('blocked');
  });

  it('an empty slot, and the codeowners slot, decide nothing (fail closed)', async () => {
    const sec = await explain('p1', 'Q1');
    expect(sec.deciders).toEqual([]);
    expect(sec.quorum).toMatchObject({ feasible: false, code: 'quorum_infeasible' });
    const g4 = await explain('p1', 'G4');
    expect(g4.deciders).toEqual([]);
    expect(g4.quorum.feasible).toBe(false);
  });

  it('members who cannot decide now are listed with the reason', async () => {
    await setup('p-block', { admin: ['alice'], design: ['bob', 'carol', 'dave'] });
    await setPrincipalStatus(s.deps, 'carol', 'disabled', 'left', A);
    const e = await explain('p-block', 'G3');
    expect(e.deciders.map((d) => d.principal_id)).toEqual(['bob', 'dave']);
    expect(e.blocked).toEqual([
      expect.objectContaining({ principal_id: 'carol', blockers: ['principal_disabled'] }),
    ]);
    await setPrincipalStatus(s.deps, 'carol', 'active', 'back', A);
  });

  it('an expired membership blocks, by the clock', async () => {
    await createGroup(
      s.deps,
      { group_id: 'temp', display: 'Temp', pim_managed: false, protected: false },
      A,
    );
    await createBinding(
      s.deps,
      { group_id: 'temp', role_id: 'project.viewer', scope: { kind: 'project', ref: 'p1' } },
      A,
    );
    const until = new Date(s.clock.nowMs() + 60_000).toISOString();
    must(
      await addMember(s.deps, { group_id: 'temp', principal_id: 'dave', active_until: until }, A),
    );
    const grants = async () => {
      await runProjection(s.record.pool, identityProjection);
      return queryGrants(
        s.record.pool,
        { principal: 'dave', role: 'project.viewer' },
        { kind: 'project', ref: 'p1' },
        s.clock.now(),
      );
    };
    expect((await grants())[0]?.blockers).toEqual([]);
    s.clock.advance(61_000);
    expect((await grants())[0]?.blockers).toEqual(['membership_expired']);
  });

  it('a role that requires a qualification blocks until it is valid', async () => {
    const catalogue: RoleDef[] = ROLE_CATALOGUE.map((r) =>
      r.slot === 'g5' ? { ...r, requires_qualification: 'release-training' } : r,
    );
    await setup('p-qual', { admin: ['alice'], g5: ['bob'] });
    const withCat = { ...rd(), catalogue };
    const before = must(await explainGate(withCat, pid('p-qual'), 'G5'));
    expect(before.deciders).toEqual([]);
    expect(before.blocked[0]).toMatchObject({
      principal_id: 'bob',
      blockers: ['qualification_missing:release-training'],
    });
    must(
      await grantQualification(
        s.deps,
        {
          principal_id: pr('bob'),
          qual_type: 'release-training',
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: null,
          source: 'lms_import',
          evidence_ref: null,
        },
        A,
      ),
    );
    const after = must(await explainGate(withCat, pid('p-qual'), 'G5'));
    expect(after.deciders.map((d) => d.principal_id)).toEqual(['bob']);
    // The default catalogue has no such requirement.
    expect(must(await explainGate(rd(), pid('p-qual'), 'G5')).deciders).toHaveLength(1);
  });

  it("explainProject covers every gate; each decider is a holder of that gate's slot", async () => {
    const all = must(await explainProject(rd(), pid('p1')));
    expect(all.map((g) => g.gate_id)).toEqual([...GateIdValues]);
    for (const g of all) expect(g.role_id).toBe(roleForSlot(g.slot as never));
  });

  it('settings unreadable: explain refuses rather than guess', async () => {
    const r = await explainGate(rd(), pid('no-such-project'), 'G0');
    expect(!r.ok && r.error.code).toBe('unavailable');
  });
});
