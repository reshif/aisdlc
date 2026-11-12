import {
  PLANNING_EVENT,
  UNIT_EVENT,
  planningStream,
  unitStream,
  type Lane,
  type ProjectSettings,
  type StageOutcome,
} from '@aisdlc/contracts';
import {
  FakeEnvelope,
  FakeProjectSettings,
  FakeSandboxSlots,
  FakeStagePorts,
  FakeWaitSnapshots,
  HttpSandbox,
  type SandboxSlotsPort,
} from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionCapacity,
  admitUnit,
  assertLeaseEpoch,
  chooseHandoff,
  driveWork,
  emitUnitEvent,
  inCoreTx,
  listGrants,
  listLeases,
  listUnits,
  lockKeys,
  readItem,
  rebuildUnits,
  recordUnitProgress,
  submitRequest,
  syncUnits,
  unitLockKey,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M13.1 on the real record, ledger and Notary: 6.0 admission (a lease epoch, an approver slot, capacity, the
// envelope, each refusal a HELD with its reason that clears), the Unit as the single owner of the lease epoch,
// FIFO by priority, HUMAN-WAIT, takeover, and the rebuild of the Unit, Lease and AdmissionGrant read models.

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

const settingsOf = (
  project: string,
  over: { x?: string[]; g4?: string[] } = {},
): ProjectSettings => {
  const slot = (principals: string[]) => ({
    kind: 'principals' as const,
    principals: principals as never,
  });
  return {
    project_id: project as never,
    role_map: {
      admin: slot(['bob']),
      requesters: slot(['bob']),
      intent: slot(['bob']),
      design: slot(['bob']),
      g4: slot(over.g4 ?? ['bob']),
      g5: slot(['bob']),
      x: slot(over.x ?? ['bob']),
      sec: slot(['bob']),
      m4: slot(['bob']),
      kill: slot(['bob']),
    },
    two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
    gating_profile: { gates: GATING_OFF.gates, schedule: 'auto', tier_floor_applied: true },
    kill_delegations: [],
    version: 1,
    updated_at: '2026-11-09T00:00:00.000Z',
  } as ProjectSettings;
};

interface Rig {
  readonly d: WorkDriverDeps & { readonly ports: FakeStagePorts };
  readonly ports: FakeStagePorts;
  readonly settings: FakeProjectSettings;
  readonly envelope: FakeEnvelope;
  readonly snapshots: FakeWaitSnapshots;
  readonly capacity: AdmissionCapacity;
  /** Items whose 6.4 asks for a person: they stay in S6 holding their session until they are let go. */
  readonly stall: Set<string>;
}

function rigOf(cap = 1, slots?: SandboxSlotsPort): Rig {
  const ports = new FakeStagePorts();
  const settings = new FakeProjectSettings();
  const envelope = new FakeEnvelope();
  const snapshots = new FakeWaitSnapshots();
  const capacity = new AdmissionCapacity({
    pool: s.record.pool,
    settings,
    envelope,
    sessionCap: cap,
    ...(slots ? { slots } : {}),
  });
  const d = {
    ...driverOver(s, { ports }),
    capacity,
    admission: {
      settings,
      envelope,
      snapshots,
      sessionCap: cap,
      attempted: capacity.attempted,
      ...(slots ? { slots } : {}),
    },
  } as WorkDriverDeps & { readonly ports: FakeStagePorts };
  const stall = new Set<string>();
  ports.coding.script((q2) =>
    q2.step === '6.4' && stall.has(q2.item_id) ? { outcome: 'held', reason: 'WIP' } : undefined,
  );
  return { d, ports, settings, envelope, snapshots, capacity, stall };
}

let n = 0;
/** A project with an active PRR, its role map (for the driver's kernel and for admission), and one request. */
async function newItem(
  r: Rig,
  o: { lane?: Lane; project?: string; x?: string[]; g4?: string[] } = {},
) {
  n += 1;
  const seeded = await seedActivePrr(s, {
    level: 'full',
    gating: GATING_OFF,
    ...(o.project ? { project: o.project, repo: `acme/${o.project}` } : {}),
  });
  approvers(s, seeded.project, ['bob']);
  r.settings.set(settingsOf(seeded.project, o));
  const sub = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: o.lane ?? 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `admission test request ${n}`,
    }),
  );
  return { ...seeded, itemId: sub.item_id as string };
}
const state = async (id: string) => (await readItem(s.record.pool, id))?.state;
const q = <T extends object>(sql: string, args: unknown[] = []) =>
  s.record.pool.query<T>(sql, args).then((x) => x.rows);
