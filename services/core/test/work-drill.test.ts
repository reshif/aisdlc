import {
  GATE_EVENT,
  ITEM_EVENT,
  type Lane,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { FakeCapacity, FakeStagePorts } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbWorkInFlight,
  answerQuestion,
  chooseHandoff,
  envFixed,
  ingestItem,
  reRequestRelease,
  readItem,
  readItemEvents,
  submitRequest,
  workItemProjection,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  GATING_ON,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// THE REBUILD DRILL (PLAN M9.2; it replaces Temporal's): start items at different stations, kill the
// work driver mid-flight, wipe ALL execution state (the outbox, the read model and its checkpoint:
// the worker's jobs and timers are exactly these), refold every item from the record, restart, and
// every item resumes in the same state, finishes the way an undisturbed twin does, and no command is
// done twice. The record is all there is.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

type Stop = Parameters<typeof runItem>[3];
interface Scenario {
  readonly name: string;
  readonly lane: Lane;
  readonly level: 'light' | 'full';
  readonly gating: typeof GATING_ON;
  /** Where the drill interrupts it. `null`: it is only submitted. */
  readonly stop: Stop | null;
  /** What a stage answers for THIS scenario's item (the other items get the default). */
  readonly script?: (req: StageRequest) => StageOutcome | undefined;
  readonly passes?: number;
  readonly crash?: boolean;
  readonly late?: boolean;
  /** The owner puts the item under an MM-2 maintenance hold at the moment of the kill. */
  readonly maintenance?: boolean;
  /** What a person does to finish it (the twin gets the same): the default answers questions and waits. */
  readonly choose?: 'resume' | 'takeover';
  /** The undisturbed twin goes through the same decisions up to the stop (a denial the item must also have had). */
  readonly twinStops?: boolean;
  /** The owner has already made the choice when the driver is killed. */
  readonly chooseBeforeKill?: boolean;
}

const asks: StageOutcome = {
  outcome: 'questions',
  questions: [{ text: 'Which table?', material: 'blocking' }],
};

const SCENARIOS: Scenario[] = [
  {
    name: 'at its first gates',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: { decide: () => 'hold', stop: (st) => st.gates.length > 0 },
  },
  {
    name: 'in S6 behind X1 with a lease',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: { decide: () => 'hold', stop: (st) => st.gates.some((g) => g.gate === 'X1') },
    script: (r) =>
      r.step === '6.4' && r.attempt === 1
        ? { outcome: 'gate_needed', gate: 'X1', reason_code: 'irreversible' }
        : undefined,
  },
  {
    name: 'waiting for the Ready decision',
    lane: 'L1',
    level: 'light',
    gating: GATING_ON,
    stop: { stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'ready' },
  },
  {
    name: 'with the developer (L8)',
    lane: 'L8',
    level: 'light',
    gating: GATING_ON,
    stop: { stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'human_led' },
  },
  {
    name: 'clarifying',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: { stop: (st) => st.phase === 'Clarifying' },
    script: (r) => (r.step === '1.5' && r.attempt === 1 ? asks : undefined),
  },
  {
    name: 'a command done but its result never recorded',
    lane: 'L1',
    level: 'light',
    gating: GATING_OFF,
    stop: { stop: () => false },
    passes: 14,
    crash: true,
  },
  // M9.3 and M9.4: the new waits and holds, killed in the middle of each
  {
    name: 'parked after three rounds of questions',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: { stop: (st) => st.phase === 'Parked' },
    script: (r) => (r.step === '1.5' && r.attempt <= 3 ? asks : undefined),
  },
  {
    name: 'blocked on a red baseline, remediation item spawned',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: { stop: (st) => st.waiting?.kind === 'blocked' && st.spawns.length > 0 },
    script: (r) =>
      r.step === '6.2' && r.attempt === 1
        ? { outcome: 'rework', edge: 'B6', reason_code: 'red_baseline' }
        : undefined,
  },
  {
    name: 'held at admission for capacity (H2)',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: { stop: (st) => st.phase === 'Held' && st.holds.some((h) => h.reason === 'H2') },
    script: (r) =>
      r.step === '6.0' && r.attempt === 1 ? { outcome: 'held', reason: 'H2' } : undefined,
  },
  {
    name: 'handed off (D1), the owner has decided E4 and not yet chosen',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: { stop: (st) => st.waiting?.kind === 'handoff' && st.waiting.stage === 'choice' },
    script: (r) =>
      r.step === '6.4' && r.attempt === 1
        ? { outcome: 'trigger', trigger: 'ET1', reason_code: 'drill' }
        : undefined,
    choose: 'resume',
  },
  {
    name: 'with a developer who took over (lane L8, lease epoch +1)',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: { stop: (st) => st.takeover !== null && st.waiting?.kind === 'human' },
    script: (r) =>
      r.step === '6.4' && r.attempt === 1
        ? { outcome: 'trigger', trigger: 'ET2', reason_code: 'drill' }
        : undefined,
    choose: 'takeover',
    chooseBeforeKill: true,
  },
  {
    name: 'release held (B26) after G5 was denied',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: {
      decide: (g) => (g === 'G5' ? 'reject' : 'approve'),
      stop: (st) => st.waiting?.kind === 'release_held',
    },
    twinStops: true,
  },
  {
    name: 'under an MM-2 maintenance hold (timers frozen, drafts kept)',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: { decide: () => 'hold', stop: (st) => st.gates.some((g) => g.status === 'pending') },
    maintenance: true,
  },
  // made last, after the rest have run: nothing has touched it, its first command only sits in the outbox
  {
    name: 'only submitted',
    lane: 'L3',
    level: 'light',
    gating: GATING_OFF,
    stop: null,
    late: true,
  },
];

let k = 0;
type Started = { sc: Scenario; id: string; project: string; repo: string };
async function start(ports: FakeStagePorts) {
  const items: Started[] = [];
  const by = new Map<string, Scenario>();
  const make = async (sc: Scenario): Promise<Started> => {
    k += 1;
    const seeded = await seedActivePrr(s, { level: sc.level, gating: sc.gating });
    approvers(s, seeded.project);
    const r = await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: sc.lane,
      requester: pr('alice'),
      channel: 'N1',
      text: `drill request ${k}`,
    });
    if (!r.ok) throw new Error(r.error.message);
    by.set(r.value.item_id as string, sc);
    return { sc, id: r.value.item_id as string, project: seeded.project, repo: seeded.repo };
  };
  for (const sc of SCENARIOS.filter((x) => x.late !== true)) items.push(await make(sc));
  ports.script((req) => {
    const sc = by.get(req.item_id);
    if (sc?.crash && req.step === '6.1' && req.attempt === 1)
      ports.coding.loseResponse(req.command_key, 1);
    return sc?.script?.(req);
  });
  const late = async () => {
    for (const sc of SCENARIOS.filter((x) => x.late === true)) items.push(await make(sc));
  };
  return { items, late };
}

