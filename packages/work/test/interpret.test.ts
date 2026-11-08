import { CATALOGUE } from '@aisdlc/catalogue';
import {
  ITEM_EVENT,
  LaneValues,
  WORK_ITEM_TRANSITIONS,
  type ItemCommand,
  type RecordEvent,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  ProfilePinMismatch,
  foldItem,
  interpret,
  workInFlight,
  type CatalogueResolver,
} from '../src/index.js';
import { PROFILE_ALL_OFF, PROFILE_ALL_ON, Sim, createdPayload, ev, uuid } from './sim.js';

/** The record events a Sim produced, as the record would hold them. */
function recordOf(sim: Sim, createdOpts: Parameters<typeof createdPayload>[1] = {}): RecordEvent[] {
  const all = [
    { type: ITEM_EVENT.created, payload: createdPayload(sim.name, createdOpts), seq: 1 },
    ...sim.steps.map((s) => ({
      type: s.event.type as string,
      payload: s.event.payload,
      seq: s.event.seq,
    })),
  ];
  return all.map(
    (e) =>
      ({
        event_id: uuid(`e:${sim.name}:${e.seq}`),
        stream_id: `item:${sim.state.item_id}`,
        stream_seq: e.seq,
        global_seq: e.seq,
        type: e.type,
        payload: e.payload,
        actor: 'test',
        idempotency_key: null,
        occurred_at: new Date(Date.UTC(2026, 10, 9, 8, 0, e.seq)).toISOString(),
        prev_hash: '0'.repeat(64),
        hash: '0'.repeat(64),
      }) as unknown as RecordEvent,
  );
}

const legal = (phases: string[]): void => {
  for (let i = 1; i < phases.length; i++) {
    const a = phases[i - 1] as keyof typeof WORK_ITEM_TRANSITIONS;
    const b = phases[i] as never;
    expect(WORK_ITEM_TRANSITIONS[a], `${a} -> ${b}`).toContain(b);
  }
};

describe('every lane runs to a terminal state through the fake stages', () => {
  for (const lane of LaneValues) {
    for (const [pname, profile] of [
      ['all gates on', PROFILE_ALL_ON],
      ['all gates off', PROFILE_ALL_OFF],
    ] as const) {
      it(`${lane}, ${pname}`, () => {
        const sim = new Sim(`lane-${lane}-${pname}`, { lane, profile });
        sim.submit();
        sim.run();
        expect(sim.state.terminal, `waiting: ${JSON.stringify(sim.state.waiting)}`).toBe('Done');
        legal(sim.phases);
        expect(sim.state.lane).toBe(lane);
        expect(sim.state.outstanding).toEqual([]);
      });
    }
  }
});

