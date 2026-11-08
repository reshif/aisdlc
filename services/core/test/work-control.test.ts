import { ITEM_EVENT, MAINTENANCE_HOLD_ID, type Lane, type StageOutcome } from '@aisdlc/contracts';
import { sweepSla } from '@aisdlc/decisions';
import { FakeCapacity, FakeStagePorts } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerQuestion,
  chooseHandoff,
  completeHumanWork,
  decideReady,
  driveWork,
  envFixed,
  handBack,
  ingestItem,
  itemView,
  readItem,
  readItemEvents,
  releaseN8Holds,
  requestWork,
  reRequestRelease,
  submitRequest,
  type WorkDriverDeps,
  type WorkSettings,
  DEFAULT_WORK_SETTINGS,
} from '../src/index.js';
import { pid, pr, startCoreStack, setSlots, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  GATING_ON,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M9.3 and M9.4 on the real record, ledger and Notary: the timers on the business calendar, MM-2, the
// release of HELD items in FIFO order by priority, N8, the owner's choice at E4 bound to the ledger, and
// B21 reusing the decision kernel's SLA sweep. The pure scenarios are packages/work/test.

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
const asks: StageOutcome = {
  outcome: 'questions',
  questions: [{ text: 'Which table?', material: 'blocking' }],
};
const FRIDAY_15 = '2026-11-06T15:00:00.000Z';

let n = 0;
async function newItem(
  o: { lane?: Lane; level?: 'light' | 'full'; gating?: typeof GATING_ON; who?: string[] } = {},
) {
  n += 1;
  const seeded = await seedActivePrr(s, {
    level: o.level ?? 'full',
    gating: o.gating ?? GATING_OFF,
  });
  approvers(s, seeded.project, o.who ?? ['bob']);
  const r = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: o.lane ?? 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `control test request ${n}`,
    }),
  );
  return { ...seeded, itemId: r.item_id as string };
}
const state = async (id: string) => (await readItem(s.record.pool, id))?.state;

/** Drives until the item asked three rounds of questions and is parked (answering the first two). */
async function parkIt(d: WorkDriverDeps, id: string) {
  for (let i = 0; i < 10; i++) {
    await runItem(s, d, id, { stop: (st) => st.phase === 'Clarifying' || st.phase === 'Parked' });
    const st = await state(id);
    if (st?.phase === 'Parked') return st;
    const q = st?.questions.find((x) => x.state === 'open');
    if (q)
      ok(
        await answerQuestion(s.deps, id, {
          question_id: q.question_id,
          text: 'orders',
          by: pr('alice'),
        }),
      );
  }
  throw new Error('did not park');
}

const mmSettings =
  (flag: { on: boolean }): (() => WorkSettings) =>
  () => ({
    ...DEFAULT_WORK_SETTINGS,
    maintenance: () => flag.on,
  });