const admittedOrder = async (ids: string[]) =>
  (
    await q<{ item_id: string }>(
      `SELECT body ->> 'item_id' AS item_id FROM record.record_event
        WHERE type = $1 AND body ->> 'item_id' = ANY($2::text[]) ORDER BY global_seq`,
      [UNIT_EVENT.admitted, ids],
    )
  ).map((x) => x.item_id);
/** Passes of the driver and the people, a second apart, until the item ends (the held ones wait for the loop). */
async function settle(r: Rig, id: string, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    const item = await runItem(s, r.d, id, { passes: 4 });
    if (item?.state.terminal !== null) return item;
    s.clock.advance(1_000);
  }
  return readItem(s.record.pool, id);
}
const afterAdmission = (st: NonNullable<Awaited<ReturnType<typeof state>>>) => st.lease !== null;

describe('6.0 admission', () => {
  it('admits with a fresh lease epoch, the approver slot and the envelope reserved; the Unit owns the epoch; the grant ends when G4 is decided', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.stall.add(x.itemId);
    const at = await runItem(s, r.d, x.itemId, { stop: afterAdmission });
    expect(at?.state).toMatchObject({ lease: { epoch: 1 } });

    const [unit] = await listUnits(s.record.pool, x.itemId);
    expect(unit).toMatchObject({
      unit_key: 'main',
      state: 'Admitted',
      branch: `agent/${x.itemId}/main`,
      lease_epoch: 1,
      base_sha: null,
    });
    const [lease] = await listLeases(s.record.pool, x.itemId);
    expect(lease).toMatchObject({
      epoch: 1,
      holder_kind: 'agent',
      status: 'held',
      branch: unit?.branch,
    });
    const [grant] = await listGrants(s.record.pool, x.itemId);
    expect(grant).toMatchObject({
      status: 'active',
      lease_epoch: 1,
      slot: { g4: { kind: 'principals', count: 1 }, x: { count: 1 } },
      envelope: { ref: `unit-envelope:${unit?.unit_id}` },
    });
    // the envelope is the Unit's, reserved in the gateway with the 5.5 limits
    expect(r.envelope.reserved).toEqual([
      {
        group_id: `unit-envelope:${unit?.unit_id}`,
        max_tokens: unit?.envelope.max_tokens,
        max_cost_micro_usd: unit?.envelope.max_cost_micro_usd,
      },
    ]);
    // the engine's copy of the epoch is the Unit's
    expect(at?.state.lease?.epoch).toBe(unit?.lease_epoch);

    // the rest of the item: the lease ends when S6 is left, the grant when G4 is decided
    r.stall.delete(x.itemId);
    const done = await runItem(s, r.d, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    await driveWork(r.d);
    const [g2] = await listGrants(s.record.pool, x.itemId);
    expect(g2).toMatchObject({ status: 'released', release_cause: 'g4_decided' });
    const [l2] = await listLeases(s.record.pool, x.itemId);
    expect(l2).toMatchObject({ epoch: 1, status: 'released' });
    expect(l2?.history.map((h) => h.cause)).toEqual(['admitted', 'left_s6']);
    expect((await listUnits(s.record.pool, x.itemId))[0]?.state).toBe('GrantReleased');
  });

  it('refuses a stale lease epoch everywhere: the DB trigger, the writer and the check', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.stall.add(x.itemId);
    await runItem(s, r.d, x.itemId, { stop: afterAdmission });
    const [unit] = await listUnits(s.record.pool, x.itemId);
    const uid = unit?.unit_id as string;
    // a writer that holds an epoch the lease never had, or an older one, is refused; the right one moves the Unit
    for (const bad of [2, 7]) {
      const w = await recordUnitProgress(s.deps, {
        item_id: x.itemId,
        unit_id: uid,
        lease_epoch: bad,
        to: 'Building',
        reason: 'session_started',
        key: `bad${bad}`,
      });
      expect(!w.ok && w.error.code).toBe('refused');
    }
    const good = await recordUnitProgress(s.deps, {
      item_id: x.itemId,
      unit_id: uid,
      lease_epoch: 1,
      to: 'Building',
      reason: 'session_started',
      key: 'good',
    });
    expect(good.ok).toBe(true);
    expect((await listUnits(s.record.pool, x.itemId))[0]?.state).toBe('Building');
    // a move the Unit's table does not draw is refused too
    const skip = await recordUnitProgress(s.deps, {
      item_id: x.itemId,
      unit_id: uid,
      lease_epoch: 1,
      to: 'Merged',
      reason: 'x',
      key: 'skip',
    });
    expect(!skip.ok && skip.error.code).toBe('conflict');
    // the table itself refuses an epoch that goes down, whoever writes
    await q(`UPDATE core.lease SET epoch = 5 WHERE unit_id = $1`, [uid]);
    await expect(q(`UPDATE core.lease SET epoch = 4 WHERE unit_id = $1`, [uid])).rejects.toThrow(
      /stale lease epoch/,
    );
    const stale = await assertLeaseEpoch(s.record.pool, uid, 1);
    expect(!stale.ok && (stale.error.detail as { code: string }).code).toBe('stale_epoch');
  });
});

