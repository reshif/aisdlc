import {
  GATE_EVENT,
  ITEM_EVENT,
  type Lane,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { FakeCapacity, FakeKillState, FakeStagePorts } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { describe, expect, it } from 'vitest';
import {
  DbWorkInFlight,
  answerQuestion,
  chooseHandoff,
  driveWork,
  envFixed,
  ingestItem,
  listBreakers,
  readBreaker,
  readItem,
  readItemEvents,
  recordBreakerSignal,
  reRequestRelease,
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

// THE REBUILD DRILL (PLAN M9.2; it replaces Temporal's): start an item at a station, kill the work
// driver mid-flight, wipe ALL execution state (the outbox, the read model and its checkpoint: the
// worker's jobs and timers are exactly these), refold the item from the record, restart, and the item
// resumes in the same state, finishes the way an undisturbed twin does, and no command is done twice.
// The record is all there is.
//
// One scenario is one test case with its OWN database and stack (`runScenario`): the wipe is global
// to a database, and a driver pass walks every item in it, so sixteen scenarios in one database made
// each pass sixteen times as dear (the single case took ~260 s). The cases are spread over several
// test files (`work-drill-*.test.ts`) so Vitest runs them in parallel workers.

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
  /** M9.6: the project is KILLED (at the kill switch, which has its own state) when the driver is killed. */
  readonly killed?: boolean;
  /** M9.5: the breaker of the project and lane is TRIPPED (R3) before the request is made, so it goes to L8. */
  readonly tripped?: boolean;
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
  // M9.6: a project killed at the kill switch (its own service and state: the wipe does not touch it)
  {
    name: 'in a killed project (kill hold, nothing dispatched)',
    lane: 'L4',
    level: 'full',
    gating: GATING_ON,
    stop: { decide: () => 'hold', stop: (st) => st.gates.some((g) => g.status === 'pending') },
    killed: true,
  },
  // M9.5: the R3 breaker of this project and lane is tripped, so a new item for it goes to L8
  {
    name: 'in a lane whose circuit breaker (R3) is tripped, routed to L8',
    lane: 'L3',
    level: 'light',
    gating: GATING_ON,
    stop: { stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'ready' },
    tripped: true,
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

type Started = { sc: Scenario; id: string; project: string; repo: string };

/** One scenario's world: its stack, its kill switch (another service: the wipe does not reach it) and counters. */
interface Run {
  readonly s: CoreStack;
  readonly kill: FakeKillState;
  readonly killIds: Map<string, string>;
  k: number;
}

const rows = async (r: Run, sql: string, args: unknown[] = []) =>
  (await r.s.record.pool.query(sql, args)).rows as Row[];

async function start(r: Run, sc: Scenario, ports: FakeStagePorts): Promise<Started> {
  const { s } = r;
  r.k += 1;
  const seeded = await seedActivePrr(s, { level: sc.level, gating: sc.gating });
  approvers(s, seeded.project);
  if (sc.tripped) {
    // three counts toward ET14 (the catalogue's threshold) for this project and lane
    for (let n = 0; n < 3; n++) {
      const t = await recordBreakerSignal(s.deps, {
        project_id: seeded.project,
        lane: sc.lane,
        source: 'E4_abandon',
        item_id: null,
        signal_key: `drill-trip:${seeded.project}:${n}`,
      });
      if (!t.ok) throw new Error(t.error.message);
    }
  }
  const sub = await submitRequest(s.deps, {
    project_id: pid(seeded.project),
    repo: seeded.repo,
    lane: sc.lane,
    requester: pr('alice'),
    channel: 'N1',
    text: `drill request ${r.k}`,
  });
  if (!sub.ok) throw new Error(sub.error.message);
  const id = sub.value.item_id as string;
  ports.script((req) => {
    if (req.item_id !== id) return undefined;
    if (sc.crash && req.step === '6.1' && req.attempt === 1)
      ports.coding.loseResponse(req.command_key, 1);
    return sc.script?.(req);
  });
  return { sc, id, project: seeded.project, repo: seeded.repo };
}

/** What an item did, without its ids: the order of the facts and where each happened. */
async function signature(r: Run, itemId: string): Promise<string[]> {
  return (
    (await readItemEvents(r.s.record.pool, itemId))
      // a hold is an overlay put on and taken off by whoever holds (the twins are not held): not part of what the item did
      .filter((e) => e.type !== ITEM_EVENT.hold_placed && e.type !== ITEM_EVENT.hold_released)
      .map((e) => {
        const p = e.payload as Row;
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
 * end of a maintenance hold, and capacity for a held item. The clock is the test's: "waiting out a
 * backoff" is `clock.advance`, never real time.
 */
async function finish(
  r: Run,
  d: ReturnType<typeof driverOver>,
  id: string,
  sc: Scenario | undefined,
  capacity: FakeCapacity,
) {
  const { s } = r;
  for (let i = 0; i < 24; i++) {
    // a killed project's item waits for the release: do not spin the driver over it
    const held = (await readItem(s.record.pool, id))?.state;
    if (held?.holds.some((h) => h.reason === 'kill')) {
      const kid = r.killIds.get(id);
      if (kid) r.kill.release(kid);
      s.clock.advance(60_000);
    }
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
    } else if (st?.holds.some((h) => h.reason === 'kill')) {
      // the kill is released at the kill switch (two people there); the deferred commands go after their delay
      const kid = r.killIds.get(id);
      if (kid) r.kill.release(kid);
      s.clock.advance(60_000);
    } else if (st?.holds.some((h) => h.hold_id === 'mm2')) {
      const x = await ingestItem(s.deps, id, {
        type: ITEM_EVENT.hold_released,
        payload: { hold_id: 'mm2' },
        actor: 'test',
        idempotency_key: `drill-mm2-off:${id}`,
      });
      if (!x.ok) throw new Error(x.error.message);
    } else if (st?.holds.some((h) => h.reason === 'H2')) {
      capacity.grant('H2', 1);
    } else if (w?.kind === 'blocked') {
      const x = await envFixed(s.deps, id, pr('platform-owner'), `drill:${id}`);
      if (!x.ok) throw new Error(x.error.message);
    } else if (w?.kind === 'release_held') {
      const x = await reRequestRelease(s.deps, id, pr('alice'), `drill:${id}`);
      if (!x.ok) throw new Error(x.error.message);
    } else if (w?.kind === 'handoff' && w.stage === 'choice' && st) {
      const h = st.handoffs.find((x) => x.status === 'open');
      const x = await chooseHandoff(s.deps, id, {
        handoff_id: h?.handoff_id as string,
        choice: sc?.choose ?? 'resume',
        by: pr('bob'),
      });
      if (!x.ok) throw new Error(x.error.message);
    } else s.clock.advance(5_000);
  }
  return readItem(s.record.pool, id);
}

const gatesOpened = async (r: Run, id: string) =>
  (
    await rows(
      r,
      `SELECT body ->> 'gate_id' AS g FROM record.record_event WHERE type = $1 AND body ->> 'subject_id' = $2 ORDER BY global_seq`,
      [GATE_EVENT.opened, id],
    )
  ).map((x) => x.g as string);

/** Where the scenario's item must be at the moment of the kill (it was run to its station, then the driver died). */
/* eslint-disable @typescript-eslint/no-explicit-any -- the item's state, asserted field by field below */
const STATIONS: Record<string, (st: any, a: { run: Run; item: Started }) => Promise<void> | void> =
  {
    'at its first gates': (st) =>
      expect(st.waiting).toMatchObject({ kind: 'gates', gates: ['G0', 'G1'] }),
    'in S6 behind X1 with a lease': (st) =>
      expect(st).toMatchObject({
        phase: 'S6',
        waiting: { kind: 'gates', gates: ['X1'] },
        lease: { epoch: 1 },
      }),
    'waiting for the Ready decision': (st) =>
      expect(st.waiting).toEqual({ kind: 'human', what: 'ready' }),
    'with the developer (L8)': (st) =>
      expect(st.waiting).toEqual({ kind: 'human', what: 'human_led' }),
    // the crash is asserted below (the lost command is still out)
    'a command done but its result never recorded': () => undefined,
    clarifying: (st) => expect(st.phase).toBe('Clarifying'),
    'only submitted': (st) =>
      expect(st.outstanding.map((c: { type: string }) => c.type)).toEqual(['run_stage']),
    'parked after three rounds of questions': (st) =>
      expect(st).toMatchObject({
        phase: 'Parked',
        waiting: { kind: 'parked', cause: 'b1_round_limit' },
      }),
    'blocked on a red baseline, remediation item spawned': (st) => {
      expect(st).toMatchObject({
        phase: 'S6',
        waiting: { kind: 'blocked', owner: 'platform_owner' },
      });
      expect(st.spawns[0]).toMatchObject({ edge: 'B6', lane: 'L2' });
    },
    'held at admission for capacity (H2)': (st) =>
      expect(st).toMatchObject({ phase: 'Held', underlying: 'Scheduling' }),
    'handed off (D1), the owner has decided E4 and not yet chosen': (st) =>
      expect(st.handoffs[0]).toMatchObject({ code: 'D1', e4_decided: true }),
    'with a developer who took over (lane L8, lease epoch +1)': (st) =>
      expect(st).toMatchObject({
        lane: 'L8',
        phase: 'S6',
        lease: { epoch: 2 },
        waiting: { kind: 'human', what: 'human_led' },
      }),
    'release held (B26) after G5 was denied': (st) =>
      expect(st).toMatchObject({ phase: 'G5', waiting: { kind: 'release_held' } }),
    'under an MM-2 maintenance hold (timers frozen, drafts kept)': (st) =>
      expect(st).toMatchObject({ phase: 'Held', underlying: 'S1' }),
    // M9.6: the killed project's item is HELD by the kill, with its id as origin
    'in a killed project (kill hold, nothing dispatched)': (st, { run, item }) =>
      expect(st).toMatchObject({
        phase: 'Held',
        holds: [{ hold_id: 'kill', reason: 'kill', origin: run.killIds.get(item.id) }],
      }),
    // M9.5: the tripped lane's new item went to L8
    'in a lane whose circuit breaker (R3) is tripped, routed to L8': (st) =>
      expect(st).toMatchObject({ proposed_lane: 'L8' }),
  };

/* eslint-enable @typescript-eslint/no-explicit-any */

/** One scenario, end to end, in its own database: twin, drill, kill, wipe, refold, restart, finish, compare. */
export async function runScenario(sc: Scenario): Promise<void> {
  await loadReports();
  const s = await startCoreStack();
  try {
    const r: Run = { s, kill: new FakeKillState(() => s.clock.now()), killIds: new Map(), k: 0 };

    // ---- the undisturbed twin
    const controlPorts = new FakeStagePorts();
    const control = await start(r, sc, controlPorts);
    const controlCapacity = new FakeCapacity();
    const cd = driverOver(s, { ports: controlPorts, capacity: controlCapacity });
    if (sc.twinStops && sc.stop) {
      await runItem(s, cd, control.id, { ...sc.stop, passes: sc.passes ?? 80 });
    }
    await finish(r, cd, control.id, sc, controlCapacity);
    expect((await readItem(s.record.pool, control.id))?.state.terminal, sc.name).toBe('Done');

    // ---- the drill: start, run to the station
    const ports = new FakeStagePorts();
    const capacity = new FakeCapacity();
    const item = await start(r, sc, ports);
    const before = { ...driverOver(s, { ports, capacity }), kill: r.kill };
    const stopSpec = sc.stop;
    if (stopSpec !== null) {
      // a scenario that needs answers on its way (rounds of questions) gets them
      for (let round = 0; round < 6; round++) {
        await runItem(s, before, item.id, { ...stopSpec, passes: sc.passes ?? 80 });
        const cur = (await readItem(s.record.pool, item.id))?.state;
        if (!cur || stopSpec?.stop?.(cur) === true) break;
        const w = cur.waiting;
        if (sc.chooseBeforeKill && w?.kind === 'handoff' && w.stage === 'choice') {
          const c = await chooseHandoff(s.deps, item.id, {
            handoff_id: cur.handoffs.find((x) => x.status === 'open')?.handoff_id as string,
            choice: sc.choose ?? 'resume',
            by: pr('bob'),
          });
          if (!c.ok) throw new Error(c.error.message);
          continue;
        }
        const q = cur.questions.find((x) => x.state === 'open');
        if (!q) break;
        const a = await answerQuestion(s.deps, item.id, {
          question_id: q.question_id,
          text: 'the orders table',
          by: pr('alice'),
        });
        if (!a.ok) throw new Error(a.error.message);
      }
      if (sc.killed) {
        r.killIds.set(item.id, r.kill.kill({ kind: 'project', ref: item.project }));
        await driveWork(before);
      }
      if (sc.maintenance) {
        const m = await ingestItem(s.deps, item.id, {
          type: ITEM_EVENT.hold_placed,
          payload: { hold_id: 'mm2', reason: 'maintenance', origin: 'mm-2' },
          actor: 'test',
          idempotency_key: `drill-mm2-on:${item.id}`,
        });
        if (!m.ok) throw new Error(m.error.message);
      }
    }

    // the scenario is where it was meant to be
    const at = async (id: string) => (await readItem(s.record.pool, id))?.state;
    const station = STATIONS[sc.name];
    if (!station) throw new Error(`no station check for scenario "${sc.name}"`);
    const atKill = await at(item.id);
    await station(atKill, { run: r, item });
    let breakersBefore = '';
    if (sc.tripped) {
      expect(await readBreaker(s.record.pool, item.project, 'L3')).toMatchObject({
        tripped: true,
        total: 3,
      });
      breakersBefore = JSON.stringify(await listBreakers(s.record.pool));
    }
    // the crash: the port did the work for 6.1, the stream never heard, so the command is still out
    const lost = sc.crash
      ? ports.coding.calls.find((c) => c.item_id === item.id && c.step === '6.1')
      : undefined;
    if (sc.crash) {
      expect(lost).toBeDefined();
      expect(ports.coding.effects).toContain(lost?.command_key);
      expect(atKill?.outstanding.map((c) => c.key)).toContain(lost?.command_key);
    }
    // the live read model agrees with the record; the repo with the open lease has work in flight
    await expectRebuildEqualsLive(s.record.pool, workItemProjection);
    const flight = new DbWorkInFlight(s.record.pool);
    const leased = sc.name === 'in S6 behind X1 with a lease';
    if (leased) {
      expect(await flight.hasWorkInFlight(item.repo)).toEqual({ ok: true, value: true });
    }

    // ---- the state at the moment of the kill
    const snapshot = JSON.stringify(atKill);
    const outstanding = (atKill?.outstanding.length ?? 0) > 0;
    const outbox = await rows(
      r,
      `SELECT count(*)::int AS n FROM record.outbox WHERE destination = 'work.commands'`,
    );
    if (outstanding) expect(outbox[0]?.n).toBeGreaterThan(0);

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
          r,
          `SELECT count(*)::int AS n FROM record.outbox WHERE destination = 'work.commands'`,
        )
      )[0]?.n,
    ).toBe(0);
    expect((await rows(r, `SELECT count(*)::int AS n FROM core.work_item`))[0]?.n).toBe(0);

    // ---- REFOLD from the record: the item is exactly where it was
    expect(JSON.stringify((await readItem(s.record.pool, item.id))?.state), sc.name).toBe(snapshot);

    // ---- RESTART: a new driver (no memory), the same ports (they are other systems)
    // the breaker is a fold of the record, so nothing of it was wiped
    if (sc.tripped) expect(JSON.stringify(await listBreakers(s.record.pool))).toBe(breakersBefore);
    const after = { ...driverOver(s, { ports, capacity }), kill: r.kill };
    const killedCallsBefore = ports.calls().filter((c) => c.item_id === item.id).length;
    const pass = await driveWork(after);
    // the outstanding commands came back out of the record, with their keys
    if (outstanding) expect(pass.enqueued).toBeGreaterThan(0);
    if (leased) {
      expect(await flight.hasWorkInFlight(item.repo)).toEqual({ ok: true, value: true });
    }
    if (sc.killed) {
      // the kill switch kept its state: after the restart the project is still killed, nothing runs
      await driveWork(after);
      expect(ports.calls().filter((c) => c.item_id === item.id).length).toBe(killedCallsBefore);
      expect(await at(item.id)).toMatchObject({ phase: 'Held', holds: [{ reason: 'kill' }] });
      expect(ports.coding.calls.every((c) => c.item_id !== item.id)).toBe(true);
    }
    await finish(r, after, item.id, sc, capacity);

    // ---- finished, the way the undisturbed twin did
    expect((await at(item.id))?.terminal, sc.name).toBe('Done');
    expect(await signature(r, item.id), sc.name).toEqual(await signature(r, control.id));
    expect(await gatesOpened(r, item.id), sc.name).toEqual(await gatesOpened(r, control.id));

    // ---- nothing was done twice
    if (sc.crash) {
      // the crashed command was asked again after the restart and answered from the port's memory
      const again = ports.coding.calls.filter((c) => c.command_key === lost?.command_key);
      expect(again.length).toBe(2);
      expect(ports.coding.effects.filter((x) => x === lost?.command_key)).toHaveLength(1);
    }
    for (const p of ports.all()) {
      expect(new Set(p.effects).size, p.port).toBe(p.effects.length);
    }
    // every command key has exactly one recorded result
    const ev = await readItemEvents(s.record.pool, item.id);
    const answered = ev.flatMap((e) => {
      const key = (e.payload as { command_key?: string }).command_key;
      return key ? [key] : [];
    });
    expect(new Set(answered).size, `${sc.name}: a command answered twice`).toBe(answered.length);
    // one effect per stage command equals the number of stage results recorded (the item and the
    // linked items it spawned ran on the same ports)
    const ran = [item.id, ...((await at(item.id))?.spawns ?? []).map((l) => l.item_id)];
    let stageResults = 0;
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
  } finally {
    await s.stop();
  }
}

/** Registers the named scenarios as test cases (each its own database; see the header). */
export function registerDrill(group: string, names: readonly string[]): void {
  const picked = names.map((n) => {
    const sc = SCENARIOS.find((x) => x.name === n);
    if (!sc) throw new Error(`no drill scenario named "${n}"`);
    return sc;
  });
  describe(`the rebuild drill: ${group}`, () => {
    for (const sc of picked) {
      it(
        `${sc.name}: kill the driver, wipe the execution state, refold, restart: it resumes and nothing is done twice`,
        () => runScenario(sc),
        120_000,
      );
    }
  });
}

export const SCENARIO_NAMES: readonly string[] = SCENARIOS.map((x) => x.name);