describe('the timers run on the business calendar and the catalogue limits (PARK 5 bd, item age 10 bd)', () => {
  it('PARK: five business days over a weekend, then ABANDONED with park.timeout; not a second earlier', async () => {
    s.clock.set(FRIDAY_15);
    const it1 = await newItem({ lane: 'L4', level: 'full' });
    const ports = new FakeStagePorts();
    ports.planning.script((r) => (r.step === '1.5' ? asks : undefined));
    const d = driverOver(s, { ports });
    const parked = await parkIt(d, it1.itemId);
    const since = Date.parse(parked.park?.since as string);
    // Friday 15:00 + 5 business days = Friday 15:00 the week after
    const due = Date.parse('2026-11-13T15:00:00.000Z');
    expect(since).toBeLessThanOrEqual(Date.parse(FRIDAY_15) + 60_000);
    s.clock.set(new Date(due - 60_000 * 5).toISOString());
    await driveWork(d);
    expect((await state(it1.itemId))?.terminal).toBeNull();
    s.clock.set(new Date(Math.max(due, since + 1) + 5 * 60_000).toISOString());
    const report = await driveWork(d);
    expect(report.timers_fired).toBeGreaterThan(0);
    const end = await state(it1.itemId);
    expect(end).toMatchObject({ terminal: 'Abandoned', terminal_cause: 'park.timeout' });
    // the requester reads the cause from the item
    expect(itemView(end as never).terminal_cause).toBe('park.timeout');
    // a repeat pass does nothing more
    expect((await driveWork(d)).timers_fired).toBe(0);
  });

  it('item age over the catalogue limit is straight to E4 (B28), counted toward ET14', async () => {
    s.clock.set(FRIDAY_15);
    const it1 = await newItem({ lane: 'L3', gating: GATING_ON, level: 'full' });
    const d = driverOver(s);
    await driveWork(d);
    // 10 business days after Friday 15:00 is Friday 15:00 two weeks on
    s.clock.set('2026-11-20T14:00:00.000Z');
    await driveWork(d);
    expect((await state(it1.itemId))?.handoffs).toHaveLength(0);
    s.clock.set('2026-11-20T16:00:00.000Z');
    await driveWork(d);
    const st = await state(it1.itemId);
    expect(st?.clock.age_exceeded).toBe(true);
    expect(st?.phase).toBe('Handoff');
    expect(st?.handoffs[0]).toMatchObject({ code: 'E4', trigger: 'B28' });
    expect(st?.et14['rework_budget']).toBe(1);
  });
});

