import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, StoreWaitSnapshots, type SessionState } from '@aisdlc/build';
import { type Lane, type ProjectSettings, type StageOutcome } from '@aisdlc/contracts';
import {
  FakeEnvelope,
  FakeProjectSettings,
  FakeStagePorts,
  FakeWaitSnapshots,
  type WaitSnapshotPort,
} from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionCapacity,
  driveWork,
  listGrants,
  listLeases,
  type readItem,
  submitRequest,
  syncUnits,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M13.4 and M13.5 on the real record, ledger and Notary, with the fake stage ports scripted to say what the
// coding port says when a session stops: Q1 (ET10), SECT, the Handoff Pack by hash, HUMAN-WAIT with the REAL snapshot
// store, and BLOCKED for a repo off the owner allow-list.

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
  readonly snapshots: WaitSnapshotPort;
  readonly capacity: AdmissionCapacity;
  /** Items whose 6.4 asks for a person: they stay in S6 holding their session until they are let go. */
  readonly stall: Set<string>;
}

function rigOf(cap = 8, snapshots: WaitSnapshotPort = new FakeWaitSnapshots()): Rig {
  const ports = new FakeStagePorts();
  const settings = new FakeProjectSettings();
  const envelope = new FakeEnvelope();
  const capacity = new AdmissionCapacity({
    pool: s.record.pool,
    settings,
    envelope,
    sessionCap: cap,
  });
  const d = {
    ...driverOver(s, { ports }),
    capacity,
    admission: { settings, envelope, snapshots, sessionCap: cap, attempted: capacity.attempted },
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

type ItemState = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const quarantinedState = (st: ItemState) => st.phase === 'Quarantined';
const pendingSect = (st: ItemState) =>
  st.gates.some((g) => g.gate === 'SECT' && g.status === 'pending' && g.consumed !== true);

/** What the coding port answers at 6.4 the first time: an ET10 for credential hunting, with its evidence by hash. */
const PACK = 'c'.repeat(64);
const hunt = (itemId: string) => (req: { step: string; attempt: number; item_id: string }) =>
  req.step === '6.4' && req.attempt === 1 && req.item_id === itemId
    ? ({
        outcome: 'trigger',
        trigger: 'ET10',
        reason_code: 'credential_hunting',
        output_hash: PACK,
      } as StageOutcome)
    : undefined;

describe('Q1 and SECT (ET10)', () => {
  it('a planted credential-hunting run lands in Q1: stopped, the slot freed, SECT open for the security slot, counted toward ET14', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.ports.coding.script(hunt(x.itemId));
    const at = await runItem(s, r.d, x.itemId, {
      stop: (st) => quarantinedState(st) && pendingSect(st),
    });
    expect(at?.state).toMatchObject({
      phase: 'Quarantined',
      lease: null,
      handoffs: [],
      quarantines: [
        {
          n: 1,
          trigger: 'ET10',
          cause: 'credential_hunting',
          origin_phase: 'S6',
          origin_step: '6.4',
          pack_sha256: PACK,
          resolved: null,
        },
      ],
    });
    expect(at?.state.et14['Q1']).toBe(1);
    expect(at?.state.outputs['6.4']).toBe(PACK);
    // the card: SECT is open for the security slot and is the only thing the item waits for (before any handoff)
    expect(at?.state.waiting).toMatchObject({ kind: 'gates', gates: ['SECT'] });
    await driveWork(r.d);
    const [g] = await listGrants(s.record.pool, x.itemId);
    expect(g).toMatchObject({ status: 'released', release_cause: 'quarantined' });
    expect((await listLeases(s.record.pool, x.itemId))[0]).toMatchObject({ status: 'released' });
    // the session is not asked to run again while SECT is open
    const calls = r.ports.coding.calls.filter(
      (c) => c.item_id === x.itemId && c.step === '6.4',
    ).length;
    await driveWork(r.d);
    expect(
      r.ports.coding.calls.filter((c) => c.item_id === x.itemId && c.step === '6.4').length,
    ).toBe(calls);
  });

  it('SECT false positive: a cold rebuild and a new session at 6.1, admitted again; the item goes on to Done', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.ports.coding.script(hunt(x.itemId));
    await runItem(s, r.d, x.itemId, { stop: (st) => quarantinedState(st) && pendingSect(st) });
    const done = await runItem(s, r.d, x.itemId, { decide: () => 'approve' });
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.quarantines?.[0]).toMatchObject({
      resolved: 'false_positive',
      branch_quarantined: false,
    });
    const mine = r.ports.coding.calls.filter((c) => c.item_id === x.itemId).map((c) => c.step);
    expect(mine.filter((st) => st === '6.1').length).toBe(2);
    const grants = await listGrants(s.record.pool, x.itemId);
    expect(grants.map((g) => g.release_cause).sort()).toEqual(['g4_decided', 'quarantined']);
    // a NEW session: the second grant's epoch is above the first's (the epoch only increases)
    const epochs = grants.map((g) => g.lease_epoch).sort((a, b) => a - b);
    expect(epochs[0]).toBe(1);
    expect(epochs[1]).toBeGreaterThan(1);
  });

  it('SECT confirmed: the branch is quarantined and the item is L8 human-led; the agent is not asked again', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.ports.coding.script(hunt(x.itemId));
    await runItem(s, r.d, x.itemId, { stop: (st) => quarantinedState(st) && pendingSect(st) });
    const at = await runItem(s, r.d, x.itemId, {
      decide: (g) => (g === 'SECT' ? 'reject' : 'approve'),
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'human_led',
    });
    expect(at?.state).toMatchObject({
      lane: 'L8',
      phase: 'S6',
      waiting: { kind: 'human', what: 'human_led' },
      takeover: { lane_before: 'L3' },
      quarantines: [{ resolved: 'confirmed', branch_quarantined: true }],
    });
    await driveWork(r.d);
    const calls = r.ports.coding.calls.filter((c) => c.item_id === x.itemId).length;
    await driveWork(r.d);
    expect(r.ports.coding.calls.filter((c) => c.item_id === x.itemId).length).toBe(calls);
    const [l] = await listLeases(s.record.pool, x.itemId);
    expect(l).toMatchObject({ holder_kind: 'human', status: 'held' });
  });
});

