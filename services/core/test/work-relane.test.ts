import { releasedCatalogues, currentCatalogueRef } from '@aisdlc/catalogue';
import { BREAKER_EVENT, ITEM_EVENT, breakerStream, repoIdOf, type Lane } from '@aisdlc/contracts';
import { deterministicId } from '@aisdlc/kernel';
import { FakeStagePorts } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyGuard,
  breakerThreshold,
  chooseHandoff,
  createItemIn,
  driveWork,
  foldBreaker,
  ingestItem,
  inCoreTx,
  listBreakers,
  lockKeys,
  overdueFollowUps,
  projectGuard,
  readBreaker,
  readBreakerEvents,
  readItem,
  recordBreakerSignal,
  requestBreakerReset,
  requestWork,
  settleBreakerResets,
  submitRequest,
} from '../src/index.js';
import { governingPrr } from '../src/fold.js';
import { repoIdentity } from '../src/prr-store.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  actFor,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
  type Seeded,
} from './work-fixtures.js';

// M9.5 in core: R1 and R2 through the driver and the decision kernel, the R3 breaker (counting, tripping,
// routing new items to L8, the human reset through an M5 gate), R4's overdue block, and an item pinned
// to an older catalogue running to the end. Real Postgres, ledger and Notary.

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
const state = async (id: string) => (await readItem(s.record.pool, id))?.state;
let n = 0;

async function seeded(level: 'light' | 'full' = 'full'): Promise<Seeded> {
  const x = await seedActivePrr(s, { level, gating: GATING_OFF });
  approvers(s, x.project, ['bob']);
  return x;
}
async function request(x: Seeded, lane: Lane, create_item = true) {
  n += 1;
  return ok(
    await requestWork(s.deps, {
      project_id: pid(x.project),
      repo: x.repo,
      lane,
      requester: pr('alice'),
      request_id: `relane-${n}`,
      create_item,
    }),
  );
}
const item = async (x: Seeded, lane: Lane) => {
  const r = await request(x, lane);
  return { ...r, itemId: r.item_id as string };
};

