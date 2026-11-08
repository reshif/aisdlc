import { RoleSlotValues, type GateId, type RoleSlot } from '@aisdlc/contracts';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  openGate,
  prepare,
  recordEvidenceViewed,
  type DecisionDeps,
  type EligibilityPort,
} from '@aisdlc/decisions';
import { newId, sha256Hex } from '@aisdlc/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityEligibility, reconcileProject, setPrincipalStatus } from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

// Substitutability (PLAN M4.4): the decision kernel is run through the real identity-backed
// `EligibilityPort` and through `FakeEligibility` on the same scenarios, and everything it
// answers (open, quorum, every vote: accepted or refused, how, and whether `sod_waiver` is
// stamped) must be identical. The fake is what every M3 test used, so equal transcripts mean the
// M3 tests mean the same against the real thing.

let s: IdentityStack;
let fake: FakeEligibility;
let real: IdentityEligibility;
let stepUp: FakeStepUp;
const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin'];

beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, PEOPLE);
  fake = new FakeEligibility();
  real = new IdentityEligibility({ pool: s.record.pool, settings: s.settings, clock: s.clock });
  stepUp = new FakeStepUp();
});
afterAll(async () => {
  await s.stop();
});

const depsWith = (eligibility: EligibilityPort): DecisionDeps => ({
  pool: s.record.pool,
  ledger: s.ledger,
  eligibility,
  stepUp,
  clock: s.clock,
});

type Slots = Partial<Record<RoleSlot, string[]>>;
interface Scenario {
  name: string;
  tier: 'T0' | 'T1' | 'T2' | null;
  locked?: boolean;
  two_person?: boolean;
  slots: Slots;
}

const BASE: Slots = {
  admin: ['alice'],
  requesters: ['bob', 'carol'],
  intent: ['bob'],
  design: ['bob', 'carol'],
  g4: ['dave', 'erin'],
  g5: ['alice'],
  x: ['alice', 'bob'],
  sec: ['carol'],
  m4: ['alice', 'bob'],
  kill: ['alice'],
};

const SCENARIOS: Scenario[] = [
  { name: 'T1, two-person on', tier: 'T1', slots: BASE },
  { name: 'T1, two-person off', tier: 'T1', two_person: false, slots: BASE },
  { name: 'T2, locked on, two M4 holders', tier: 'T2', locked: true, slots: BASE },
  {
    name: 'T2, locked on, one M4 holder',
    tier: 'T2',
    locked: true,
    slots: { ...BASE, m4: ['alice'] },
  },
  { name: 'T1, one X holder', tier: 'T1', slots: { ...BASE, x: ['alice'] } },
  { name: 'T1, nobody holds sec', tier: 'T1', slots: { ...BASE, sec: [] } },
  { name: 'tier unknown', tier: null, slots: BASE },
];

let n = 0;
async function applyScenario(sc: Scenario): Promise<string> {
  const project = `conf-${++n}`;
  const id = pid(project);
  fake.setPolicy(id, {
    tier: sc.tier,
    two_person: { enabled: sc.two_person ?? true, locked_on: sc.locked ?? false },
  });
  for (const slot of RoleSlotValues) fake.setHolders(id, slot, (sc.slots[slot] ?? []).map(pr));
  s.settings.set(
    settingsOf(project, sc.slots, {
      two_person: sc.two_person ?? true,
      locked: sc.locked ?? false,
    }),
    sc.tier,
  );
  const r = await reconcileProject({ ...s.deps, settings: s.settings }, { project_id: id });
  if (!r.ok) throw new Error(r.error.message);
  return project;
}

const GATES: GateId[] = ['G0', 'G4', 'G5', 'G6', 'X1', 'M4', 'Q1', 'M1'];

/** Opens the gate and has each of `voters` approve in turn; returns a comparable transcript. */
async function transcript(
  eligibility: EligibilityPort,
  project: string,
  gate: GateId,
  requester: string | null,
  voters: string[],
): Promise<unknown[]> {
  const deps = depsWith(eligibility);
  const out: unknown[] = [];
  const subject = newId<'WorkItem'>();
  const hash = sha256Hex(`${project}/${gate}/${requester}`);
  const opened = await openGate(deps, {
    gate_id: gate,
    project_id: pid(project),
    subject_kind: 'item',
    subject_id: subject,
    subject_hash: hash,
    ...(requester ? { requester: pr(requester) } : {}),
  });
  if (!opened.ok) return [{ open: opened.error.code }];
  out.push({ open: 'ok', quorum: opened.value.required_quorum });
  for (const voter of voters) {
    const p = await prepare(deps, {
      gate_instance_id: opened.value.gate_instance_id,
      principal: pr(voter),
    });
    if (!p.ok) {
      out.push({ voter, prepare: p.error.code });
      continue;
    }
    await recordEvidenceViewed(deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    const v = await decide(deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      step_up: { proof: stepUp.issue(hash, voter) },
    });
    out.push(
      v.ok
        ? {
            voter,
            status: v.value.after.status,
            outcome: v.value.after.outcome,
            sod_waiver: v.value.entry.sod_waiver,
          }
        : { voter, decide: v.error.code },
    );
  }
  return out;
}