describe('gates come from the catalogue intersected with the pinned profile', () => {
  const opened = (sim: Sim) => sim.gateLog.flatMap((g) => g.gates);

  it('an off gate is absent: never opened, never decided, and the item still completes', () => {
    const on = new Sim('gates-on', { lane: 'L4', profile: PROFILE_ALL_ON }).run_();
    const off = new Sim('gates-off', { lane: 'L4', profile: PROFILE_ALL_OFF }).run_();
    expect(opened(on)).toEqual(['G0', 'G1', 'G2', 'G3d', 'G3', 'G3s', 'G4', 'G5', 'G6']);
    expect(opened(off)).toEqual(['G4']);
    expect(off.state.terminal).toBe('Done');
    // Nothing decided a gate that was never there.
    const decided = off.steps.filter((s) => s.event.type === ITEM_EVENT.gate_decided);
    expect(decided.map((d) => (d.event.payload as { gate: string }).gate)).toEqual(['G4']);
  });

  it('G4 is opened in every lane but the spike, whatever the profile', () => {
    for (const lane of LaneValues) {
      const sim = new Sim(`g4-${lane}`, { lane, profile: PROFILE_ALL_OFF }).run_();
      expect(opened(sim).includes('G4'), lane).toBe(lane !== 'L7');
      expect(CATALOGUE.lanes[lane].profile.mandatory_gates.includes('G4')).toBe(lane !== 'L7');
    }
  });

  it('human gates of a lane stay absent with the profile off, and G0 binds the lane when it is on', () => {
    const on = new Sim('bind-on', { lane: 'L3' });
    on.submit();
    on.run({ decide: () => 'pending' });
    expect(on.state.lane).toBeNull(); // not bound until G0 decides
    expect(on.state.waiting).toMatchObject({ kind: 'gates', gates: ['G0', 'G1'] });
    on.run();
    expect(on.state.terminal).toBe('Done');

    const off = new Sim('bind-off', { lane: 'L3', profile: PROFILE_ALL_OFF });
    off.submit();
    off.run({ stopAtHuman: ['ready'] });
    expect(off.state.lane).toBeNull();
    off.run();
    expect(off.state.lane).toBe('L3');
    expect(off.state.lane_bound_by).toBe('ready_decision');
  });

  it('the G0 card carries the lane profile and the B27 flag, and the text only as a hash', () => {
    const sim = new Sim('card', { lane: 'L4', injection: true });
    sim.submit();
    sim.run({ decide: () => 'pending' });
    const open =
      sim.state.outstanding.find((c) => c.type === 'open_gates') ??
      sim.executed.find((c) => c.type === 'open_gates');
    expect(open?.type).toBe('open_gates');
    const facts = (open as Extract<ItemCommand, { type: 'open_gates' }>).facts as Record<
      string,
      unknown
    >;
    expect(facts['injection']).toMatchObject({ suspected: true, rules: ['L-DIRECTIVE'] });
    expect(facts['request_taint']).toBe('untrusted');
    expect(facts['lane_profile']).toMatchObject({ lane: 'L4' });
    expect(JSON.stringify(facts)).not.toMatch(/ignore previous/i);
  });

  it('an item keeps the profile it started with: a different profile is refused, never obeyed', () => {
    const sim = new Sim('pin', { lane: 'L4', profile: PROFILE_ALL_ON });
    sim.submit();
    expect(() =>
      interpret(
        sim.state,
        ev(ITEM_EVENT.ready_decided, { by: 'alice' }, 99),
        CATALOGUE,
        PROFILE_ALL_OFF,
      ),
    ).toThrow(ProfilePinMismatch);
    // A new item under another profile has its own route; the first is unaffected.
    const other = new Sim('pin-other', { lane: 'L4', profile: PROFILE_ALL_OFF }).run_();
    expect(other.gateLog.flatMap((g) => g.gates)).toEqual(['G4']);
    sim.run();
    expect(sim.gateLog.flatMap((g) => g.gates)).toContain('G2');
  });

  it('the item interprets under the catalogue it was handed, not a later one', () => {
    // A second catalogue whose L4 lane has no S4: an item folded with it follows that route, which is
    // what pinning means (the resolver picks by the item's `catalogue_ref`).
    const v2 = structuredClone(CATALOGUE);
    v2.lanes.L4 = {
      ...v2.lanes.L4,
      stages: v2.lanes.L4.stages.map((s) =>
        s.stage === 'S4' ? { ...s, mode: 'skipped', steps: [] } : s,
      ),
      gates: v2.lanes.L4.gates.filter((g) => g.gate !== 'G3d' && g.gate !== 'E2'),
    };
    const a = new Sim('cat-v1', { lane: 'L4' }, CATALOGUE).run_();
    const b = new Sim('cat-v2', { lane: 'L4' }, v2).run_();
    expect(a.stepsOnly()).toContain('4.1');
    expect(b.stepsOnly()).not.toContain('4.1');
    // The resolver is how core keeps in-flight items on their pin; a build without it fails closed.
    const none: CatalogueResolver = () => null;
    expect(() => foldItem(recordOf(a), none)).toThrow(/catalogue/i);
  });
});

describe('replay determinism', () => {
  it('the same events give the same state and the same commands, with the same keys', () => {
    const sim = new Sim('replay', { lane: 'L6' }).run_();
    const events = recordOf(sim, { lane: 'L6' });
    const a = foldItem(events);
    const b = foldItem(events);
    expect(a).toEqual(b);
    expect(a?.state).toEqual(sim.state);
    expect(a?.issued.flatMap((i) => i.commands)).toEqual(sim.steps.flatMap((s) => s.commands));
    // Any prefix replays to the state the live run had at that point.
    for (const k of [3, 11, 25]) {
      const part = foldItem(events.slice(0, k));
      expect(part?.state).toEqual(sim.steps[k - 2]?.state);
    }
  });

  it('keys are unique per command and identical on a second run of the same item', () => {
    const one = new Sim('keys', { lane: 'L5' }).run_();
    const two = new Sim('keys', { lane: 'L5' }).run_();
    const keys = one.executed.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(two.executed.map((c) => c.key)).toEqual(keys);
  });

  it('outstanding commands are derived from the events alone', () => {
    const sim = new Sim('derive', { lane: 'L4' });
    sim.submit();
    sim.run({ decide: () => 'pending' });
    const refolded = foldItem(recordOf(sim, { lane: 'L4' }));
    expect(refolded?.state.outstanding).toEqual(sim.state.outstanding);
  });
});