/** What an item did, without its ids: the order of the facts and where each happened. */
async function signature(itemId: string): Promise<string[]> {
  return (
    (await readItemEvents(s.record.pool, itemId))
      // a hold is an overlay put on and taken off by whoever holds (the twins are not held): not part of what the item did
      .filter((e) => e.type !== ITEM_EVENT.hold_placed && e.type !== ITEM_EVENT.hold_released)
      .map((e) => {
        const p = e.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const what =
          e.type === ITEM_EVENT.gates_opened
            ? p['gates'].map((g: { gate: string }) => g.gate).join('+')
            : (p['step'] ?? p['gate'] ?? p['outcome'] ?? p['what'] ?? '');
        return `${e.type}:${what}${e.type === ITEM_EVENT.gate_decided ? `:${p['outcome']}` : ''}`;
      })
  );
}

/**
 * Runs an item to its end, answering questions, waiting out a failed command's backoff, and doing what
 * a person does at each of the new waits: "env fixed", the E4 choice, a re-request of the release, the
 * end of a maintenance hold, and capacity for a held item.
 */
async function finish(
  d: ReturnType<typeof driverOver>,
  id: string,
  sc: Scenario | undefined,
  capacity: FakeCapacity,
) {
  for (let i = 0; i < 24; i++) {
    const item = await runItem(s, d, id);
    if (item?.state.terminal !== null) return item;
    const st = item?.state;
    const w = st?.waiting;
    const q = st?.questions.find((x) => x.state === 'open' && x.material === 'blocking');
    if (q) {
      const a = await answerQuestion(s.deps, id, {
        question_id: q.question_id,
        text: 'the orders table',
        by: pr('alice'),
      });
      if (!a.ok) throw new Error(a.error.message);
    } else if (st?.holds.some((h) => h.hold_id === 'mm2')) {
      const r = await ingestItem(s.deps, id, {
        type: ITEM_EVENT.hold_released,
        payload: { hold_id: 'mm2' },
        actor: 'test',
        idempotency_key: `drill-mm2-off:${id}`,
      });
      if (!r.ok) throw new Error(r.error.message);
    } else if (st?.holds.some((h) => h.reason === 'H2')) {
      capacity.grant('H2', 1);
    } else if (w?.kind === 'blocked') {
      const r = await envFixed(s.deps, id, pr('platform-owner'), `drill:${id}`);
      if (!r.ok) throw new Error(r.error.message);
    } else if (w?.kind === 'release_held') {
      const r = await reRequestRelease(s.deps, id, pr('alice'), `drill:${id}`);
      if (!r.ok) throw new Error(r.error.message);
    } else if (w?.kind === 'handoff' && w.stage === 'choice' && st) {
      const h = st.handoffs.find((x) => x.status === 'open');
      const r = await chooseHandoff(s.deps, id, {
        handoff_id: h?.handoff_id as string,
        choice: sc?.choose ?? 'resume',
        by: pr('bob'),
      });
      if (!r.ok) throw new Error(r.error.message);
    } else s.clock.advance(5_000);
  }
  return readItem(s.record.pool, id);
}