describe('IdentityEligibility is substitutable for FakeEligibility', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: every gate opens and decides the same`, async () => {
      const project = await applyScenario(sc);
      for (const gate of GATES) {
        for (const requester of [null, 'bob', 'alice']) {
          const voters = [...PEOPLE, 'mallory'];
          const a = await transcript(fake, project, gate, requester, voters);
          const b = await transcript(real, project, gate, requester, voters);
          expect(b, `${sc.name} ${gate} requester=${requester}`).toEqual(a);
        }
      }
    });
  }

  it('the table is not vacuous: it covers open refusals, waivers, two-person and refused votes', async () => {
    const kinds = new Set<string>();
    for (const sc of SCENARIOS) {
      const project = await applyScenario(sc);
      for (const gate of GATES) {
        const ts = [
          ...(await transcript(real, project, gate, 'bob', [...PEOPLE, 'mallory'])),
          ...(await transcript(real, project, gate, null, [...PEOPLE, 'mallory'])),
        ];
        for (const t of ts) {
          const o = t as Record<string, unknown>;
          if (typeof o['open'] === 'string' && o['open'] !== 'ok') kinds.add(`open:${o['open']}`);
          if (o['sod_waiver'] === true) kinds.add('waiver');
          if (o['sod_waiver'] === false && o['status'] === 'decided')
            kinds.add('decided-no-waiver');
          if (o['status'] === 'pending') kinds.add('pending-two-person');
          if (typeof o['prepare'] === 'string') kinds.add(`prepare:${o['prepare']}`);
          if (typeof o['decide'] === 'string') kinds.add(`decide:${o['decide']}`);
        }
      }
    }
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining([
        'open:quorum_infeasible',
        'waiver',
        'decided-no-waiver',
        'pending-two-person',
      ]),
    );
  });

  it('unknown project, unreadable settings, and a project never reconciled all fail closed, as the fake does', async () => {
    for (const project of ['never-heard-of-it']) {
      const a = await transcript(fake, project, 'G0', null, ['bob']);
      const b = await transcript(real, project, 'G0', null, ['bob']);
      expect(b).toEqual(a);
      expect(b).toEqual([{ open: 'eligibility_unavailable' }]);
    }
    const project = await applyScenario(SCENARIOS[0] as Scenario);
    fake.breakProject(pid(project));
    s.settings.breakProject(pid(project));
    const a = await transcript(fake, project, 'G0', null, ['bob']);
    const b = await transcript(real, project, 'G0', null, ['bob']);
    expect(b).toEqual(a);
    expect(b).toEqual([{ open: 'eligibility_unavailable' }]);
  });

  it('a holder removed from the role map after the gate opened is refused, as the fake does', async () => {
    const project = await applyScenario(SCENARIOS[0] as Scenario);
    const id = pid(project);
    const hash = sha256Hex('late');
    const open = async (e: EligibilityPort) => {
      const g = await openGate(depsWith(e), {
        gate_id: 'G0',
        project_id: id,
        subject_kind: 'item',
        subject_id: newId<'WorkItem'>(),
        subject_hash: hash,
      });
      if (!g.ok) throw new Error(g.error.message);
      return g.value.gate_instance_id;
    };
    const gf = await open(fake);
    const gr = await open(real);
    // bob loses the intent slot in both worlds.
    fake.setHolders(id, 'intent', [pr('carol')]);
    s.settings.set(settingsOf(project, { ...BASE, intent: ['carol'] }), 'T1');
    const rec = await reconcileProject({ ...s.deps, settings: s.settings }, { project_id: id });
    expect(rec.ok).toBe(true);
    const vote = async (e: EligibilityPort, gate: string) => {
      const p = await prepare(depsWith(e), { gate_instance_id: gate, principal: pr('bob') });
      return p.ok ? 'prepared' : p.error.code;
    };
    expect(await vote(real, gr)).toBe(await vote(fake, gf));
    expect(await vote(real, gr)).toBe('not_eligible');
  });

  it('a disabled principal is not a holder', async () => {
    const project = await applyScenario(SCENARIOS[0] as Scenario);
    const before = await real.holders(pid(project), 'design');
    expect(before.ok && before.value).toEqual(['bob', 'carol']);
    await setPrincipalStatus(s.deps, 'carol', 'disabled', 'left', 'system.test');
    const after = await real.holders(pid(project), 'design');
    expect(after.ok && after.value).toEqual(['bob']);
    await setPrincipalStatus(s.deps, 'carol', 'active', 'back', 'system.test');
  });

  it('policy: tier and two-person come from the settings; T2 or a locked setting cannot be off', async () => {
    const project = await applyScenario({ name: 'x', tier: 'T2', locked: true, slots: BASE });
    const p = await real.policy(pid(project));
    expect(p.ok && p.value).toEqual({
      tier: 'T2',
      two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
    });
    // A T2 project whose settings say two-person is off is read as locked on (the fake does the same).
    s.settings.set(settingsOf('t2-off', { admin: ['alice'] }, { two_person: false }), 'T2');
    const q = await real.policy(pid('t2-off'));
    expect(q.ok && q.value.two_person).toMatchObject({ enabled: true, locked_on: true });
    const r = await real.policy(pid('missing'));
    expect(r.ok).toBe(false);
  });
});
