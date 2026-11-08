import {
  CARD_EVENT,
  GATE_EVENT,
  ITEM_EVENT,
  ItemCreatedPayload,
  type Lane,
} from '@aisdlc/contracts';
import { sweepExpired } from '@aisdlc/decisions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbWorkInFlight,
  driveWork,
  executeCommand,
  ingestItem,
  readItem,
  readItemEvents,
  submitRequest,
  type SubmitRequestInput,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  GATING_ON,
  actFor,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// The catalogue-driven interpreter, end to end (PLAN M9.2): lane profile bound at G0, gates from the
// catalogue intersected with the profile the item pinned, human gates opened through the decision
// kernel (SOLO cards where consolidatable), stage work through the stage-port fakes, holds as
// overlays, and the real WorkInFlightPort. Real Postgres, real ledger and Notary.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
async function newItem(
  o: {
    lane?: Lane;
    level?: 'light' | 'full';
    gating?: typeof GATING_ON;
    who?: string[];
    over?: Partial<SubmitRequestInput>;
    seeded?: { project: string; repo: string };
  } = {},
) {
  n += 1;
  const seeded =
    o.seeded ??
    (await seedActivePrr(s, { level: o.level ?? 'full', gating: o.gating ?? GATING_ON }));
  approvers(s, seeded.project, o.who ?? ['bob']);
  const r = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: o.lane ?? 'L4',
      requester: pr('alice'),
      channel: 'N1',
      text: `engine test request ${n}`,
      ...o.over,
    }),
  );
  return { ...seeded, itemId: r.item_id as string, request: r };
}

const gatesOpenedFor = async (itemId: string) =>
  (
    await rows(
      `SELECT body ->> 'gate_id' AS gate FROM record.record_event
        WHERE type = $1 AND body ->> 'subject_id' = $2 ORDER BY global_seq`,
      [GATE_EVENT.opened, itemId],
    )
  ).map((r) => r.gate as string);

const ledgerFor = async (itemId: string) =>
  rows(
    `SELECT gate_id, decision, actor FROM ledger.ledger_entry
      WHERE entry_type = 'decision' AND subject_id = $1 ORDER BY ledger_seq`,
    [itemId],
  );

describe('every lane an onboarding can open runs to Done through the fake stages', () => {
  const cases: Array<[Lane, 'light' | 'full']> = [
    ['L1', 'light'],
    ['L2', 'light'],
    ['L3', 'light'],
    ['L4', 'full'],
    ['L6', 'full'],
    ['L8', 'light'],
  ];
  for (const [lane, level] of cases) {
    for (const [pname, gating] of [
      ['all gates on', GATING_ON],
      ['all gates off', GATING_OFF],
    ] as const) {
      it(`${lane}, ${pname}`, async () => {
        const it_ = await newItem({ lane, level, gating });
        const d = driverOver(s);
        const item = await runItem(s, d, it_.itemId);
        expect(item?.state.terminal, JSON.stringify(item?.state.waiting)).toBe('Done');
        expect(item?.state.lane).toBe(lane);
        expect(item?.state.outstanding).toEqual([]);
        // every command was done once
        const effects = d.ports.effects();
        expect(new Set(effects).size).toBe(effects.length);
      });
    }
  }
});