describe('conditional gates raised by a stage', () => {
  const raising = (step: string, gate: string) => ({
    script: (s: string, attempt: number) =>
      s === step && attempt === 1
        ? ({ outcome: 'gate_needed', gate, reason_code: 'test' } as never)
        : undefined,
  });

  for (const [step, gate] of [
    ['6.4', 'X3'],
    ['6.4', 'X1'],
    ['6.3', 'G3o'],
    ['7.4', 'X2'],
    ['4.5', 'E2'],
    ['7.5', 'E2'],
  ] as const) {
    it(`${gate} at ${step}: the gate is opened, and its approval takes the item on`, () => {
      const sim = new Sim(`cond-${step}-${gate}`, { lane: 'L4' });
      sim.submit();
      sim.run(raising(step, gate));
      expect(sim.state.terminal).toBe('Done');
      expect(sim.gateLog.some((g) => g.gates.includes(gate))).toBe(true);
      const reruns = sim.executed.filter((c) => c.type === 'run_stage' && c.step === step);
      if (gate === 'X1' || gate === 'X3') {
        // approved: the step runs again, and the port is told which gate was approved
        expect(reruns).toHaveLength(2);
        expect((reruns[1] as Extract<ItemCommand, { type: 'run_stage' }>).approved_gates).toEqual([
          gate,
        ]);
      } else expect(reruns).toHaveLength(1);
    });
  }

  it('a stage cannot raise a gate at a step it does not belong to', () => {
    const sim = new Sim('cond-bad', { lane: 'L4' });
    sim.submit();
    sim.run(raising('3.2', 'X1'));
    expect(sim.state.waiting).toMatchObject({ kind: 'stuck', reason: 'gate_not_raisable:X1@3.2' });
  });
});

describe('gate outcomes', () => {
  it('G0 rejected is B22: Declined, with the cause code, and the open G1 instance is withdrawn', () => {
    const sim = new Sim('g0-reject', { lane: 'L4' });
    sim.submit();
    sim.run({ decide: (g) => (g === 'G0' ? 'reject' : 'pending') });
    expect(sim.state.terminal).toBe('Declined');
    expect(sim.state.terminal_cause).toBe('b22.g0_rejected');
    const w = sim.steps.flatMap((s) => s.commands).find((c) => c.type === 'withdraw_gates');
    expect(w).toBeDefined();
    sim.run();
    expect(sim.state.outstanding).toEqual([]);
    legal(sim.phases);
  });

  it('a rejection whose edge is not built yet stops the item where it is (fail closed)', () => {
    const sim = new Sim('g2-reject', { lane: 'L4' });
    sim.submit();
    sim.run({ decide: (g) => (g === 'G2' ? 'reject' : 'approve') });
    expect(sim.state.terminal).toBeNull();
    expect(sim.state.waiting).toMatchObject({ kind: 'stuck', reason: 'G2:reject', gate: 'G2' });
    // and nothing advances it: not another run, not a second decision
    const before = sim.state.cursor;
    sim.run();
    expect(sim.state.cursor).toBe(before);
  });

  it('expiry never approves: the gate is opened again', () => {
    const sim = new Sim('expiry', { lane: 'L4' });
    sim.submit();
    let first = true;
    sim.run({
      decide: (g) => {
        if (g === 'G2' && first) {
          first = false;
          return 'expired';
        }
        return 'approve';
      },
    });
    expect(sim.state.terminal).toBe('Done');
    expect(sim.gateLog.filter((g) => g.gates.includes('G2'))).toHaveLength(2);
  });
});