describe('MM-2: timers frozen, decisions disabled, drafts kept', () => {
  it('holds every active item, makes no new item, refuses the decisions, and releases them all when it ends', async () => {
    s.clock.set(FRIDAY_15);
    const flag = { on: false };
    const it1 = await newItem({ lane: 'L4', gating: GATING_ON, level: 'full' });
    const d: WorkDriverDeps = { ...driverOver(s), settings: mmSettings(flag) };
    await runItem(s, d, it1.itemId, { decide: () => 'hold', stop: (q) => q.gates.length > 0 });
    const before = await state(it1.itemId);
    const openGates = before?.gates.filter((g) => g.status === 'pending') ?? [];
    expect(openGates.length).toBeGreaterThan(0);

    flag.on = true;
    // a request that arrives under maintenance waits, admitted, with no item
    const other = await seedActivePrr(s, { level: 'light', gating: GATING_OFF });
    approvers(s, other.project);
    // (a request whose item the driver makes: admitted before, picked up by the driver pass)
    const late = ok(
      await requestWork(s.deps, {
        project_id: pid(other.project),
        repo: other.repo,
        lane: 'L3',
        requester: pr('alice'),
      }),
    );
    expect(late.item_id ?? null).toBeNull();
    const r1 = await driveWork(d);
    expect(r1).toMatchObject({ maintenance: true });
    expect(r1.maintenance_holds).toBeGreaterThan(0);
    const held = await state(it1.itemId);
    expect(held).toMatchObject({ phase: 'Held' });
    expect(held?.holds.map((h) => h.hold_id)).toEqual([MAINTENANCE_HOLD_ID]);
    expect(held?.holds[0]).toMatchObject({ reason: 'maintenance', origin: 'mm-2' });
    // the drafts (the open gates) are kept
    expect(held?.gates.filter((g) => g.status === 'pending')).toHaveLength(openGates.length);
    // the repeat pass places nothing new
    expect((await driveWork(d)).maintenance_holds).toBe(0);

    // decisions are disabled at the kernel: the gate cannot be decided
    const kernel = { ...s.config, maintenance: () => flag.on };
    const gate = openGates[0]?.gate_instance_id as string;
    const { prepare, recordEvidenceViewed, decide } = await import('@aisdlc/decisions');
    const p = await prepare(kernel, { gate_instance_id: gate, principal: pr('bob') });
    if (p.ok) {
      await recordEvidenceViewed(kernel, {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash,
      });
      const dec = await decide(kernel, { nonce: p.value.nonce, decision: 'approve' });
      expect(!dec.ok && dec.error.code).toBe('maintenance');
    }
    // the Ready decision of the work lifecycle too
    const ready = await decideReady(
      { ...s.deps, maintenance: () => flag.on },
      it1.itemId,
      pr('alice'),
    );
    expect(!ready.ok && ready.error.code).toBe('refused');

    // and no item came out of the request that waited under maintenance
    expect(
      (
        await s.record.pool.query(`SELECT 1 FROM core.work_item WHERE request_id = $1`, [
          late.request_id,
        ])
      ).rowCount,
    ).toBe(0);

    flag.on = false;
    const r2 = await driveWork(d);
    expect(r2).toMatchObject({ maintenance: false });
    expect(r2.maintenance_holds).toBeGreaterThan(0);
    const after = await state(it1.itemId);
    expect(after?.holds).toHaveLength(0);
    expect(after?.phase).toBe(before?.phase);
    expect(after?.clock.frozen_ms).toBeGreaterThanOrEqual(0);
    // the item the request waited for is made now, and a second maintenance is a new hold with its own key
    expect(
      (
        await s.record.pool.query(`SELECT 1 FROM core.work_item WHERE request_id = $1`, [
          late.request_id,
        ])
      ).rowCount,
    ).toBe(1);
    flag.on = true;
    await driveWork(d);
    expect((await state(it1.itemId))?.holds).toHaveLength(1);
    flag.on = false;
    await driveWork(d);
    expect((await state(it1.itemId))?.holds).toHaveLength(0);
    const evs = await readItemEvents(s.record.pool, it1.itemId);
    const keys = evs
      .filter((e) => e.idempotency_key?.startsWith('mm2:'))
      .map((e) => e.idempotency_key);
    expect(keys).toEqual(['mm2:placed:1', 'mm2:released:1', 'mm2:placed:2', 'mm2:released:2']);
  });

  it('the time an item spends under maintenance moves its timers back by exactly that', async () => {
    s.clock.set(FRIDAY_15);
    const flag = { on: false };
    const it1 = await newItem({ lane: 'L4', level: 'full' });
    const ports = new FakeStagePorts();
    ports.planning.script((r) => (r.step === '1.5' ? asks : undefined));
    const d: WorkDriverDeps = { ...driverOver(s, { ports }), settings: mmSettings(flag) };
    const parked = await parkIt(d, it1.itemId);
    const since = Date.parse(parked.park?.since as string);
    // two days of maintenance in the middle of the park
    s.clock.set(new Date(since + 86_400_000).toISOString());
    flag.on = true;
    await driveWork(d);
    s.clock.set(new Date(since + 3 * 86_400_000).toISOString());
    await driveWork(d);
    expect((await state(it1.itemId))?.terminal).toBeNull();
    flag.on = false;
    await driveWork(d);
    const st = await state(it1.itemId);
    expect(st?.clock.frozen_ms).toBe(2 * 86_400_000);
    // without the freeze the park would have ended at Friday 15:00 the week after; with it, two days later
    const plain = Date.parse('2026-11-13T15:00:00.000Z');
    s.clock.set(new Date(plain + 3600_000).toISOString());
    await driveWork(d);
    expect((await state(it1.itemId))?.terminal).toBeNull();
    s.clock.set(new Date(plain + 2 * 86_400_000 + 3600_000).toISOString());
    await driveWork(d);
    expect((await state(it1.itemId))?.terminal).toBe('Abandoned');
  });
});