describe('gates come from the catalogue and the profile the item pinned', () => {
  it('an off gate is absent: no instance is ever opened for it, no decision is ever written; G4 always is', async () => {
    const on = await newItem({ lane: 'L4', gating: GATING_ON });
    const off = await newItem({ lane: 'L4', gating: GATING_OFF });
    const d = driverOver(s);
    await runItem(s, d, on.itemId);
    await runItem(s, d, off.itemId);
    expect(await gatesOpenedFor(on.itemId)).toEqual(
      expect.arrayContaining(['G0', 'G1', 'G2', 'G3d', 'G3', 'G3s', 'G4', 'G5', 'G6']),
    );
    expect(await gatesOpenedFor(off.itemId)).toEqual(['G4']);
    const led = await ledgerFor(off.itemId);
    expect(led).toEqual([{ gate_id: 'G4', decision: 'approve', actor: 'bob' }]);
    expect((await ledgerFor(on.itemId)).map((e) => e.gate_id).sort()).toEqual(
      ['G0', 'G1', 'G2', 'G3', 'G3d', 'G3s', 'G4', 'G5', 'G6'].sort(),
    );
  });

  it('the always-required gates cannot be named by a profile at all, so none can be removed', () => {
    const created = {
      item_id: '00000000-0000-4000-8000-0000000000aa',
      project_id: 'p',
      request_id: '00000000-0000-4000-8000-0000000000ab',
      repo: 'a/b',
      requester: 'alice',
      channel: 'N1',
      catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
      gating_profile: GATING_OFF,
      tier: 'T1',
      prr: { version: 1, record_hash: 'b'.repeat(64) },
      proposed_lane: 'L4',
      intake: {
        text_sha256: null,
        injection: null,
        dedupe_links: [],
        conflict_candidates: [],
        route: 'normal',
        eligibility_reason: 'eligible',
      },
      origin: null,
    };
    expect(ItemCreatedPayload.safeParse(created).success).toBe(true);
    for (const key of ['G4', 'g4', 'X1', 'E4', 'M4', 'Q1']) {
      const bad = {
        ...created,
        gating_profile: { ...GATING_OFF, gates: { ...GATING_OFF.gates, [key]: 'off' } },
      };
      expect(ItemCreatedPayload.safeParse(bad).success, key).toBe(false);
    }
  });

  it('an item keeps the profile it started with: a later, smaller profile applies to new items only', async () => {
    const first = await newItem({ lane: 'L4', gating: GATING_ON });
    await seedActivePrr(s, { ...first, level: 'full', gating: GATING_OFF, version: 2 });
    const d = driverOver(s);
    await runItem(s, d, first.itemId);
    expect(await gatesOpenedFor(first.itemId)).toEqual(
      expect.arrayContaining(['G2', 'G3d', 'G5', 'G6']),
    );
    const second = await newItem({ seeded: first, lane: 'L4' });
    await runItem(s, d, second.itemId);
    expect(await gatesOpenedFor(second.itemId)).toEqual(['G4']);
  });

  it('the lane profile is bound at G0: nothing is bound before, the lane after, with the decision that bound it', async () => {
    const it_ = await newItem({ lane: 'L3', level: 'light', gating: GATING_ON });
    const d = driverOver(s);
    const waiting = await runItem(s, d, it_.itemId, {
      decide: () => 'hold',
      stop: (st) => st.gates.length > 0,
    });
    expect(waiting?.state.lane).toBeNull();
    expect(waiting?.state.waiting).toMatchObject({ kind: 'gates', gates: ['G0', 'G1'] });
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.lane).toBe('L3');
    expect(done?.state.lane_bound_by).toMatch(/^G0:/);
  });

  it('gate status is read from the ledger, never from the gate read model', async () => {
    const it_ = await newItem({ lane: 'L1', level: 'light', gating: GATING_ON });
    const d = driverOver(s);
    await runItem(s, d, it_.itemId);
    const events = (await readItemEvents(s.record.pool, it_.itemId)).filter(
      (e) => e.type === ITEM_EVENT.gate_decided,
    );
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const p = e.payload as { ledger_entry_id: string; gate_instance_id: string };
      const l = await rows(`SELECT gate_instance_id FROM ledger.ledger_entry WHERE entry_id = $1`, [
        p.ledger_entry_id,
      ]);
      expect(l[0]?.gate_instance_id).toBe(p.gate_instance_id);
    }
    // the gate projection was never caught up on this path: the item moved without it
    const proj = await rows(
      `SELECT count(*)::int AS n FROM decisions.gate_instance WHERE subject_id = $1`,
      [it_.itemId],
    );
    expect(proj[0]?.n).toBe(0);
  });

  it('expiry never approves: an expired gate is opened again, and only a decision moves the item on', async () => {
    const it_ = await newItem({ lane: 'L1', level: 'light', gating: GATING_ON });
    const d = driverOver(s);
    const at = await runItem(s, d, it_.itemId, {
      decide: () => 'hold',
      stop: (st) => st.gates.length > 0,
    });
    const first = at?.state.gates.map((g) => g.gate_instance_id) ?? [];
    expect(first).toHaveLength(2);
    s.clock.advance(8 * 24 * 3600 * 1000); // past the 7 day TTL
    const sw = await sweepExpired(s.config);
    expect(sw.ok && sw.value.expired.length).toBeGreaterThanOrEqual(2);
    await driveWork(d);
    await driveWork(d);
    const again = (await readItem(s.record.pool, it_.itemId))?.state;
    expect(again?.terminal).toBeNull();
    expect(again?.phase).toBe('S1');
    expect(again?.lane).toBeNull(); // nothing was bound by an expiry
    const pending = again?.gates.filter((g) => g.status === 'pending') ?? [];
    expect(pending.map((g) => g.gate).sort()).toEqual(['G0', 'G1']);
    expect(pending.every((g) => !first.includes(g.gate_instance_id))).toBe(true);
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
  });

  it('SOLO consolidation: a single operator gets one card for G0+G1 and for G3+G3s; two holders get a card each', async () => {
    const one = await newItem({ lane: 'L4', gating: GATING_ON, who: ['bob'] });
    const two = await newItem({ lane: 'L4', gating: GATING_ON, who: ['bob', 'carol'] });
    const d = driverOver(s);
    await runItem(s, d, one.itemId);
    await runItem(s, d, two.itemId, { approver: 'bob' });
    const cardsOf = async (id: string) =>
      (
        await rows(
          `SELECT body -> 'targets' AS targets FROM record.record_event WHERE type = $1 AND body ->> 'subject_id' = $2`,
          [CARD_EVENT.opened, id],
        )
      ).map((r) =>
        (r.targets as Array<{ gate_id: string }>)
          .map((t) => t.gate_id)
          .sort()
          .join('+'),
      );
    expect((await cardsOf(one.itemId)).sort()).toEqual(
      ['G0+G1', 'G2', 'G3+G3s', 'G3d', 'G4', 'G5', 'G6'].sort(),
    );
    expect((await cardsOf(two.itemId)).sort()).toEqual(
      ['G0', 'G1', 'G2', 'G3', 'G3d', 'G3s', 'G4', 'G5', 'G6'].sort(),
    );
  });
});

