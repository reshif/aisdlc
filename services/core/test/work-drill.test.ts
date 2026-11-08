import {
  GATE_EVENT,
  ITEM_EVENT,
  type Lane,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { FakeStagePorts } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbWorkInFlight,
  answerQuestion,
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
  return (await readItemEvents(s.record.pool, itemId)).map((e) => {
    const p = e.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const what =
      e.type === ITEM_EVENT.gates_opened
        ? p['gates'].map((g: { gate: string }) => g.gate).join('+')
        : (p['step'] ?? p['gate'] ?? p['outcome'] ?? p['what'] ?? '');
    return `${e.type}:${what}${e.type === ITEM_EVENT.gate_decided ? `:${p['outcome']}` : ''}`;
  });
}

/** Runs an item to its end, answering questions and waiting out a failed command's backoff. */
async function finish(d: ReturnType<typeof driverOver>, id: string) {
  for (let i = 0; i < 12; i++) {
    const item = await runItem(s, d, id);
    if (item?.state.terminal !== null) return item;
    const q = item?.state.questions.find((x) => x.state === 'open' && x.material === 'blocking');
    if (q) {
      const a = await answerQuestion(s.deps, id, {
        question_id: q.question_id,
        text: 'the orders table',
        by: pr('alice'),
      });
      if (!a.ok) throw new Error(a.error.message);
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
    const cd = driverOver(s, { ports: controlPorts });
    for (const c of control) await finish(cd, c.id);
    for (const c of control) {
      expect((await readItem(s.record.pool, c.id))?.state.terminal, c.sc.name).toBe('Done');
    }

    // ---- the drill: start, run each to its station
    const ports = new FakeStagePorts();
    const started = await start(ports);
    const items = started.items;
    const before = driverOver(s, { ports });
    for (const i of [...items]) {
      if (i.sc.stop === null) continue;
      await runItem(s, before, i.id, { ...i.sc.stop, passes: i.sc.passes ?? 80 });
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
    expect((await at(items[6]?.id as string))?.outstanding.map((c) => c.type)).toEqual([
      'run_stage',
    ]);
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
    const after = driverOver(s, { ports });
    const pass = await (await import('../src/index.js')).driveWork(after);
    // the outstanding commands came back out of the record, with their keys
    expect(pass.enqueued).toBeGreaterThan(0);
    expect(await flight.hasWorkInFlight(items[1]?.repo as string)).toEqual({
      ok: true,
      value: true,
    });
    for (const i of items) await finish(after, i.id);

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
    for (const i of items) {
      stageResults += (await readItemEvents(s.record.pool, i.id)).filter((e) =>
        [
          ITEM_EVENT.stage_completed,
          ITEM_EVENT.questions_raised,
          ITEM_EVENT.stage_gate_needed,
        ].includes(e.type as never),
      ).length;
    }
    expect(ports.effects().length).toBe(stageResults);
    // and the rebuilt read model is the live one
    await expectRebuildEqualsLive(s.record.pool, workItemProjection);
  }, 180_000);
});