describe('HELD at admission: the reason, and the release when it clears', () => {
  const held = async (r: Rig, id: string) =>
    runItem(s, r.d, id, { stop: (st) => st.phase === 'Held' || afterAdmission(st) });

  it('H1: no X-gate decider in the role map holds the item until one exists', async () => {
    const r = rigOf();
    const x = await newItem(r, { x: [] });
    await held(r, x.itemId);
    expect(await state(x.itemId)).toMatchObject({ phase: 'Held', holds: [{ reason: 'H1' }] });
    // nothing is free while the role map is unchanged
    await driveWork(r.d);
    expect((await state(x.itemId))?.phase).toBe('Held');
    expect(await listGrants(s.record.pool, x.itemId)).toEqual([]);
    r.settings.set(settingsOf(x.project));
    const done = await runItem(s, r.d, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect((await listGrants(s.record.pool, x.itemId))[0]?.lease_epoch).toBe(1);
  });

  it('H1: an unreadable role map is unmet (fail closed), not an approval', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.settings.breakProject(pid(x.project));
    await held(r, x.itemId);
    expect(await state(x.itemId)).toMatchObject({ phase: 'Held', holds: [{ reason: 'H1' }] });
  });

  it('H3: an envelope that cannot be reserved holds the item; no grant and no lease are written', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.envelope.breakIt();
    await held(r, x.itemId);
    expect(await state(x.itemId)).toMatchObject({ phase: 'Held', holds: [{ reason: 'H3' }] });
    expect(await listGrants(s.record.pool, x.itemId)).toEqual([]);
    expect(await listLeases(s.record.pool, x.itemId)).toEqual([]);
    r.envelope.breakIt(false);
    const done = await runItem(s, r.d, x.itemId);
    expect(done?.state.terminal).toBe('Done');
  });

  it('WIP: a developer holding the Unit branch refuses admission; the next epoch is above every earlier one', async () => {
    const r = rigOf();
    const y = await newItem(r);
    // the Unit exists once an admission was tried (the envelope is down, so nothing else is written yet)
    r.envelope.breakIt();
    await held(r, y.itemId);
    r.envelope.breakIt(false);
    const [u] = await listUnits(s.record.pool, y.itemId);
    const uid = u?.unit_id as string;
    const lease = async (
      epoch: number,
      holder: 'human' | 'agent',
      status: 'held' | 'released',
      key: string,
    ) =>
      ok(
        await inCoreTx(s.deps, async (j, tx) => {
          await lockKeys(tx, [unitLockKey(y.itemId)]);
          const e = await emitUnitEvent(
            j,
            tx,
            y.itemId,
            UNIT_EVENT.lease_changed,
            {
              unit_id: uid,
              item_id: y.itemId as never,
              lease_epoch: epoch,
              holder_kind: holder,
              holder_ref: null,
              status,
              cause: holder === 'human' ? 'takeover' : 'hand_back',
            },
            key,
          );
          return e.ok ? { ok: true as const, value: true } : e;
        }),
      );
    await lease(5, 'human', 'held', 'dev1');
    // the H3 hold clears (the envelope answers), the next admission meets the developer
    await runItem(s, r.d, y.itemId, { stop: (st) => st.holds.some((h) => h.reason === 'WIP') });
    expect(await state(y.itemId)).toMatchObject({ phase: 'Held', holds: [{ reason: 'WIP' }] });
    expect(await listGrants(s.record.pool, y.itemId)).toEqual([]);
    await lease(5, 'human', 'released', 'dev2');
    const done = await runItem(s, r.d, y.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect((await listGrants(s.record.pool, y.itemId))[0]?.lease_epoch).toBe(6);
  });

  it('H2 and FIFO by priority: one coding session at a time; the held items go in lane order, then in the order they were held', async () => {
    const r = rigOf(1);
    // A takes the only session and stays in S6 (its 6.4 asks a person: the session is not over)
    const a = await newItem(r, { lane: 'L3' });
    r.stall.add(a.itemId);
    await runItem(s, r.d, a.itemId, { stop: afterAdmission });
    const b = await newItem(r, { lane: 'L3' });
    const c = await newItem(r, { lane: 'L1' });
    const e = await newItem(r, { lane: 'L3' });
    for (const x of [b, c, e]) {
      await runItem(s, r.d, x.itemId, { stop: (st) => st.phase === 'Held' });
      s.clock.advance(1_000);
      expect((await state(x.itemId))?.holds[0]).toMatchObject({ reason: 'H2' });
    }
    // the session is still taken: nothing is released
    await driveWork(r.d);
    for (const x of [b, c, e]) expect((await state(x.itemId))?.phase).toBe('Held');
    // A goes on and its session ends
    r.stall.delete(a.itemId);
    for (let i = 0; i < 14; i++) {
      await driveWork(r.d);
      s.clock.advance(1_000);
    }
    const order = (await admittedOrder([a.itemId, b.itemId, c.itemId, e.itemId])).slice(1);
    // L1 outranks L3 (the catalogue's lane order), then the two L3 items in the order they were held
    expect(order).toEqual([c.itemId, b.itemId, e.itemId]);
  });
});