const gatesOpened = async (id: string) =>
  (
    await rows(
      `SELECT body ->> 'gate_id' AS g FROM record.record_event WHERE type = $1 AND body ->> 'subject_id' = $2 ORDER BY global_seq`,
      [GATE_EVENT.opened, id],
    )
  ).map((r) => r.g as string);

describe('the rebuild drill', () => {
  it('kill the work driver mid-flight, wipe all execution state, refold, restart: every item resumes and nothing is done twice', async () => {
    // ---- the undisturbed twins
    const controlPorts = new FakeStagePorts();
    const startedControl = await start(controlPorts);
    await startedControl.late();
    const control = startedControl.items;
    const controlCapacity = new FakeCapacity();
    const cd = driverOver(s, { ports: controlPorts, capacity: controlCapacity });
    for (const c of control) {
      if (c.sc.twinStops && c.sc.stop) {
        await runItem(s, cd, c.id, { ...c.sc.stop, passes: c.sc.passes ?? 80 });
      }
      await finish(cd, c.id, c.sc, controlCapacity);
    }
    for (const c of control) {
      expect((await readItem(s.record.pool, c.id))?.state.terminal, c.sc.name).toBe('Done');
    }

    // ---- the drill: start, run each to its station
    const ports = new FakeStagePorts();
    const started = await start(ports);
    const items = started.items;
    const capacity = new FakeCapacity();
    const before = driverOver(s, { ports, capacity });
    for (const i of [...items]) {
      const stopSpec = i.sc.stop;
      if (stopSpec === null) continue;
      // a scenario that needs answers on its way (rounds of questions) gets them
      for (let round = 0; round < 6; round++) {
        await runItem(s, before, i.id, { ...stopSpec, passes: i.sc.passes ?? 80 });
        const cur = (await readItem(s.record.pool, i.id))?.state;
        if (!cur || stopSpec?.stop?.(cur) === true) break;
        const w = cur.waiting;
        if (i.sc.chooseBeforeKill && w?.kind === 'handoff' && w.stage === 'choice') {
          const c = await chooseHandoff(s.deps, i.id, {
            handoff_id: cur.handoffs.find((x) => x.status === 'open')?.handoff_id as string,
            choice: i.sc.choose ?? 'resume',
            by: pr('bob'),
          });
          if (!c.ok) throw new Error(c.error.message);
          continue;
        }
        const q = cur.questions.find((x) => x.state === 'open');
        if (!q) break;
        const a = await answerQuestion(s.deps, i.id, {
          question_id: q.question_id,
          text: 'the orders table',
          by: pr('alice'),
        });
        if (!a.ok) throw new Error(a.error.message);
      }
      if (i.sc.maintenance) {
        const r = await ingestItem(s.deps, i.id, {
          type: ITEM_EVENT.hold_placed,
          payload: { hold_id: 'mm2', reason: 'maintenance', origin: 'mm-2' },
          actor: 'test',
          idempotency_key: `drill-mm2-on:${i.id}`,
        });
        if (!r.ok) throw new Error(r.error.message);
      }
    }
    await started.late();

    // every scenario is where it was meant to be
    const at = async (id: string) => (await readItem(s.record.pool, id))?.state;
    expect((await at(items[0]?.id as string))?.waiting).toMatchObject({
      kind: 'gates',
      gates: ['G0', 'G1'],
    });
    const b = await at(items[1]?.id as string);
    expect(b).toMatchObject({
      phase: 'S6',
      waiting: { kind: 'gates', gates: ['X1'] },
      lease: { epoch: 1 },
    });
    expect((await at(items[2]?.id as string))?.waiting).toEqual({ kind: 'human', what: 'ready' });
    expect((await at(items[3]?.id as string))?.waiting).toEqual({
      kind: 'human',
      what: 'human_led',
    });
    expect((await at(items[4]?.id as string))?.phase).toBe('Clarifying');
    expect((await at(items.at(-1)?.id as string))?.outstanding.map((c) => c.type)).toEqual([
      'run_stage',
    ]);
    // the new waits and holds are where they were meant to be
    const named = (needle: string) => items.find((i) => i.sc.name.includes(needle))?.id as string;
    expect(await at(named('parked'))).toMatchObject({
      phase: 'Parked',
      waiting: { kind: 'parked', cause: 'b1_round_limit' },
    });
    expect(await at(named('blocked'))).toMatchObject({
      phase: 'S6',
      waiting: { kind: 'blocked', owner: 'platform_owner' },
    });
    expect((await at(named('blocked')))?.spawns[0]).toMatchObject({ edge: 'B6', lane: 'L2' });
    expect(await at(named('capacity'))).toMatchObject({ phase: 'Held', underlying: 'Scheduling' });
    expect((await at(named('handed off')))?.handoffs[0]).toMatchObject({
      code: 'D1',
      e4_decided: true,
    });
    expect(await at(named('took over'))).toMatchObject({
      lane: 'L8',
      phase: 'S6',
      lease: { epoch: 2 },
      waiting: { kind: 'human', what: 'human_led' },
    });
    expect(await at(named('release held'))).toMatchObject({
      phase: 'G5',
      waiting: { kind: 'release_held' },
    });
    expect(await at(named('MM-2'))).toMatchObject({ phase: 'Held', underlying: 'S1' });
    // the crash: the port did the work for 6.1, the stream never heard, so the command is still out
    const crashItem = items[5]?.id as string;
    const lost = ports.coding.calls.find((c) => c.item_id === crashItem && c.step === '6.1');
    expect(lost).toBeDefined();
    expect(ports.coding.effects).toContain(lost?.command_key);
    expect((await at(crashItem))?.outstanding.map((c) => c.key)).toContain(lost?.command_key);
    // the live read model agrees with the record, and the repo with the open lease has work in flight
    await expectRebuildEqualsLive(s.record.pool, workItemProjection);
    const flight = new DbWorkInFlight(s.record.pool);
    expect(await flight.hasWorkInFlight(items[1]?.repo as string)).toEqual({
      ok: true,
      value: true,
    });

    // ---- the state at the moment of the kill
    const snapshot = new Map<string, string>();
    for (const i of items)
      snapshot.set(i.id, JSON.stringify((await readItem(s.record.pool, i.id))?.state));
    const outbox = await rows(
      `SELECT count(*)::int AS n FROM record.outbox WHERE destination = 'work.commands'`,
    );
    expect(outbox[0]?.n).toBeGreaterThan(0);

    // ---- WIPE every piece of execution state: the outbox (jobs), the read model, its checkpoint
    // (the outbox refuses DELETE by trigger: a lost queue is a disk gone, not a statement, so the
    // test switches the triggers off for this one connection)
    const wipe = await s.record.pool.connect();
    try {
      await wipe.query(`SET session_replication_role = replica`);
      await wipe.query(`DELETE FROM record.outbox WHERE destination = 'work.commands'`);
      await wipe.query(`RESET session_replication_role`);
    } finally {
      wipe.release();
    }
    await s.record.pool.query(`DELETE FROM core.work_item`);
    await s.record.pool.query(`DELETE FROM record.projection_checkpoint WHERE name = 'work_item'`);
    expect(
      (
        await rows(
          `SELECT count(*)::int AS n FROM record.outbox WHERE destination = 'work.commands'`,
        )
      )[0]?.n,
    ).toBe(0);
    expect((await rows(`SELECT count(*)::int AS n FROM core.work_item`))[0]?.n).toBe(0);
    // while nothing is rebuilt, a repo's work in flight is unknown to the read model; the refold below fixes it

    // ---- REFOLD from the record: every item is exactly where it was
    for (const i of items) {
      expect(JSON.stringify((await readItem(s.record.pool, i.id))?.state), i.sc.name).toBe(
        snapshot.get(i.id),
      );
    }

    // ---- RESTART: a new driver (no memory), the same ports (they are other systems)
    const after = driverOver(s, { ports, capacity });
    const pass = await (await import('../src/index.js')).driveWork(after);
    // the outstanding commands came back out of the record, with their keys
    expect(pass.enqueued).toBeGreaterThan(0);
    expect(await flight.hasWorkInFlight(items[1]?.repo as string)).toEqual({
      ok: true,
      value: true,
    });
    for (const i of items) await finish(after, i.id, i.sc, capacity);

    // ---- everything finished, the way the undisturbed twins did
    for (const [n, i] of items.entries()) {
      const st = (await readItem(s.record.pool, i.id))?.state;
      expect(st?.terminal, i.sc.name).toBe('Done');
      expect(await signature(i.id), i.sc.name).toEqual(await signature(control[n]?.id as string));
      expect(await gatesOpened(i.id), i.sc.name).toEqual(
        await gatesOpened(control[n]?.id as string),
      );
    }

    // ---- nothing was done twice
    // the crashed command was asked again after the restart and answered from the port's memory
    const again = ports.coding.calls.filter((c) => c.command_key === lost?.command_key);
    expect(again.length).toBe(2);
    expect(ports.coding.effects.filter((x) => x === lost?.command_key)).toHaveLength(1);
    for (const p of ports.all()) {
      expect(new Set(p.effects).size, p.port).toBe(p.effects.length);
    }
    // every command key has exactly one recorded result, in every item
    for (const i of items) {
      const ev = await readItemEvents(s.record.pool, i.id);
      const answered = ev.flatMap((e) => {
        const key = (e.payload as { command_key?: string }).command_key;
        return key ? [key] : [];
      });
      expect(new Set(answered).size, `${i.sc.name}: a command answered twice`).toBe(
        answered.length,
      );
    }
    // one effect per stage command, over all items, equals the number of stage results recorded
    let stageResults = 0;
    // (the items the drill ran, and the linked items they spawned: those ran on the same ports)
    const ran = [...items.map((i) => i.id)];
    for (const i of items) {
      for (const l of (await readItem(s.record.pool, i.id))?.state.spawns ?? [])
        ran.push(l.item_id);
    }
    for (const id of ran) {
      stageResults += (await readItemEvents(s.record.pool, id)).filter((e) =>
        [
          ITEM_EVENT.stage_completed,
          ITEM_EVENT.questions_raised,
          ITEM_EVENT.stage_gate_needed,
          // what a stage can also answer (M9.3, M9.4): refused admission, a back-edge, a trigger
          ITEM_EVENT.stage_held,
          ITEM_EVENT.rework_requested,
          ITEM_EVENT.trigger_fired,
        ].includes(e.type as never),
      ).length;
    }
    expect(ports.effects().length).toBe(stageResults);
    // and the rebuilt read model is the live one
    await expectRebuildEqualsLive(s.record.pool, workItemProjection);
  }, 300_000);
});