describe('R1 and R2 through the driver', () => {
  it('R1: a stage says the work needs more; the item goes up, free and logged, and finishes', async () => {
    const x = await seeded();
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.5' && r.attempt === 1
        ? {
            outcome: 'relane',
            edge: 'R1',
            trigger: 'new_dependency',
            to_lane: 'L4',
            reason_code: 't',
          }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const it1 = await item(x, 'L3');
    const done = await runItem(s, d, it1.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.lane).toBe('L4');
    expect(done?.state.relanes).toMatchObject([
      {
        edge: 'R1',
        trigger: 'new_dependency',
        from_lane: 'L3',
        to_lane: 'L4',
        step: '6.5',
        target: '2.1',
      },
    ]);
    // S2 ran once, S3 (done) was not run again, and the build ran twice
    const steps = ports.calls().map((c) => c.step);
    expect(steps.filter((q) => q === '2.1')).toHaveLength(1);
    expect(steps.filter((q) => q === '3.1')).toHaveLength(1);
    expect(steps.filter((q) => q === '6.1')).toHaveLength(2);
    // no E1 for an upshift
    const gates = await s.record.pool.query(
      `SELECT body ->> 'gate_id' AS g FROM record.record_event WHERE type = 'gate.opened' AND body ->> 'subject_id' = $1`,
      [it1.itemId],
    );
    expect(gates.rows.map((r) => r.g)).not.toContain('E1');
    // a replay of the whole stream gives the same state (the record is the truth)
    const again = await readItem(s.record.pool, it1.itemId);
    expect(JSON.stringify(again?.state)).toBe(JSON.stringify(done?.state));
  });

  it('R1 into a lane the project may not run goes to E4, not up', async () => {
    const x = await seeded('light'); // L4 is closed at Light
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.5' && r.attempt === 1
        ? { outcome: 'relane', edge: 'R1', trigger: 'cross_repo', to_lane: 'L4', reason_code: 't' }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const it1 = await item(x, 'L3');
    await runItem(s, d, it1.itemId, {
      stop: (q) => q.waiting?.kind === 'handoff' && q.waiting.stage === 'e4',
    });
    const st = await state(it1.itemId);
    expect(st?.lane).toBe('L3');
    expect(st?.relanes).toEqual([]);
    expect(st?.handoffs[0]).toMatchObject({ code: 'E4', trigger: 'R1' });
  });

  it('R2: needs E1, a person decides it, then G0 runs again on the lower lane', async () => {
    const x = await seeded();
    const ports = new FakeStagePorts();
    ports.planning.script((r) =>
      r.step === '2.3' && r.attempt === 1
        ? {
            outcome: 'relane',
            edge: 'R2',
            trigger: 'smaller_than_lane',
            to_lane: 'L3',
            reason_code: 't',
          }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const it1 = await item(x, 'L4');
    // it stops at E1: nothing is downshifted until the decision is in the ledger
    await runItem(s, d, it1.itemId, {
      decide: (g) => (g === 'E1' ? 'hold' : 'approve'),
      stop: (q) => q.gates.some((g) => g.gate === 'E1' && g.status === 'pending'),
    });
    let st = await state(it1.itemId);
    expect(st?.lane).toBe('L4');
    expect(st?.relanes).toEqual([]);
    const done = await runItem(s, d, it1.itemId);
    st = done?.state;
    expect(
      st?.terminal,
      JSON.stringify([st?.waiting, st?.phase, st?.outstanding, st?.ignored]),
    ).toBe('Done');
    expect(st?.lane).toBe('L3');
    expect(st?.relanes).toMatchObject([
      { edge: 'R2', from_lane: 'L4', to_lane: 'L3', target: '1.3' },
    ]);
    const ledger = await s.record.pool.query(
      `SELECT gate_id, decision, actor FROM ledger.ledger_entry WHERE entry_type = 'decision' AND subject_id = $1`,
      [it1.itemId],
    );
    expect(ledger.rows.filter((r) => r.gate_id === 'E1')).toMatchObject([
      { decision: 'approve', actor: 'bob' },
    ]);
  });

  it('R2 denied: the item stays in its lane', async () => {
    const x = await seeded();
    const ports = new FakeStagePorts();
    ports.planning.script((r) =>
      r.step === '2.3' && r.attempt === 1
        ? {
            outcome: 'relane',
            edge: 'R2',
            trigger: 'smaller_than_lane',
            to_lane: 'L3',
            reason_code: 't',
          }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const it1 = await item(x, 'L4');
    const done = await runItem(s, d, it1.itemId, {
      decide: (g) => (g === 'E1' ? 'reject' : 'approve'),
    });
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.lane).toBe('L4');
    expect(done?.state.relanes).toEqual([]);
  });
});

describe('an item pinned to an older catalogue runs to the end', () => {
  it('1.1.0 is not the current catalogue, and the item still finishes, on its own catalogue', async () => {
    const x = await seeded();
    const old = releasedCatalogues().find((r) => r.version === '1.1.0');
    expect(old).toBeDefined();
    expect(old?.hash).not.toBe(currentCatalogueRef().hash);
    n += 1;
    const itemId = deterministicId<'WorkItem'>(`pinned-test:${n}`);
    ok(
      await inCoreTx(s.deps, async (j, tx) => {
        await lockKeys(tx, [`repo:${x.repo.toLowerCase()}`]);
        const id = await repoIdentity(tx, x.repo);
        const prr = governingPrr(await j.prr(id!.project_id, id!.repo_id));
        return createItemIn(j, tx, s.deps, {
          item_id: itemId,
          request: {
            request_id: deterministicId<'WorkRequest'>(`pinned-req:${n}`),
            project_id: pid(x.project),
            repo: x.repo,
            requester: pr('alice'),
            channel: 'N1',
          },
          prr: prr!,
          proposed_lane: 'L3',
          intake: {
            text_sha256: null,
            injection: null,
            dedupe_links: [],
            conflict_candidates: [],
            route: 'normal',
            eligibility_reason: 'eligible',
          },
          origin: null,
          actor: 'test',
          ...(old ? { catalogue_ref: old } : {}),
        });
      }),
    );
    const d = driverOver(s);
    const done = await runItem(s, d, itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.catalogue_ref).toEqual(old);
    const row = await s.record.pool.query(
      `SELECT catalogue_version, pin_unavailable FROM core.work_item WHERE item_id = $1`,
      [itemId],
    );
    expect(row.rows[0]).toEqual({ catalogue_version: '1.1.0', pin_unavailable: false });
  });
});

describe('R3: the circuit breaker, per project and lane', () => {
  const threshold = (): number => breakerThreshold() as number;

  /** An L3 item that is handed off (D1 -> E4) and abandoned by its owner: one count toward ET14. */
  async function abandoned(x: Seeded, lane: Lane = 'L3') {
    const ports = new FakeStagePorts();
    ports.coding.script((r) =>
      r.step === '6.4' && r.attempt === 1
        ? { outcome: 'trigger', trigger: 'ET1', reason_code: 'r3' }
        : undefined,
    );
    const d = driverOver(s, { ports });
    const it1 = await item(x, lane);
    await runItem(s, d, it1.itemId, {
      stop: (q) => q.waiting?.kind === 'handoff' && q.waiting.stage === 'e4',
    });
    const st = await state(it1.itemId);
    const e4 = st?.gates.find((g) => g.gate === 'E4');
    ok(await decideGate(s, e4?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(d);
    ok(
      await chooseHandoff(s.deps, it1.itemId, {
        handoff_id: st?.handoffs[0]?.handoff_id as string,
        choice: 'abandon',
        by: pr('bob'),
      }),
    );
    await driveWork(d);
    await driveWork(d);
    return it1.itemId;
  }

  it('the threshold is the catalogue ET14 `trip` (3), not a number in the engine', () => {
    expect(threshold()).toBe(3);
  });

  it('counts E4 abandons, trips at the threshold, and sends NEW items of that project and lane to L8', async () => {
    const x = await seeded();
    const other = await seeded();
    for (let i = 0; i < threshold() - 1; i++) await abandoned(x);
    let b = await readBreaker(s.record.pool, x.project, 'L3');
    expect(b).toMatchObject({ total: threshold() - 1, tripped: false, counts: { E4_abandon: 2 } });
    // not tripped yet: a new L3 item is a normal one
    expect((await request(x, 'L3', false)).verdict).toMatchObject({ route: 'normal' });
    await abandoned(x);
    b = await readBreaker(s.record.pool, x.project, 'L3');
    expect(b).toMatchObject({ total: threshold(), tripped: true, threshold: threshold() });
    // per project and lane: another lane and another project are untouched
    expect((await request(x, 'L4', false)).verdict.route).toBe('normal');
    expect((await request(other, 'L3', false)).verdict.route).toBe('normal');
    // the tripped lane routes new items to L8, with the reason
    const r = await request(x, 'L3');
    expect(r.verdict).toMatchObject({ route: 'l8', eligible: false, reason: 'circuit_breaker' });
    expect(r.state).toBe('routed_l8');
    const made = await state(r.item_id as string);
    expect(made?.proposed_lane).toBe('L8');
    // the breaker is a fold of its stream: nothing else holds the count
    const f = foldBreaker(await readBreakerEvents(s.record.pool, x.project, 'L3'));
    expect(f).toMatchObject({ total: threshold(), tripped: true, resets: 0 });
    expect(
      (await listBreakers(s.record.pool)).find(
        (q) => q.project_id === x.project && q.lane === 'L3',
      ),
    ).toMatchObject({ tripped: true });
  });

  it('every input counts once per key, and Q1 counts too', async () => {
    const x = await seeded();
    const sig = (source: 'Q1' | 'E4_takeover' | 'rework_budget', key: string) =>
      recordBreakerSignal(s.deps, {
        project_id: x.project,
        lane: 'L5',
        source,
        item_id: null,
        signal_key: key,
      });
    ok(await sig('Q1', 'k1'));
    ok(await sig('Q1', 'k1'));
    ok(await sig('E4_takeover', 'k2'));
    const b = ok(await sig('rework_budget', 'k3'));
    expect(b).toMatchObject({
      total: 3,
      tripped: true,
      counts: { Q1: 1, E4_takeover: 1, rework_budget: 1 },
    });
    // a count after the trip is recorded, the trip is not written twice
    ok(await sig('Q1', 'k4'));
    const events = await readBreakerEvents(s.record.pool, x.project, 'L5');
    expect(events.filter((e) => e.type === BREAKER_EVENT.tripped)).toHaveLength(1);
    expect(events.at(0)?.stream_id).toBe(breakerStream(x.project, 'L5'));
  });

  it('a redelivered command counts once (the item replays to the same keys)', async () => {
    const x = await seeded();
    const id = await abandoned(x, 'L6');
    const before = await readBreaker(s.record.pool, x.project, 'L6');
    expect(before.total).toBe(1);
    // drive again from nothing but the record: the stream says nothing is outstanding, nothing recounts
    await driveWork(driverOver(s));
    await driveWork(driverOver(s));
    expect((await readBreaker(s.record.pool, x.project, 'L6')).total).toBe(1);
    expect((await state(id))?.et14).toEqual({ E4_abandon: 1 });
  });

  it('the reset is a human decision: an M5 gate, read from the ledger; a rejection leaves it tripped', async () => {
    const x = await seeded();
    for (let i = 0; i < threshold(); i++)
      await recordBreakerSignal(s.deps, {
        project_id: x.project,
        lane: 'L3',
        source: 'Q1',
        item_id: null,
        signal_key: `${x.project}:${i}`,
      }).then(ok);
    const deps = { ...s.deps, decisions: s.config };
    // nothing to reset on a breaker that is not tripped
    const quiet = await requestBreakerReset(deps, {
      project_id: pid(x.project),
      lane: 'L4',
      requested_by: pr('alice'),
    });
    expect(!quiet.ok && quiet.error.code).toBe('conflict');
    const asked = ok(
      await requestBreakerReset(deps, {
        project_id: pid(x.project),
        lane: 'L3',
        requested_by: pr('alice'),
      }),
    );
    expect(asked.state).toMatchObject({ tripped: true, pending_reset: asked.gate_instance_id });
    // asking again is the same gate
    expect(
      ok(
        await requestBreakerReset(deps, {
          project_id: pid(x.project),
          lane: 'L3',
          requested_by: pr('alice'),
        }),
      ).gate_instance_id,
    ).toBe(asked.gate_instance_id);
    // nothing is reset by asking
    expect((await settleBreakerResets(deps)).reset).toEqual([]);
    expect((await request(x, 'L3', false)).verdict.reason).toBe('circuit_breaker');
    // the requester cannot decide it, a rejection changes nothing
    const own = await decideGate(s, asked.gate_instance_id, 'alice', 'approve');
    expect(own.ok).toBe(false);
    ok(await decideGate(s, asked.gate_instance_id, 'bob', 'reject'));
    expect((await settleBreakerResets(deps)).reset).toEqual([]);
    expect((await readBreaker(s.record.pool, x.project, 'L3')).tripped).toBe(true);
    // asking again opens a new gate (counts are unchanged, so the same subject: a fresh instance)
    const again = ok(
      await requestBreakerReset(deps, {
        project_id: pid(x.project),
        lane: 'L3',
        requested_by: pr('alice'),
      }),
    );
    ok(await decideGate(s, again.gate_instance_id, 'bob', 'approve'));
    const settled = await settleBreakerResets(deps);
    expect(settled.reset).toEqual([{ project_id: x.project, lane: 'L3' }]);
    const b = await readBreaker(s.record.pool, x.project, 'L3');
    expect(b).toMatchObject({ tripped: false, total: 0, resets: 1, pending_reset: null });
    expect((await request(x, 'L3', false)).verdict.route).toBe('normal');
    // settling twice is a no-op
    expect((await settleBreakerResets(deps)).reset).toEqual([]);
    // the decision is in the ledger, on a breaker subject, as an M5
    const led = await s.record.pool.query(
      `SELECT gate_id, subject_kind, decision FROM ledger.ledger_entry
        WHERE entry_type = 'decision' AND gate_instance_id = $1`,
      [again.gate_instance_id],
    );
    expect(led.rows[0]).toMatchObject({
      gate_id: 'M5',
      subject_kind: 'breaker',
      decision: 'approve',
    });
  });

  it('a new item already admitted when the breaker trips is routed at 1.4', async () => {
    const x = await seeded();
    const it1 = await item(x, 'L3'); // admitted and made, 1.4 not yet asked (the driver has not run)
    for (let i = 0; i < threshold(); i++)
      await recordBreakerSignal(s.deps, {
        project_id: x.project,
        lane: 'L3',
        source: 'E4_abandon',
        item_id: null,
        signal_key: `${it1.itemId}:${i}`,
      }).then(ok);
    const d = driverOver(s);
    await driveWork(d);
    const st = await state(it1.itemId);
    expect(st?.proposed_lane).toBe('L8');
  });
});

describe('R4: an overdue hotfix follow-up blocks new agent items', () => {
  /** An L0 item (made directly: L0 is `unspecified` at every onboarding level, OB §2.1) that completes S8b. */
  async function hotfix(x: Seeded) {
    n += 1;
    const itemId = deterministicId<'WorkItem'>(`hotfix-test:${n}`);
    ok(
      await inCoreTx(s.deps, async (j, tx) => {
        await lockKeys(tx, [`repo:${x.repo.toLowerCase()}`]);
        const id = await repoIdentity(tx, x.repo);
        return createItemIn(j, tx, s.deps, {
          item_id: itemId,
          request: {
            request_id: deterministicId<'WorkRequest'>(`hotfix-req:${n}`),
            project_id: pid(x.project),
            repo: x.repo,
            requester: pr('alice'),
            channel: 'N1',
          },
          prr: governingPrr(await j.prr(id!.project_id, repoIdOf(x.repo)))!,
          proposed_lane: 'L0',
          intake: {
            text_sha256: null,
            injection: null,
            dedupe_links: [],
            conflict_candidates: [],
            route: 'normal',
            eligibility_reason: 'eligible',
          },
          origin: null,
          actor: 'test',
        });
      }),
    );
    // the hotfix lane is not open at any level: the 1.4 answer is given here, as an onboarding that opened L0 would
    // the classifier proposes L0 (1.3), and the project's 1.4 answer is "normal"
    const at13 = (await state(itemId))?.outstanding.find((c) => c.type === 'run_stage');
    ok(
      await ingestItem(s.deps, itemId, {
        type: ITEM_EVENT.stage_completed,
        payload: {
          command_key: at13?.key as string,
          step: '1.3',
          output_hash: 'a'.repeat(64),
          lane: 'L0',
        },
        actor: 'test',
        idempotency_key: `test:13:${itemId}`,
      }),
    );
    const cmd = (await state(itemId))?.outstanding.find((c) => c.type === 'check_eligibility');
    ok(
      await ingestItem(s.deps, itemId, {
        type: ITEM_EVENT.eligibility_checked,
        payload: {
          command_key: cmd?.key as string,
          lane: 'L0',
          route: 'normal',
          eligible: true,
          reason: 'eligible',
          prr_version: 1,
        },
        actor: 'test',
        idempotency_key: `test:elig:${itemId}`,
      }),
    );
    return itemId;
  }

  it('the L1 follow-up is created; overdue after five business days; it blocks the project, not its own follow-up; done ends it', async () => {
    s.clock.set('2026-11-09T08:00:00.000Z'); // Monday
    const x = await seeded();
    const other = await seeded();
    const d = driverOver(s);
    const hf = await hotfix(x);
    const done = await runItem(s, d, hf);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.spawns).toMatchObject([
      { edge: 'R4', kind: 'hotfix_follow_up', lane: 'L1' },
    ]);
    await driveWork(d);
    const followId = (await state(hf))?.spawns[0]?.item_id as string;
    const follow = await state(followId);
    expect(follow).toMatchObject({ lane: null, proposed_lane: 'L1', origin: { edge: 'R4' } });
    // not overdue yet: five business days is Monday to the next Monday
    const calendarNow = () => s.clock.now();
    s.clock.set('2026-11-13T08:00:00.000Z');
    expect(await overdueFollowUps(s.record.pool, x.project, calendarNow())).toEqual([]);
    expect((await request(x, 'L3', false)).verdict.route).toBe('normal');
    // overdue
    s.clock.set('2026-11-17T09:00:00.000Z');
    expect(await overdueFollowUps(s.record.pool, x.project, calendarNow())).toEqual([followId]);
    const blocked = await request(x, 'L3');
    expect(blocked.verdict).toMatchObject({ route: 'l8', reason: 'followup_overdue' });
    // per project
    expect((await request(other, 'L3', false)).verdict.route).toBe('normal');
    // L8 human work is not blocked
    expect(
      await projectGuard(s.record.pool, {
        project_id: x.project,
        lane: 'L8',
        now: calendarNow(),
      }),
    ).toBeNull();
    // the follow-up itself is exempt (it is how the block ends), and runs as the lane it asked for
    const finished = await runItem(s, d, followId);
    expect(finished?.state.terminal).toBe('Done');
    expect(finished?.state.lane).toBe('L1');
    // closed: the project is unblocked
    expect(await overdueFollowUps(s.record.pool, x.project, calendarNow())).toEqual([]);
    expect((await request(x, 'L3', false)).verdict.route).toBe('normal');
    void applyGuard;
    void actFor;
    void submitRequest;
  });
});