describe('HELD at admission: FIFO by priority, released only by capacity', () => {
  it('releases per reason in lane priority then hold order; one at a time as capacity is granted', async () => {
    // three items on the same fake stages, each refused H2 at its first admission
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.0' && r.attempt === 1 ? { outcome: 'held', reason: 'H2' } : undefined,
    );
    const capacity = new FakeCapacity();
    const d: WorkDriverDeps = { ...driverOver(s, { ports }), capacity };
    const a = await newItem({ lane: 'L3' });
    const b = await newItem({ lane: 'L1' });
    const c = await newItem({ lane: 'L3' });
    for (const x of [a, b, c]) {
      await runItem(s, d, x.itemId, { stop: (st) => st.phase === 'Held' });
    }
    for (const x of [a, b, c]) {
      expect(await state(x.itemId)).toMatchObject({ phase: 'Held', underlying: 'Scheduling' });
      expect((await state(x.itemId))?.holds[0]).toMatchObject({ reason: 'H2' });
    }
    // nothing is free: nothing is released, and a kill hold is never the loop's to release
    await driveWork(d);
    for (const x of [a, b, c]) expect((await state(x.itemId))?.phase).toBe('Held');

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      capacity.grant('H2', 1);
      await driveWork(d);
      const free = [a, b, c].filter((x) => !order.includes(x.itemId));
      const out = [];
      for (const x of free) if ((await state(x.itemId))?.holds.length === 0) out.push(x.itemId);
      expect(out).toHaveLength(1);
      order.push(out[0] as string);
    }
    // L1 outranks L3 (the catalogue's lane order), then the two L3 items in the order they were held
    expect(order).toEqual([b.itemId, a.itemId, c.itemId]);
    // a released item asked for admission again and went on
    for (const x of [a, b, c]) {
      const done = await runItem(s, d, x.itemId);
      expect(done?.state.terminal).toBe('Done');
    }
  });

  it('a capacity that is down, or a missing capacity port, releases nothing; a kill hold is not an admission hold', async () => {
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.0' && r.attempt === 1 ? { outcome: 'held', reason: 'WIP' } : undefined,
    );
    const capacity = new FakeCapacity().grant('WIP', 5).breakIt();
    const d: WorkDriverDeps = { ...driverOver(s, { ports }), capacity };
    const x = await newItem({ lane: 'L3' });
    await runItem(s, d, x.itemId, { stop: (st) => st.phase === 'Held' });
    await driveWork(d);
    expect((await state(x.itemId))?.phase).toBe('Held');
    await driveWork({ ...d, capacity: undefined as never });
    expect((await state(x.itemId))?.phase).toBe('Held');
    capacity.breakIt(false);
    // a kill hold on top: released admission hold, the item stays held by the kill
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.hold_placed,
        payload: { hold_id: 'kill-1', reason: 'kill', origin: 'ctl-1' },
        actor: 'test',
        idempotency_key: 'kill-1',
      }),
    );
    await driveWork(d);
    const st = await state(x.itemId);
    expect(st?.holds.map((h) => h.hold_id)).toEqual(['kill-1']);
    expect(st?.phase).toBe('Held');
  });
});

describe('N8: released when an M4 makes a PRR active', () => {
  it('a held item whose repo has an active PRR is released, and 1.4 runs again', async () => {
    const x = await newItem({ lane: 'L3' });
    const it0 = await readItem(s.record.pool, x.itemId);
    const run13 = it0?.state.outstanding[0];
    expect(run13?.type).toBe('run_stage');
    // the executor's answers for 1.3, then 1.4: N8 (as if no record were active then)
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.stage_completed,
        payload: {
          command_key: (run13 as { key: string }).key,
          step: '1.3',
          output_hash: 'a'.repeat(64),
          lane: 'L3',
        },
        actor: 'test',
        idempotency_key: 'n8-13',
      }),
    );
    const elig = (await state(x.itemId))?.outstanding.find((c) => c.type === 'check_eligibility');
    expect(elig).toBeDefined();
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.eligibility_checked,
        payload: {
          command_key: (elig as { key: string }).key,
          lane: 'L3',
          route: 'n8_hold',
          eligible: false,
          reason: 'no_active_prr',
          prr_version: null,
        },
        actor: 'test',
        idempotency_key: 'n8-14',
      }),
    );
    expect((await state(x.itemId))?.holds[0]).toMatchObject({ reason: 'N8' });
    const rel = await releaseN8Holds({ pool: s.record.pool, clock: s.clock }, [x.itemId]);
    expect(rel.released).toEqual([x.itemId]);
    const d = driverOver(s);
    const done = await runItem(s, d, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    const checks = (await readItemEvents(s.record.pool, x.itemId)).filter(
      (e) => e.type === ITEM_EVENT.eligibility_checked,
    );
    expect(checks).toHaveLength(2);
  });
});