describe('questions (B1)', () => {
  const asks = (rounds: number) => ({
    script: (s: string, attempt: number) =>
      s === '1.5' && attempt <= rounds
        ? ({
            outcome: 'questions',
            questions: [{ text: 'which table?', material: 'blocking' }],
          } as never)
        : undefined,
  });
  const answer = (sim: Sim) => {
    for (const q of sim.state.questions.filter((x) => x.state === 'open')) {
      sim.apply(ITEM_EVENT.question_answered, {
        question_id: q.question_id,
        answer: {
          text: 'the orders table',
          taint: 'untrusted',
          origin: 'answer',
          provenance: {
            channel: 'N1',
            source: 'portal_ask',
            received_at: '2026-11-09T08:00:00.000Z',
            submitted_by: 'alice',
            raw_sha256: 'a'.repeat(64),
            normalised_sha256: 'b'.repeat(64),
          },
          flags: [],
        },
        by: 'alice',
      });
    }
  };

  it('a blocking question puts the item in Clarifying; the answer takes it back to S1 and 1.5 runs again', () => {
    const sim = new Sim('clarify', { lane: 'L4' });
    sim.submit();
    sim.run(asks(1));
    expect(sim.state.phase).toBe('Clarifying');
    expect(sim.state.waiting).toMatchObject({ kind: 'questions' });
    expect(sim.state.questions[0]).toMatchObject({
      round: 1,
      state: 'open',
      step: '1.5',
      stage: 'S1',
    });
    answer(sim);
    expect(sim.state.phase).toBe('S1');
    sim.run(asks(1));
    expect(sim.state.terminal).toBe('Done');
    expect(sim.state.questions[0]?.answer?.taint).toBe('untrusted');
    legal(sim.phases);
    expect(sim.executed.filter((c) => c.type === 'run_stage' && c.step === '1.5')).toHaveLength(2);
  });

  it('a third round is past the B1 limit: the item is PARKED (its exits are M9.3)', () => {
    const sim = new Sim('clarify-3', { lane: 'L4' });
    sim.submit();
    for (let i = 0; i < 2; i++) {
      sim.run(asks(9));
      answer(sim);
    }
    sim.run(asks(9));
    expect(sim.state.phase).toBe('Parked');
    expect(sim.state.waiting).toMatchObject({ kind: 'parked', cause: 'b1_round_limit' });
    legal(sim.phases);
  });

  it('a non-blocking question does not stop the item', () => {
    const sim = new Sim('clarify-nb', { lane: 'L4' });
    sim.submit();
    sim.run({
      script: (s, a) =>
        s === '1.5' && a === 1
          ? ({
              outcome: 'questions',
              questions: [{ text: 'colour?', material: 'non_blocking' }],
            } as never)
          : undefined,
    });
    expect(sim.state.terminal).toBe('Done');
    expect(sim.state.questions[0]?.state).toBe('open');
  });
});

describe('holds are overlays with prior-phase resume', () => {
  it('a hold keeps the stage, keeps results coming in, holds back new commands, and resumes', () => {
    const sim = new Sim('hold', { lane: 'L3' });
    sim.submit();
    const out = sim.state.outstanding[0] as Extract<ItemCommand, { type: 'run_stage' }>;
    expect(out.step).toBe('1.3');
    sim.apply(ITEM_EVENT.hold_placed, { hold_id: 'h1', reason: 'kill', origin: 'ctl-1' });
    expect(sim.state.phase).toBe('Held');
    expect(sim.state.underlying).toBe('S1');
    // the result of a command that was already out is still folded...
    const r = sim.apply(ITEM_EVENT.stage_completed, {
      command_key: out.key,
      step: '1.3',
      output_hash: 'c'.repeat(64),
      lane: 'L3',
    });
    // ...but the next command is held back, not issued: the cursor moved, nothing is waiting
    expect(r.commands).toEqual([]);
    expect(sim.state.waiting).toBeNull();
    expect(sim.state.outstanding).toEqual([]);
    expect(sim.state.underlying).toBe('S1');
    const rel = sim.apply(ITEM_EVENT.hold_released, { hold_id: 'h1' });
    expect(sim.state.phase).toBe('S1');
    expect(sim.state.holds).toEqual([]);
    expect(rel.commands).toHaveLength(1);
    expect(rel.commands[0]).toMatchObject({ type: 'check_eligibility' });
    expect(sim.state.outstanding).toEqual(rel.commands);
    sim.run();
    expect(sim.state.terminal).toBe('Done');
    legal(sim.phases);
  });

  it('two holds: the item resumes only when the last goes', () => {
    const sim = new Sim('hold2', { lane: 'L4' });
    sim.submit();
    sim.apply(ITEM_EVENT.hold_placed, { hold_id: 'a', reason: 'H1', origin: null });
    sim.apply(ITEM_EVENT.hold_placed, { hold_id: 'b', reason: 'maintenance', origin: 'mm-2' });
    expect(sim.state.phase).toBe('Held');
    sim.apply(ITEM_EVENT.hold_released, { hold_id: 'a' });
    expect(sim.state.phase).toBe('Held');
    sim.apply(ITEM_EVENT.hold_released, { hold_id: 'b' });
    expect(sim.state.phase).toBe('S1');
  });

  it('N8: the eligibility check holds the item where it is, and the release runs 1.4 again', () => {
    const sim = new Sim('n8', { lane: 'L4' });
    sim.submit();
    sim.run({ eligibility: 'n8_hold' });
    expect(sim.state.phase).toBe('Held');
    expect(sim.state.holds[0]).toMatchObject({ reason: 'N8' });
    const rel = sim.apply(ITEM_EVENT.hold_released, { hold_id: sim.state.holds[0]?.hold_id });
    expect(rel.commands[0]).toMatchObject({ type: 'check_eligibility' });
    expect(rel.commands[0]?.key).toMatch(/\/2$/);
    sim.run();
    expect(sim.state.terminal).toBe('Done');
  });

  it('1.4 routing to L8 changes the proposed lane before G0 binds anything', () => {
    const sim = new Sim('l8-route', { lane: 'L4' });
    sim.submit();
    sim.run({ eligibility: 'l8', stopAtHuman: ['human_led'] });
    expect(sim.state.proposed_lane).toBe('L8');
    expect(sim.state.lane).toBe('L8');
    expect(sim.state.waiting).toEqual({ kind: 'human', what: 'human_led' });
    sim.run();
    expect(sim.state.terminal).toBe('Done');
  });

  it('abandon needs a hold first (the phase table has no stage -> Abandoned edge)', () => {
    const sim = new Sim('abandon', { lane: 'L4' });
    sim.submit();
    sim.apply(ITEM_EVENT.abandoned, { cause: 'owner_abandoned', by: 'alice' });
    expect(sim.state.terminal).toBeNull();
    expect(sim.state.ignored.at(-1)).toMatch(/abandoned:from_S1/);
    sim.run({ decide: () => 'pending' });
    sim.apply(ITEM_EVENT.hold_placed, { hold_id: 'h', reason: 'kill', origin: null });
    const r = sim.apply(ITEM_EVENT.abandoned, { cause: 'owner_abandoned', by: 'alice' });
    expect(sim.state.terminal).toBe('Abandoned');
    expect(sim.state.terminal_cause).toBe('owner_abandoned');
    expect(r.commands[0]).toMatchObject({ type: 'withdraw_gates' });
  });

  it('a finished item takes nothing more', () => {
    const sim = new Sim('finished', { lane: 'L4' }).run_();
    const before = JSON.stringify(sim.state.phase);
    sim.apply(ITEM_EVENT.hold_placed, { hold_id: 'x', reason: 'kill', origin: null });
    expect(JSON.stringify(sim.state.phase)).toBe(before);
    expect(sim.state.holds).toEqual([]);
  });

  it('withdrawn is Draft only', () => {
    const sim = new Sim('withdraw', { lane: 'L4' });
    sim.apply(ITEM_EVENT.withdrawn, { by: 'alice' });
    expect(sim.state.terminal).toBe('Withdrawn');
    const other = new Sim('withdraw-2', { lane: 'L4' });
    other.submit();
    other.apply(ITEM_EVENT.withdrawn, { by: 'alice' });
    expect(other.state.terminal).toBeNull();
  });
});

