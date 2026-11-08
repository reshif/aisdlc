import { CATALOGUE } from '@aisdlc/catalogue';
import { AbandonCause, ITEM_EVENT, ItemEventPayloads } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { limitValue, parkBusinessDays } from '../src/index.js';
import { forStep, newSim, repeat } from './scen.js';
import type { Sim } from './sim.js';

// M9.3: the holds (H1-H3, WIP, N8) and the terminals and waits (PARK, BLOCKED, DECLINED, ABANDONED,
// RELHOLD), the resume to the prior phase, and the frozen clock MM-2 leaves behind.

const phases = (s: Sim) => s.phases.join('>');
const asks = {
  outcome: 'questions',
  questions: [{ text: 'which table?', material: 'blocking' }],
} as never;

const answer = (s: Sim) => {
  for (const q of s.state.questions.filter((x) => x.state === 'open')) {
    s.apply(ITEM_EVENT.question_answered, {
      question_id: q.question_id,
      answer: {
        text: 'orders',
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

/** An item parked by B1's round limit: it asked in every round. */
function parked(name: string): Sim {
  const s = newSim(name, { lane: 'L4' });
  const rounds = limitValue(CATALOGUE, 'B1', 'rounds') as number;
  for (let i = 0; i <= rounds; i++) {
    s.run({ script: repeat('1.5', asks) });
    if (s.state.phase === 'Parked') break;
    answer(s);
  }
  expect(s.state.phase).toBe('Parked');
  return s;
}

describe('PARK (B1: at most the catalogue rounds of questions, then parked for the catalogue business days)', () => {
  it('parks with the questions it could not get answered, and says why', () => {
    const s = parked('park');
    expect(s.state.rounds).toBe((limitValue(CATALOGUE, 'B1', 'rounds') as number) + 1);
    const ids = s.state.questions
      .filter((q) => q.round === s.state.rounds)
      .map((q) => q.question_id);
    expect(s.state.waiting).toEqual({ kind: 'parked', cause: 'b1_round_limit', ids });
    expect(s.state.park).toMatchObject({ since: expect.any(String) });
    expect(s.state.terminal).toBeNull();
    expect(parkBusinessDays(CATALOGUE)).toBe(5);
  });

  it('answers arriving take it back to S1 and 1.5 runs again', () => {
    const s = parked('park-answered');
    answer(s);
    expect(s.state.phase).toBe('S1');
    expect(s.state.park).toBeNull();
    expect(phases(s)).toContain('Parked>S1');
    s.run();
    expect(s.state.terminal).toBe('Done');
  });

  it('the timeout abandons it with the cause code, only on the timer of its own park', () => {
    const s = parked('park-timeout');
    const since = (s.state.park as { since: string }).since;
    const fire = (o: object) =>
      s.apply(ITEM_EVENT.timer_fired, { timer: 'park', since, due_at: since, frozen_ms: 0, ...o });
    // another park's start, a deadline still ahead, and frozen time that is not the item's: all ignored
    fire({ since: '2020-01-01T00:00:00.000Z' });
    fire({ due_at: '2099-01-01T00:00:00.000Z' });
    fire({ frozen_ms: 7 });
    expect(s.state.terminal).toBeNull();
    fire({});
    expect(s.state).toMatchObject({ terminal: 'Abandoned', terminal_cause: 'park.timeout' });
    expect(phases(s)).toContain('Parked>Abandoned');
  });

  it('a requester who is silent while clarifying parks the item (Clarifying -> Parked)', () => {
    const s = newSim('silence', { lane: 'L4' });
    s.run({ script: forStep('1.5', [asks]) });
    expect(s.state.phase).toBe('Clarifying');
    const since = (s.state.clarify as { since: string }).since;
    s.apply(ITEM_EVENT.timer_fired, {
      timer: 'clarify_silence',
      since,
      due_at: since,
      frozen_ms: 0,
    });
    expect(s.state.phase).toBe('Parked');
    expect(s.state.waiting).toMatchObject({ kind: 'parked', cause: 'clarify.silence' });
    expect(phases(s)).toContain('Clarifying>Parked');
    // answering still ends it
    answer(s);
    expect(s.state.phase).toBe('S1');
    s.run();
    expect(s.state.terminal).toBe('Done');
  });

  it('time under MM-2 does not count: a frozen item fires nothing and the frozen time is part of the deadline', () => {
    const s = parked('park-frozen');
    const since = (s.state.park as { since: string }).since;
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'mm2', reason: 'maintenance', origin: 'mm-2' });
    expect(s.state.clock.frozen_since).not.toBeNull();
    s.apply(ITEM_EVENT.timer_fired, { timer: 'park', since, due_at: since, frozen_ms: 0 });
    expect(s.state.ignored.at(-1)).toContain('frozen');
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'mm2' });
    expect(s.state.clock.frozen_since).toBeNull();
    const frozen = s.state.clock.frozen_ms;
    expect(frozen).toBeGreaterThan(0);
    expect(s.state.park?.frozen_base).toBe(0);
    // the old computation (no frozen time) is stale now; the one with it is the item's
    s.apply(ITEM_EVENT.timer_fired, { timer: 'park', since, due_at: since, frozen_ms: 0 });
    expect(s.state.terminal).toBeNull();
    s.apply(ITEM_EVENT.timer_fired, { timer: 'park', since, due_at: since, frozen_ms: frozen });
    expect(s.state.terminal).toBe('Abandoned');
  });

  it('a hold on a parked item resumes to Parked', () => {
    const s = parked('park-held');
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
    expect(s.state).toMatchObject({ phase: 'Held', underlying: 'Parked' });
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
    expect(s.state.phase).toBe('Parked');
  });
});

describe('ABANDONED with a validated cause code', () => {
  it('a cause is lowercase dotted or underscored tokens; anything else is refused by the contract', () => {
    for (const ok of ['park.timeout', 'e4.abandon', 'owner_abandoned', 'a-b.c_d']) {
      expect(AbandonCause.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '',
      'Park Timeout',
      'park..timeout',
      '.x',
      'x.',
      'a'.repeat(65),
      'drop;table',
    ]) {
      expect(AbandonCause.safeParse(bad).success, bad).toBe(false);
      expect(
        ItemEventPayloads[ITEM_EVENT.abandoned].safeParse({ cause: bad, by: 'alice' }).success,
      ).toBe(false);
    }
  });

  it('an owner abandons a held item; an item that is not held, handed off or parked is not abandoned by the signal', () => {
    const s = newSim('ab', { lane: 'L4' });
    s.run({ decide: () => 'pending' });
    s.apply(ITEM_EVENT.abandoned, { cause: 'owner_abandoned', by: 'alice' });
    expect(s.state.terminal).toBeNull();
    expect(s.state.ignored.at(-1)).toContain('abandoned:from_');
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
    s.apply(ITEM_EVENT.abandoned, { cause: 'owner_abandoned', by: 'alice' });
    expect(s.state).toMatchObject({ terminal: 'Abandoned', terminal_cause: 'owner_abandoned' });
    // what was pending is withdrawn
    expect(s.steps.flatMap((x) => x.commands).some((c) => c.type === 'withdraw_gates')).toBe(true);
  });
});

describe('DECLINED (B22): reason and cause code', () => {
  it('G0 rejected declines the item with its cause code; the requester reads both from the item', () => {
    const s = newSim('declined', { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G0' ? 'reject' : 'pending') });
    expect(s.state).toMatchObject({ terminal: 'Declined', terminal_cause: 'b22.g0_rejected' });
    expect(s.state.outstanding.every((c) => c.type === 'withdraw_gates')).toBe(true);
  });

  it('a request for changes at G0 is not a decline: nothing is declined by silence or doubt', () => {
    const s = newSim('g0-rc', { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G0' ? 'request_changes' : 'pending') });
    expect(s.state.terminal).toBeNull();
    expect(s.state.waiting).toMatchObject({ kind: 'stuck' });
  });
});

describe('BLOCKED (B6)', () => {
  it('"env fixed" from anyone is nothing unless the item is blocked', () => {
    const s = newSim('nb', { lane: 'L3' });
    s.run({ stopAtHuman: ['ready'] });
    s.apply(ITEM_EVENT.env_fixed, { by: 'po' });
    expect(s.state.ignored.at(-1)).toContain('env_fixed');
  });

  it('a blocked item can be held, and resumes blocked; the remediation item is spawned once', () => {
    const s = newSim('b6-held', { lane: 'L3' });
    s.run({
      script: forStep('6.2', [
        { outcome: 'rework', edge: 'B6', reason_code: 'red_baseline' } as never,
      ]),
    });
    expect(s.state.waiting).toMatchObject({ kind: 'blocked', cause: 'red_baseline' });
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
    expect(s.state.waiting).toMatchObject({ kind: 'blocked' });
    expect(s.state.spawns).toHaveLength(1);
    expect(s.executed.filter((c) => c.type === 'spawn_item')).toHaveLength(1);
  });
});

describe('RELHOLD (B26): release held', () => {
  const held = (name: string) => {
    const s = newSim(name, { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G5' ? 'reject' : 'approve') });
    expect(s.state.waiting).toMatchObject({ kind: 'release_held' });
    return s;
  };

  it('a denied release holds the item at G5: merged, not deployed, nothing moves it', () => {
    const s = held('relhold');
    expect(s.state).toMatchObject({ phase: 'G5', terminal: null });
    expect(s.state.rework.by_edge['B26']).toBe(1);
    s.run();
    expect(s.state.waiting).toMatchObject({ kind: 'release_held' });
  });

  it('re-request after the fix window opens G5 again, on a new instance', () => {
    const s = held('relhold-again');
    s.apply(ITEM_EVENT.release_re_requested, { by: 'alice' });
    s.run({ decide: () => 'approve' });
    expect(s.state.terminal).toBe('Done');
    expect(s.gateLog.filter((g) => g.gates.includes('G5'))).toHaveLength(2);
  });

  it('a re-request is nothing unless the release is held', () => {
    const s = newSim('relhold-no', { lane: 'L4' });
    s.run({ decide: () => 'pending' });
    s.apply(ITEM_EVENT.release_re_requested, { by: 'alice' });
    expect(s.state.ignored.at(-1)).toContain('release_re_requested');
  });

  it('"needs change" starts a NEW linked item (release_change) and the origin stays held', () => {
    const s = held('relhold-change');
    const st = s.apply(ITEM_EVENT.spawn_requested, {
      edge: 'B26',
      kind: 'release_change',
      lane: 'L1',
      index: 0,
    });
    expect(st.commands).toMatchObject([
      { type: 'spawn_item', edge: 'B26', kind: 'release_change' },
    ]);
    s.run();
    expect(s.state.spawns[0]).toMatchObject({ edge: 'B26', kind: 'release_change' });
    expect(s.state.waiting).toMatchObject({ kind: 'release_held' });
  });

  it('"needs change" is refused when the release is not held', () => {
    const s = newSim('relhold-nc-no', { lane: 'L4' });
    const st = s.apply(ITEM_EVENT.spawn_requested, {
      edge: 'B26',
      kind: 'release_change',
      lane: 'L1',
      index: 0,
    });
    expect(st.commands).toHaveLength(0);
  });
});

describe('HELD: H1 approver pool, H2 capacity, H3 environment and WIP at admission', () => {
  for (const reason of ['H1', 'H2', 'H3', 'WIP'] as const) {
    it(`${reason}: 6.0 refuses, the item is held in Scheduling and asks again when released`, () => {
      const s = newSim(`held-${reason}`, { lane: 'L3' });
      s.run({
        script: forStep('6.0', [{ outcome: 'held', reason } as never]),
      });
      expect(s.state).toMatchObject({ phase: 'Held', underlying: 'Scheduling' });
      expect(s.state.holds).toHaveLength(1);
      expect(s.state.holds[0]).toMatchObject({ reason, origin: null });
      expect(s.state.holds[0]?.hold_id).toMatch(/^adm:/);
      // held: nothing starts, and a run does not move it
      const before = s.stepsOnly().length;
      s.run();
      expect(s.stepsOnly().length).toBe(before);
      s.apply(ITEM_EVENT.hold_released, {
        hold_id: (s.state.holds[0] as { hold_id: string }).hold_id,
      });
      expect(s.state.phase).toBe('Scheduling');
      s.run();
      expect(s.state.terminal).toBe('Done');
      // admission was asked twice: attempt 1 refused, attempt 2 granted
      expect(s.executed.filter((c) => c.type === 'run_stage' && c.step === '6.0')).toHaveLength(2);
      expect(phases(s)).toContain('Scheduling>Held');
      expect(phases(s)).toContain('Held>Scheduling');
    });
  }

  it('an item with two holds resumes only when the last one is gone (prior-phase resume)', () => {
    const s = newSim('two', { lane: 'L3' });
    s.run({ script: forStep('6.0', [{ outcome: 'held', reason: 'H2' } as never]) });
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
    expect(s.state.holds).toHaveLength(2);
    s.apply(ITEM_EVENT.hold_released, {
      hold_id: (s.state.holds[0] as { hold_id: string }).hold_id,
    });
    expect(s.state.phase).toBe('Held');
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
    expect(s.state.phase).toBe('Scheduling');
  });

  it('a refusal for a command that is no longer outstanding is stale', () => {
    const s = newSim('stale-held', { lane: 'L3' });
    s.apply(ITEM_EVENT.stage_held, { command_key: 'nope', step: '6.0', reason: 'H1' });
    expect(s.state.holds).toHaveLength(0);
  });
});

describe('N8: no active Project Readiness Record', () => {
  it('holds the item at 1.4 and 1.4 runs again once the hold is released', () => {
    const s = newSim('n8', { lane: 'L4' });
    s.run({ eligibility: 'n8_hold' });
    expect(s.state.phase).toBe('Held');
    expect(s.state.holds[0]).toMatchObject({ reason: 'N8' });
    s.apply(ITEM_EVENT.hold_released, {
      hold_id: (s.state.holds[0] as { hold_id: string }).hold_id,
    });
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(s.executed.filter((c) => c.type === 'check_eligibility')).toHaveLength(2);
  });
});

describe('MM-2 maintenance as a hold (timers frozen, decisions not folded forward, drafts kept)', () => {
  it('an open gate stays open under maintenance, a decision folded under it moves nothing, and release continues', () => {
    const s = newSim('mm2', { lane: 'L4' });
    s.run({ decide: () => 'pending' });
    const open = s.state.gates.filter((g) => g.status === 'pending');
    expect(open.length).toBeGreaterThan(0);
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'mm2', reason: 'maintenance', origin: 'mm-2' });
    expect(s.state.phase).toBe('Held');
    // the draft (the open gates) is kept
    expect(s.state.gates.filter((g) => g.status === 'pending')).toHaveLength(open.length);
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'mm2' });
    expect(s.state.phase).toBe('S1');
    s.run();
    expect(s.state.terminal).toBe('Done');
  });
});