describe('BLOCKED, DECLINED, RELHOLD through the driver', () => {
  it('B6: the item is blocked, an L2 remediation item is a SpawnLink of its own, "env fixed" goes on at 6.1', async () => {
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.2' && r.attempt === 1
        ? { outcome: 'rework', edge: 'B6', reason_code: 'red_baseline' }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const x = await newItem({ lane: 'L3' });
    const st = (await runItem(s, d, x.itemId, { stop: (q) => q.waiting?.kind === 'blocked' }))
      ?.state;
    expect(st?.waiting).toMatchObject({ kind: 'blocked', owner: 'platform_owner' });
    await driveWork(d);
    const origin = await state(x.itemId);
    expect(origin?.spawns).toHaveLength(1);
    expect(origin?.spawns[0]).toMatchObject({ edge: 'B6', kind: 'remediation', lane: 'L2' });
    const child = await state(origin?.spawns[0]?.item_id as string);
    expect(child).toMatchObject({ proposed_lane: 'L2', channel: 'N6' });
    expect(child?.origin).toMatchObject({
      origin_item_id: x.itemId,
      edge: 'B6',
      kind: 'remediation',
    });
    ok(await envFixed({ ...s.deps }, x.itemId, pr('platform-owner'), 'f1'));
    const done = await runItem(s, d, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(ports.coding.calls.filter((c) => c.step === '6.1')).toHaveLength(2);
  });

  it('B22: G0 rejected declines the item and the requester reads the cause code', async () => {
    const x = await newItem({ lane: 'L4', gating: GATING_ON, level: 'full' });
    const d = driverOver(s);
    const done = await runItem(s, d, x.itemId, { decide: (g) => (g === 'G0' ? 'reject' : 'hold') });
    expect(done?.state).toMatchObject({ terminal: 'Declined', terminal_cause: 'b22.g0_rejected' });
    expect(itemView(done?.state as never)).toMatchObject({
      terminal: 'Declined',
      terminal_cause: 'b22.g0_rejected',
    });
  });

  it('B26: release denied holds the item, a re-request opens G5 again, "needs change" is a NEW item', async () => {
    const x = await newItem({ lane: 'L4', gating: GATING_ON, level: 'full' });
    const d = driverOver(s);
    const opts = {
      decide: (g: string) => (g === 'G5' ? ('reject' as const) : ('approve' as const)),
    };
    const held = (
      await runItem(s, d, x.itemId, { ...opts, stop: (q) => q.waiting?.kind === 'release_held' })
    )?.state;
    expect(held).toMatchObject({ phase: 'G5', waiting: { kind: 'release_held' } });
    ok(await reRequestRelease(s.deps, x.itemId, pr('alice'), 'rr1'));
    const again = (
      await runItem(s, d, x.itemId, {
        ...opts,
        stop: (q) =>
          q.gates.filter((g) => g.gate === 'G5').length >= 2 && q.waiting?.kind === 'release_held',
      })
    )?.state;
    expect(again?.gates.filter((g) => g.gate === 'G5')).toHaveLength(2);
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.spawn_requested,
        payload: { edge: 'B26', kind: 'release_change', lane: 'L1', index: 0 },
        actor: 'alice',
        idempotency_key: 'b26-1',
      }),
    );
    await driveWork(d);
    const after = await state(x.itemId);
    expect(after?.spawns[0]).toMatchObject({ edge: 'B26', kind: 'release_change' });
    expect(after?.waiting).toMatchObject({ kind: 'release_held' });
  });
});