describe('H2 reads the sandbox-controller (M14.2)', () => {
  it('no free coding slot on the runner host holds the item even under the grant cap; the item is admitted once one frees', async () => {
    const slots = new FakeSandboxSlots().occupy('W', 1);
    const r = rigOf(5, slots);
    const x = await newItem(r);
    await runItem(s, r.d, x.itemId, { stop: (st) => st.phase === 'Held' });
    expect((await state(x.itemId))?.holds[0]).toMatchObject({ reason: 'H2' });
    expect(await listGrants(s.record.pool, x.itemId)).toEqual([]);
    expect(slots.asked).toBeGreaterThan(0);
    // still taken: the release loop frees nothing
    await driveWork(r.d);
    expect((await state(x.itemId))?.phase).toBe('Held');
    // the session on the host ends: the item is released and admitted
    slots.occupy('W', 0);
    const done = await settle(r, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect((await listGrants(s.record.pool, x.itemId))[0]).toMatchObject({ lease_epoch: 1 });
  });

  it('an unreachable controller is no free slot (unknown is unmet): the item waits, it is never admitted on a guess', async () => {
    const r = rigOf(5, new HttpSandbox({ baseUrl: 'http://127.0.0.1:1', token: 't'.repeat(32) }));
    const x = await newItem(r);
    await runItem(s, r.d, x.itemId, { stop: (st) => st.phase === 'Held' });
    expect((await state(x.itemId))?.holds[0]).toMatchObject({ reason: 'H2' });
    for (let i = 0; i < 3; i++) {
      await driveWork(r.d);
      s.clock.advance(1_000);
    }
    expect((await state(x.itemId))?.phase).toBe('Held');
    expect(await listGrants(s.record.pool, x.itemId)).toEqual([]);
  });

  it('the lower of the two counts: a free controller slot does not lift the grant cap', async () => {
    const r = rigOf(1, new FakeSandboxSlots({ total: 4, coding: 3 }));
    const a = await newItem(r);
    r.stall.add(a.itemId);
    await runItem(s, r.d, a.itemId, { stop: afterAdmission });
    const b = await newItem(r);
    await runItem(s, r.d, b.itemId, { stop: (st) => st.phase === 'Held' });
    expect((await state(b.itemId))?.holds[0]).toMatchObject({ reason: 'H2' });
    r.stall.delete(a.itemId);
    expect((await settle(r, a.itemId))?.state.terminal).toBe('Done');
    expect((await settle(r, b.itemId))?.state.terminal).toBe('Done');
  });
});

describe('HUMAN-WAIT in S6', () => {
  it('a pending G3o releases the lease and the slot, keeps a snapshot and pauses the clock; the decision re-admits with a fresh epoch and the same envelope', async () => {
    const r = rigOf(1);
    r.ports.coding.script((q2) =>
      q2.step === '6.3' && q2.attempt === 1 && q2.item_id === x.itemId
        ? ({ outcome: 'gate_needed', gate: 'G3o', reason_code: 'deviation' } as StageOutcome)
        : undefined,
    );
    const x = await newItem(r);
    const at = await runItem(s, r.d, x.itemId, {
      stop: (st) => st.gates.some((g) => g.gate === 'G3o' && g.status === 'pending'),
    });
    expect(at?.state.gates.find((g) => g.gate === 'G3o')?.status).toBe('pending');
    await driveWork(r.d);
    const [g1] = await listGrants(s.record.pool, x.itemId);
    expect(g1).toMatchObject({ status: 'waiting', lease_epoch: 1 });
    expect(g1?.snapshot_ref).toMatch(/^snap:/);
    expect(g1?.clock.paused_since).not.toBeNull();
    expect(r.snapshots.kept).toHaveLength(1);
    const [l1] = await listLeases(s.record.pool, x.itemId);
    expect(l1).toMatchObject({ status: 'released', epoch: 1 });
    // the slot is free: another item is admitted while this one waits for a person
    const other = await newItem(r);
    r.stall.add(other.itemId);
    await runItem(s, r.d, other.itemId, { stop: afterAdmission });
    expect((await listGrants(s.record.pool, other.itemId))[0]).toMatchObject({ status: 'active' });
    // an hour passes; the person decides; the item is admitted again once the other session is over
    s.clock.advance(3_600_000);
    const g3o = (await state(x.itemId))?.gates.find((g) => g.gate === 'G3o');
    ok(await decideGate(s, g3o?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(r.d);
    expect((await state(x.itemId))?.holds).toEqual([expect.objectContaining({ reason: 'H2' })]);
    r.stall.delete(other.itemId);
    const done = await settle(r, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    const grants = await listGrants(s.record.pool, x.itemId);
    expect(grants.map((g) => [g.status, g.lease_epoch])).toEqual([
      ['released', 1],
      ['released', 2],
    ]);
    expect(grants[0]).toMatchObject({ release_cause: 'readmitted' });
    expect(grants[1]).toMatchObject({
      resumes_grant_id: grants[0]?.grant_id,
      release_cause: 'g4_decided',
    });
    // the envelope is the same group (its spend carries over); the wait's hour is not on its clock
    expect(grants[1]?.envelope.ref).toBe(grants[0]?.envelope.ref);
    expect(grants[1]?.clock.paused_ms).toBeGreaterThanOrEqual(3_600_000);
    expect(r.envelope.reserved).toHaveLength(2); // this item's and the other's: one group per Unit
  });
});

describe('takeover (E4)', () => {
  it('bumps the epoch above the agent’s, the grant ends with the handoff, and a write at the old epoch is stale', async () => {
    const r = rigOf();
    r.ports.coding.script((q2) =>
      q2.step === '6.4' && q2.attempt <= 2
        ? { outcome: 'trigger', trigger: 'ET1', reason_code: 'tk' }
        : undefined,
    );
    const x = await newItem(r);
    await runItem(s, r.d, x.itemId, {
      stop: (q2) => q2.waiting?.kind === 'handoff' && q2.waiting.stage === 'e4',
    });
    await driveWork(r.d);
    // the handoff ended the grant and the agent's lease
    expect((await listGrants(s.record.pool, x.itemId))[0]).toMatchObject({
      status: 'released',
      release_cause: 'handoff',
    });
    expect((await listLeases(s.record.pool, x.itemId))[0]).toMatchObject({
      epoch: 1,
      status: 'released',
      holder_kind: 'agent',
    });
    const st = await state(x.itemId);
    const hid = st?.handoffs[0]?.handoff_id as string;
    const e4 = st?.gates.find((g) => g.gate === 'E4');
    ok(await decideGate(s, e4?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(r.d);
    ok(
      await chooseHandoff(s.deps, x.itemId, { handoff_id: hid, choice: 'takeover', by: pr('bob') }),
    );
    const engine = (await state(x.itemId))?.lease?.epoch as number;
    await syncUnits({ ...s.deps, ...r.d.admission! }, [x.itemId]);
    const [lease] = await listLeases(s.record.pool, x.itemId);
    // the engine's lease_seq + 1 and the Unit's epoch + 1: the Unit's own epoch is above every earlier one
    expect(lease).toMatchObject({ holder_kind: 'human', status: 'held', epoch: engine });
    expect(lease?.epoch).toBeGreaterThan(1);
    expect(lease?.history.map((h) => h.cause)).toEqual(['admitted', 'handoff', 'takeover']);
    const [unit] = await listUnits(s.record.pool, x.itemId);
    expect(unit?.lease_epoch).toBe(lease?.epoch);
    // the agent's old epoch writes nothing any more
    const stale = await recordUnitProgress(s.deps, {
      item_id: x.itemId,
      unit_id: unit?.unit_id as string,
      lease_epoch: 1,
      to: 'Building',
      reason: 'late_write',
      key: 'late',
    });
    expect(!stale.ok && (stale.error.detail as { code: string }).code).toBe('stale_epoch');
  });
});

describe('rebuild', () => {
  it('the Unit, Lease and AdmissionGrant rows rebuilt from the events equal the live rows, through a wait and a re-admission', async () => {
    const r = rigOf();
    r.ports.coding.script((q2) =>
      q2.step === '6.3' && q2.attempt === 1 && q2.item_id === x.itemId
        ? ({ outcome: 'gate_needed', gate: 'G3o', reason_code: 'deviation' } as StageOutcome)
        : undefined,
    );
    const x = await newItem(r);
    await runItem(s, r.d, x.itemId, {
      stop: (st) => st.gates.some((g) => g.gate === 'G3o' && g.status === 'pending'),
    });
    await driveWork(r.d);
    s.clock.advance(60_000);
    const g3o = (await state(x.itemId))?.gates.find((g) => g.gate === 'G3o');
    ok(await decideGate(s, g3o?.gate_instance_id as string, 'bob', 'approve'));
    await runItem(s, r.d, x.itemId);
    await driveWork(r.d);
    const read = async () => ({
      units: await listUnits(s.record.pool, x.itemId),
      leases: await listLeases(s.record.pool, x.itemId),
      grants: await listGrants(s.record.pool, x.itemId),
    });
    const live = await read();
    expect(live.grants).toHaveLength(2);
    // wipe and refold from the record alone
    expect(await rebuildUnits(s.deps, x.itemId)).toBe(1);
    expect(await read()).toEqual(live);
    // the implicit Unit is a `units.planned` event like any plan's: the stream has it
    const ev = await q<{ type: string }>(
      `SELECT type FROM record.record_event WHERE stream = ANY($1::text[]) ORDER BY global_seq`,
      [[planningStream(x.itemId), unitStream(x.itemId)]],
    );
    expect(ev.map((e) => e.type)).toEqual([
      PLANNING_EVENT.units_planned,
      UNIT_EVENT.admitted,
      UNIT_EVENT.wait_entered,
      UNIT_EVENT.admitted,
      UNIT_EVENT.grant_released,
      UNIT_EVENT.lease_changed,
    ]);
  });

  it('the rebuild drill with an admitted Unit: kill the driver in S6, wipe the execution state and the Unit models, refold from the record, restart: the item resumes under the same grant', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.stall.add(x.itemId);
    await runItem(s, r.d, x.itemId, { stop: afterAdmission });
    const read = async () => ({
      item: JSON.stringify((await state(x.itemId))!),
      units: await listUnits(s.record.pool, x.itemId),
      leases: await listLeases(s.record.pool, x.itemId),
      grants: await listGrants(s.record.pool, x.itemId),
    });
    const before = await read();
    expect(before.grants[0]).toMatchObject({ status: 'active', lease_epoch: 1 });
    // the wipe: the outbox (jobs), the item read model and its checkpoint, and the Unit, Lease and Grant rows
    const wipe = await s.record.pool.connect();
    try {
      await wipe.query(`SET session_replication_role = replica`);
      await wipe.query(`DELETE FROM record.outbox WHERE destination = 'work.commands'`);
      await wipe.query(`DELETE FROM core.lease_history WHERE unit_id LIKE $1`, [`${x.itemId}:%`]);
      await wipe.query(`DELETE FROM core.admission_grant WHERE item_id = $1`, [x.itemId]);
      await wipe.query(`DELETE FROM core.lease WHERE item_id = $1`, [x.itemId]);
      await wipe.query(`DELETE FROM core.unit WHERE item_id = $1`, [x.itemId]);
      await wipe.query(`RESET session_replication_role`);
    } finally {
      wipe.release();
    }
    await q(`DELETE FROM core.work_item`);
    await q(`DELETE FROM record.projection_checkpoint WHERE name = 'work_item'`);
    expect(await listUnits(s.record.pool, x.itemId)).toEqual([]);
    expect(await rebuildUnits(s.deps, x.itemId)).toBe(1);
    expect(await read()).toEqual(before);
    // a new driver with no memory finishes the item; the grant is the one it had and nothing is admitted twice
    const fresh = rigOf();
    fresh.settings.set(settingsOf(x.project));
    const done = await settle(fresh, x.itemId);
    expect(done?.state.terminal).toBe('Done');
    const grants = await listGrants(s.record.pool, x.itemId);
    expect(grants.map((g) => [g.grant_id, g.status, g.release_cause])).toEqual([
      [before.grants[0]!.grant_id, 'released', 'g4_decided'],
    ]);
    expect(await admittedOrder([x.itemId])).toEqual([x.itemId]);
  });

  it('admission is idempotent per command: a redelivery after the commit answers the same grant', async () => {
    const r = rigOf();
    const x = await newItem(r);
    await runItem(s, r.d, x.itemId, { stop: afterAdmission });
    const st = (await state(x.itemId))!;
    const [e] = await q<{ body: { command_key: string; grant_id: string } }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2`,
      [unitStream(x.itemId), UNIT_EVENT.admitted],
    );
    const again = ok(await admitUnit({ ...s.deps, ...r.d.admission! }, st, e!.body.command_key));
    expect(again).toMatchObject({ admitted: true, grant_id: e!.body.grant_id, lease_epoch: 1 });
    expect(await listGrants(s.record.pool, x.itemId)).toHaveLength(1);
  });
});