describe('D1: the Handoff Pack a trigger carries is bound by hash', () => {
  it('ET8 with the pack hash: the stage output and the handoff reference carry it', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.ports.coding.script((q) =>
      q.step === '6.4' && q.item_id === x.itemId && q.attempt === 1
        ? ({
            outcome: 'trigger',
            trigger: 'ET8',
            reason_code: 'agent_gave_up',
            output_hash: 'd'.repeat(64),
          } as StageOutcome)
        : undefined,
    );
    const at = await runItem(s, r.d, x.itemId, {
      stop: (st) => st.handoffs.some((h) => h.status === 'open'),
    });
    expect(at?.state.handoffs[0]).toMatchObject({ code: 'D1', trigger: 'ET8', origin_step: '6.4' });
    expect(at?.state.outputs['6.4']).toBe('d'.repeat(64));
  });
});

describe('BLOCKED: DEC-18', () => {
  it('a repo off the owner allow-list is BLOCKED with cause exec_not_allowed and no remediation item is spawned', async () => {
    const r = rigOf();
    const x = await newItem(r);
    r.ports.coding.script((q) =>
      q.step === '6.1' && q.item_id === x.itemId
        ? ({ outcome: 'rework', edge: 'B6', reason_code: 'exec_not_allowed' } as StageOutcome)
        : undefined,
    );
    const at = await runItem(s, r.d, x.itemId, { stop: (st) => st.waiting?.kind === 'blocked' });
    expect(at?.state.waiting).toMatchObject({
      kind: 'blocked',
      cause: 'exec_not_allowed',
      owner: 'platform_owner',
    });
    expect(at?.state.spawns).toEqual([]);
  });
});