describe('spawn links and work in flight', () => {
  it('a spawn request becomes one command with a stable key, and its result a SpawnLink', () => {
    const sim = new Sim('spawn', { lane: 'L4' });
    sim.submit();
    const s = sim.apply(ITEM_EVENT.spawn_requested, {
      edge: 'B18',
      kind: 'rejected_rework',
      lane: 'L1',
      index: 0,
    });
    expect(s.commands).toHaveLength(1);
    expect(s.commands[0]).toMatchObject({
      type: 'spawn_item',
      edge: 'B18',
      origin_seq: s.event.seq,
    });
    const again = new Sim('spawn', { lane: 'L4' });
    again.submit();
    expect(
      again.apply(ITEM_EVENT.spawn_requested, {
        edge: 'B18',
        kind: 'rejected_rework',
        lane: 'L1',
        index: 0,
      }).commands[0]?.key,
    ).toBe(s.commands[0]?.key);
    sim.run();
    expect(sim.state.spawns[0]).toMatchObject({
      edge: 'B18',
      origin_item_id: sim.state.item_id,
      status: 'open',
    });
  });

  it('agent work is in flight from admission (a lease) to the end of S6, and while a verify command is out', () => {
    const sim = new Sim('flight', { lane: 'L4', profile: PROFILE_ALL_OFF });
    sim.submit();
    const seen: boolean[] = [];
    for (let i = 0; i < 200 && sim.state.terminal === null; i++) {
      seen.push(workInFlight(sim.state));
      const next = sim.state.outstanding.find((c) => !sim.executed.some((e) => e.key === c.key));
      if (next) sim.answer(next, {});
      else if (!sim.human({})) break;
    }
    expect(seen.some(Boolean)).toBe(true);
    expect(workInFlight(sim.state)).toBe(false);
    expect(sim.state.lease).toBeNull();
  });
});

declare module './sim.js' {
  interface Sim {
    run_(): Sim;
  }
}