describe('ABANDONED validates its cause code', () => {
  it('refuses a cause that is not a code, and records one that is', async () => {
    const x = await newItem({ lane: 'L4', gating: GATING_ON, level: 'full' });
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.hold_placed,
        payload: { hold_id: 'k', reason: 'kill', origin: 'c' },
        actor: 'test',
        idempotency_key: 'ab-k',
      }),
    );
    const bad = await ingestItem(s.deps, x.itemId, {
      type: ITEM_EVENT.abandoned,
      payload: { cause: 'Not A Code!', by: 'alice' },
      actor: 'alice',
      idempotency_key: 'ab-bad',
    });
    expect(bad.ok).toBe(false);
    expect((await state(x.itemId))?.terminal).toBeNull();
    ok(
      await ingestItem(s.deps, x.itemId, {
        type: ITEM_EVENT.abandoned,
        payload: { cause: 'owner.no_longer_needed', by: 'alice' },
        actor: 'alice',
        idempotency_key: 'ab-good',
      }),
    );
    expect(await state(x.itemId)).toMatchObject({
      terminal: 'Abandoned',
      terminal_cause: 'owner.no_longer_needed',
    });
  });
});

describe('E4: the choice is bound to the ledger', () => {
  const handedOff = async (name: string, who = ['bob'], times = 1) => {
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.4' && r.attempt <= times
        ? { outcome: 'trigger', trigger: 'ET1', reason_code: name }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const x = await newItem({ lane: 'L3', who });
    await runItem(s, d, x.itemId, {
      stop: (q) => q.waiting?.kind === 'handoff' && q.waiting.stage === 'e4',
    });
    const st = await state(x.itemId);
    return { ...x, d, ports, handoff: st?.handoffs[0] };
  };

  it('refuses a choice until E4 is decided in the ledger, and from anyone but who decided it', async () => {
    const h = await handedOff('e4');
    expect(h.handoff).toMatchObject({ code: 'D1', trigger: 'ET1', e4_decided: false });
    const hid = h.handoff?.handoff_id as string;
    const early = await chooseHandoff(s.deps, h.itemId, {
      handoff_id: hid,
      choice: 'resume',
      by: pr('bob'),
    });
    expect(!early.ok && early.error.code).toBe('refused');
    // the owner of record decides E4 (a gate, through the kernel)
    const e4 = (await state(h.itemId))?.gates.find((g) => g.gate === 'E4');
    expect(e4?.status).toBe('pending');
    ok(await decideGate(s, e4?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(h.d);
    expect((await state(h.itemId))?.handoffs[0]?.e4_decided).toBe(true);
    const stranger = await chooseHandoff(s.deps, h.itemId, {
      handoff_id: hid,
      choice: 'resume',
      by: pr('carol'),
    });
    expect(!stranger.ok && stranger.error.code).toBe('forbidden');
    // MM-2: no choice while maintenance is on
    const mm = await chooseHandoff({ ...s.deps, maintenance: () => true }, h.itemId, {
      handoff_id: hid,
      choice: 'resume',
      by: pr('bob'),
    });
    expect(!mm.ok && mm.error.code).toBe('refused');
    ok(await chooseHandoff(s.deps, h.itemId, { handoff_id: hid, choice: 'resume', by: pr('bob') }));
    const done = await runItem(s, h.d, h.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.handoffs[0]).toMatchObject({
      status: 'chosen',
      choice: 'resume',
      chosen_by: 'bob',
    });
    // the same choice again is the same choice
    const again = await chooseHandoff(s.deps, h.itemId, {
      handoff_id: hid,
      choice: 'resume',
      by: pr('bob'),
    });
    expect(again.ok === false).toBe(true);
  });

  it('a developer takes over (lane L8, lease epoch +1), hands back once, and the second hand-back is refused', async () => {
    const h = await handedOff('takeover', ['bob'], 2);
    const hid = h.handoff?.handoff_id as string;
    const e4 = (await state(h.itemId))?.gates.find((g) => g.gate === 'E4');
    ok(await decideGate(s, e4?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(h.d);
    const epoch = (await state(h.itemId))?.lease_seq as number;
    ok(
      await chooseHandoff(s.deps, h.itemId, { handoff_id: hid, choice: 'takeover', by: pr('bob') }),
    );
    const t = await state(h.itemId);
    expect(t).toMatchObject({ lane: 'L8', phase: 'S6', lease: { epoch: epoch + 1 } });
    ok(await handBack(s.deps, h.itemId, pr('dev'), false, 'hb1'));
    expect(await state(h.itemId)).toMatchObject({ lane: 'L3', phase: 'S6' });
    // one signal, one effect
    ok(await handBack(s.deps, h.itemId, pr('dev'), false, 'hb1'));
    const evs = await readItemEvents(s.record.pool, h.itemId);
    expect(evs.filter((e) => e.type === ITEM_EVENT.hand_back)).toHaveLength(1);
    const done = await runItem(s, h.d, h.itemId, {
      stop: (q) =>
        q.waiting?.kind === 'handoff' && q.waiting.stage === 'e4' && q.handoffs.length > 1,
    });
    expect(done?.state.terminal ?? null).toBeNull();
    void completeHumanWork;
  });
});

describe("B21: the decision kernel's SLA sweep is reused, and never approves", () => {
  it('a gate of an item pending past one business day is escalated to the backup; the item does not move', async () => {
    s.clock.set(FRIDAY_15);
    const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_ON });
    setSlots(s, seeded.project, {
      admin: ['root'],
      requesters: ['bob'],
      intent: ['bob'],
      design: ['bob'],
      g4: ['bob'],
      g5: ['bob'],
      x: ['bob'],
      sec: ['bob'],
      m4: ['bob'],
      kill: ['bob'],
    });
    s.elig.setPolicy(pid(seeded.project), { tier: 'T1', two_person: { enabled: false } });
    const r = ok(
      await submitRequest(s.deps, {
        project_id: pid(seeded.project),
        repo: seeded.repo,
        lane: 'L4',
        requester: pr('alice'),
        channel: 'N1',
        text: 'sla request',
      }),
    );
    const d = driverOver(s);
    await runItem(s, d, r.item_id as string, {
      decide: () => 'hold',
      stop: (q) => q.gates.length > 0,
    });
    const before = await state(r.item_id as string);
    expect(before?.waiting).toMatchObject({ kind: 'gates' });
    // Friday 15:00 + 1 business day: Monday 15:00
    s.clock.set('2026-11-09T15:00:00.000Z');
    const sweep = await sweepSla({ ...s.config, backupSlot: 'admin' });
    expect(sweep.ok).toBe(true);
    if (!sweep.ok) return;
    // (other tests of this file left cards open too: look at this item's own gates)
    const mine = sweep.value.escalated.filter((e) =>
      before?.gates.some((g) => g.gate_instance_id === e.gate_instance_id),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.backup).toEqual(['root']);
    const after = await state(r.item_id as string);
    expect(after?.waiting).toEqual(before?.waiting);
    expect(after?.gates.every((g) => g.status === 'pending')).toBe(true);
    expect(after?.cursor).toBe(before?.cursor);
    // and nothing was approved: no decision entry for the item's gates
    const dec = await s.record.pool.query(
      `SELECT 1 FROM ledger.ledger_entry WHERE entry_type = 'decision' AND subject_id = $1`,
      [r.item_id],
    );
    expect(dec.rowCount).toBe(0);
  });
});

describe('assumptions reach the item from a planner output', () => {
  it('a stage output that carries assumptions raises them once, with the run that produced them', async () => {
    const ports = new FakeStagePorts();
    const h = 'a'.repeat(64);
    ports.planning.script((r) =>
      r.step === '3.2'
        ? {
            outcome: 'completed',
            output_hash: 'b'.repeat(64),
            assumptions: [{ kind: 'spec', text_hash: h as never }],
          }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const x = await newItem({ lane: 'L3' });
    const done = await runItem(s, d, x.itemId);
    expect(done?.state.assumptions).toHaveLength(1);
    expect(done?.state.assumptions[0]).toMatchObject({
      origin: 'agent_output',
      kind: 'spec',
      text_hash: h,
    });
    expect(itemView(done?.state as never).assumptions).toHaveLength(1);
  });
});