describe('HUMAN-WAIT with the real snapshot store', () => {
  let dir: string;
  const sessionFor = (store: SessionStore, itemId: string): SessionState => {
    const tree = store.putFiles([
      { path: 'src/calc.js', content: 'exports.add = (a, b) => a + b;\n' },
    ]);
    return {
      item_id: itemId,
      repo: 'acme/x',
      unit_key: 'main',
      base_sha: 'a'.repeat(40),
      generation: 1,
      base_tree_sha256: tree,
      tree_sha256: tree,
      locks: {},
      oracle_ids: [],
      task_idx: 0,
      rounds: [],
      failing_history: [],
      scope_drifts: 0,
      started_ms: 0,
      tainted: false,
      pending_gate: 'X1',
      approved_classes: [],
      ignored_harness: [],
      snapshot_ref: null,
      feedback: [],
      fix_round: 0,
      stage: 'building',
    };
  };

  it('a pending X1 releases the lease and the slot and keeps a snapshot of the REAL workspace; approved, the same task resumes with the gate approved', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-wait-'));
    try {
      const store = new SessionStore(dir);
      const r = rigOf(8, new StoreWaitSnapshots(store));
      const x = await newItem(r);
      r.ports.coding.script((q) =>
        q.step === '6.4' && q.item_id === x.itemId && q.attempt === 1
          ? ({
              outcome: 'gate_needed',
              gate: 'X1',
              reason_code: 'irreversible_operation',
            } as StageOutcome)
          : undefined,
      );
      // the coding port would have saved the workspace by now; the test saves one the same way
      store.save(sessionFor(store, x.itemId));
      const at = await runItem(s, r.d, x.itemId, {
        stop: (st) => st.gates.some((g) => g.gate === 'X1' && g.status === 'pending'),
      });
      expect(at?.state.gates.find((g) => g.gate === 'X1')?.status).toBe('pending');
      await driveWork(r.d);
      const [g] = await listGrants(s.record.pool, x.itemId);
      expect(g).toMatchObject({ status: 'waiting' });
      expect(g?.snapshot_ref).toMatch(/^snap:[0-9a-f]{32}$/);
      const snap = store.readSnapshot(g?.snapshot_ref ?? '');
      expect(snap?.tree_sha256).toBe(store.load(x.itemId)?.tree_sha256);
      expect(new SessionStore(dir).filesOf(snap?.tree_sha256 ?? '').map((f) => f.path)).toEqual([
        'src/calc.js',
      ]);
      expect((await listLeases(s.record.pool, x.itemId))[0]).toMatchObject({ status: 'released' });
      // the decision: the item is admitted again and 6.4 runs again with X1 approved (rehydrate, resume)
      const done = await runItem(s, r.d, x.itemId);
      expect(done?.state.terminal).toBe('Done');
      const runs = r.ports.coding.calls.filter((c) => c.item_id === x.itemId && c.step === '6.4');
      expect(runs.map((c) => c.approved_gates)).toEqual([[], ['X1']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no workspace to snapshot there is no wait: the session keeps its lease and slot (fail closed)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-wait-'));
    try {
      const store = new SessionStore(dir);
      const r = rigOf(8, new StoreWaitSnapshots(store));
      const x = await newItem(r);
      r.ports.coding.script((q) =>
        q.step === '6.4' && q.item_id === x.itemId && q.attempt === 1
          ? ({ outcome: 'gate_needed', gate: 'X3', reason_code: 'new_dependency' } as StageOutcome)
          : undefined,
      );
      await runItem(s, r.d, x.itemId, {
        stop: (st) => st.gates.some((g) => g.gate === 'X3' && g.status === 'pending'),
      });
      await driveWork(r.d);
      const [g] = await listGrants(s.record.pool, x.itemId);
      expect(g).toMatchObject({ status: 'active' });
      expect((await listLeases(s.record.pool, x.itemId))[0]).toMatchObject({ status: 'held' });
      await syncUnits({ ...r.d, ...r.d.admission } as never, [x.itemId]);
      expect((await listGrants(s.record.pool, x.itemId))[0]).toMatchObject({ status: 'active' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