describe('stage work goes through the stage ports', () => {
  it('each step reaches the port of its stage, once, with the command key; never request text', async () => {
    const it_ = await newItem({ lane: 'L4', gating: GATING_ON });
    const d = driverOver(s);
    await runItem(s, d, it_.itemId);
    const stagesOf = (calls: Array<{ step: string }>) =>
      [...new Set(calls.map((c) => c.step.split('.')[0]))].sort();
    expect(stagesOf(d.ports.planning.calls)).toEqual(['1', '2', '3', '4', '5']);
    expect(stagesOf(d.ports.coding.calls)).toEqual(['6']);
    expect(stagesOf(d.ports.verify.calls)).toEqual(['7']);
    expect(stagesOf(d.ports.release.calls).every((x) => x === '9' || x === 'S8b')).toBe(true);
    const keys = d.ports.calls().map((c) => c.command_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(JSON.stringify(d.ports.calls())).not.toContain('engine test request');
    for (const c of d.ports.calls()) {
      expect(Object.keys(c).sort()).toEqual(
        [
          'approved_gates',
          'attempt',
          'catalogue_ref',
          'command_key',
          'item_id',
          'lane',
          'project_id',
          'repo',
          'step',
        ].sort(),
      );
    }
    // 1.4 is the eligibility check, never a port
    expect(d.ports.planning.calls.map((c) => c.step)).not.toContain('1.4');
  });

  it('a stage raises X3: the gate opens on its own card, and the approval runs 6.4 again with it approved', async () => {
    const it_ = await newItem({ lane: 'L3', level: 'light', gating: GATING_OFF });
    const d = driverOver(s);
    d.ports.coding.scriptStep('6.4', [
      { outcome: 'gate_needed', gate: 'X3', reason_code: 'new_package' },
    ]);
    const at = await runItem(s, d, it_.itemId, {
      decide: () => 'hold',
      stop: (st) => st.gates.some((g) => g.gate === 'X3'),
    });
    expect(at?.state).toMatchObject({ phase: 'S6', waiting: { kind: 'gates', gates: ['X3'] } });
    // agent work is in flight now: a lease is open in S6
    expect(at?.state.lease).toEqual({ epoch: 1 });
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
    const calls = d.ports.coding.calls.filter((c) => c.step === '6.4');
    expect(calls.map((c) => [c.attempt, c.approved_gates])).toEqual([
      [1, []],
      [2, ['X3']],
    ]);
  });

  it('human scheduling is a station only when the profile opted in', async () => {
    const it_ = await newItem({
      lane: 'L1',
      level: 'light',
      gating: { ...GATING_OFF, schedule: 'human' },
    });
    const d = driverOver(s);
    const at = await runItem(s, d, it_.itemId, {
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'schedule',
    });
    expect(at?.state.waiting).toEqual({ kind: 'human', what: 'schedule' });
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
  });

  it('an L8 item waits for the developer (D5) after G0 and goes on to 7.1', async () => {
    const it_ = await newItem({ lane: 'L8', level: 'light', gating: GATING_ON });
    const d = driverOver(s);
    const at = await runItem(s, d, it_.itemId, {
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'human_led',
    });
    expect(at?.state.waiting).toEqual({ kind: 'human', what: 'human_led' });
    expect(d.ports.coding.calls).toEqual([]); // no agent built anything
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(d.ports.coding.calls).toEqual([]);
    expect(d.ports.verify.calls.map((c) => c.step)).toEqual([
      '7.1',
      '7.2',
      '7.3',
      '7.4',
      '7.5',
      '7.6',
    ]);
  });
});

describe('holds are overlays', () => {
  it('a hold while a gate is out keeps the decision, holds back the next command, and resumes on release', async () => {
    const it_ = await newItem({ lane: 'L1', level: 'light', gating: GATING_ON });
    const d = driverOver(s);
    await runItem(s, d, it_.itemId, { decide: () => 'hold', stop: (st) => st.gates.length > 0 });
    ok(
      await ingestItem(s.deps, it_.itemId, {
        type: ITEM_EVENT.hold_placed,
        payload: { hold_id: 'kill-1', reason: 'kill', origin: 'ctl-1' },
        actor: 'ops',
        idempotency_key: 'hold-kill-1',
      }),
    );
    // the people decide anyway; the item records it and does not move
    await actFor(s, d, it_.itemId, {});
    await driveWork(d);
    const held = (await readItem(s.record.pool, it_.itemId))?.state;
    expect(held?.phase).toBe('Held');
    expect(held?.underlying).toBe('S1');
    expect(held?.gates.every((g) => g.status === 'decided')).toBe(true);
    expect(held?.lane).toBe('L1'); // the decision was folded: the lane is bound, but nothing has run
    expect(held?.cursor).toBeGreaterThan(0);
    expect(held?.waiting).toBeNull(); // nothing is waited for and nothing was started
    expect(held?.outstanding).toEqual([]);
    const callsBefore = d.ports.calls().length;
    await driveWork(d);
    expect(d.ports.calls().length).toBe(callsBefore);
    ok(
      await ingestItem(s.deps, it_.itemId, {
        type: ITEM_EVENT.hold_released,
        payload: { hold_id: 'kill-1' },
        actor: 'ops',
        idempotency_key: 'release-kill-1',
      }),
    );
    const done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
  });
});

describe('replay determinism and idempotency', () => {
  it('the same stream folds to the same state, and the outbox holds exactly the commands the stream issued', async () => {
    const it_ = await newItem({ lane: 'L4', gating: GATING_ON });
    const d = driverOver(s);
    await runItem(s, d, it_.itemId);
    const a = await readItem(s.record.pool, it_.itemId);
    const b = await readItem(s.record.pool, it_.itemId);
    expect(a).toEqual(b);
    const issued = a?.issued.flatMap((i) => i.commands.map((c) => c.key)) ?? [];
    const box = (
      await rows(
        `SELECT idempotency_key FROM record.outbox WHERE destination = 'work.commands' AND payload ->> 'item_id' = $1`,
        [it_.itemId],
      )
    ).map((r) => r.idempotency_key as string);
    expect([...box].sort()).toEqual([...issued].sort());
    // and the read model is a function of the stream
    const row = (
      await rows(`SELECT phase, terminal, lane, seq FROM core.work_item WHERE item_id = $1`, [
        it_.itemId,
      ])
    )[0];
    await driveWork(d); // catches the projection up
    const row2 = (
      await rows(`SELECT phase, terminal, lane, seq FROM core.work_item WHERE item_id = $1`, [
        it_.itemId,
      ])
    )[0];
    expect(row2).toMatchObject({
      phase: a?.state.phase,
      terminal: a?.state.terminal,
      lane: a?.state.lane,
      seq: a?.state.seq,
    });
    void row;
  });

  it('a command delivered again is not executed again: the stream no longer lists it, and the port is not asked', async () => {
    const it_ = await newItem({ lane: 'L1', level: 'light', gating: GATING_OFF });
    const d = driverOver(s);
    await runItem(s, d, it_.itemId);
    const before = d.ports.calls().length;
    const sent = await rows(
      `SELECT id, destination, payload, idempotency_key, created_at, attempts, last_error, next_attempt_at, dead_at FROM record.outbox WHERE destination = 'work.commands' AND payload ->> 'item_id' = $1`,
      [it_.itemId],
    );
    expect(sent.length).toBeGreaterThan(5);
    for (const row of sent) await executeCommand(d, row as never);
    expect(d.ports.calls().length).toBe(before);
    expect((await readItem(s.record.pool, it_.itemId))?.state.terminal).toBe('Done');
  });

  it('a crash between the port doing the work and the result being recorded redelivers the same key: one effect', async () => {
    const it_ = await newItem({ lane: 'L1', level: 'light', gating: GATING_OFF });
    const d = driverOver(s);
    const first = await runItem(s, d, it_.itemId, { stop: (st) => st.waiting?.kind === 'human' });
    expect(first?.state.waiting).toEqual({ kind: 'human', what: 'ready' });
    // lose the response of the next stage command
    d.ports.coding.script((req) => {
      if (req.step === '6.1' && req.attempt === 1) d.ports.coding.loseResponse(req.command_key, 1);
      return undefined;
    });
    let done = await runItem(s, d, it_.itemId);
    // the response was lost: the command failed, and the outbox delivers it again after its backoff
    expect(done?.state.terminal).toBeNull();
    s.clock.advance(5_000);
    done = await runItem(s, d, it_.itemId);
    expect(done?.state.terminal).toBe('Done');
    const lost = d.ports.coding.calls.filter((c) => c.step === '6.1');
    expect(lost.length).toBe(2); // asked twice (the response was lost)...
    expect(d.ports.coding.effects.filter((k) => k === lost[0]?.command_key)).toHaveLength(1); // ...done once
    const results = (await readItemEvents(s.record.pool, it_.itemId)).filter(
      (e) =>
        e.type === ITEM_EVENT.stage_completed && (e.payload as { step: string }).step === '6.1',
    );
    expect(results).toHaveLength(1);
  });
});

describe('the real WorkInFlightPort', () => {
  it('a repo has work in flight from admission until S6 ends; another repo and a finished item do not', async () => {
    const it_ = await newItem({ lane: 'L3', level: 'light', gating: GATING_OFF });
    const other = await seedActivePrr(s, { level: 'light' });
    const port = new DbWorkInFlight(s.record.pool);
    const d = driverOver(s);
    // nothing runs before S6
    await runItem(s, d, it_.itemId, { stop: (st) => st.waiting?.kind === 'human' });
    expect(await port.hasWorkInFlight(it_.repo)).toEqual({ ok: true, value: false });
    // park it in S6 behind an X1 gate (a lease is open there)
    d.ports.coding.scriptStep('6.4', [
      { outcome: 'gate_needed', gate: 'X1', reason_code: 'irreversible' },
    ]);
    await runItem(s, d, it_.itemId, {
      decide: () => 'hold',
      stop: (st) => st.gates.some((g) => g.gate === 'X1'),
    });
    expect(await port.hasWorkInFlight(it_.repo)).toEqual({ ok: true, value: true });
    expect(await port.hasWorkInFlight(it_.repo.toUpperCase())).toEqual({ ok: true, value: true });
    expect(await port.hasWorkInFlight(other.repo)).toEqual({ ok: true, value: false });
    await runItem(s, d, it_.itemId);
    expect((await readItem(s.record.pool, it_.itemId))?.state.terminal).toBe('Done');
    expect(await port.hasWorkInFlight(it_.repo)).toEqual({ ok: true, value: false });
  });

  it('is an error, never "no work", when the read model cannot be read', async () => {
    const dead = new DbWorkInFlight({
      query: async () => {
        throw new Error('down');
      },
      connect: async () => {
        throw new Error('down');
      },
    } as never);
    expect(await dead.hasWorkInFlight('acme/x')).toMatchObject({ ok: false });
  });
});
