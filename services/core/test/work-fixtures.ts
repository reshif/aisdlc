import {
  PRR_EVENT,
  PrrActivatedPayload,
  PrrProposedPayload,
  prrRecordHash,
  prrStream,
  repoIdOf,
  type ProjectReadinessRecord,
  type Level,
  type PrincipalId,
  type PrrGatingProfile,
  type Tier,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { FakeStagePorts, type CapacityPort } from '@aisdlc/ports';
import {
  decideReady,
  driveWork,
  fanOutHeld,
  ingestItem,
  inCoreTx,
  lockKeys,
  readItem,
  readPrrState,
  requestOnboarding,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, request, setSlots, type CoreStack } from '../src/testing.js';
import { decide, prepare, recordEvidenceViewed, type FakeStepUp } from '@aisdlc/decisions';
import { NOW, built, inputs, loadReports } from './prr-fixtures.js';
import { governingPrr } from '../src/fold.js';

// Fixtures for the work lifecycle tests (PLAN M9.1, M9.2): a repo with an ACTIVE Project Readiness
// Record at a level, tier and gating profile of the test's choosing, written straight into the PRR
// stream (the onboarding that makes one in production is M7; its tests are its own), and a driver
// over the real decision kernel, ledger and Notary with the deterministic stage-port fakes.

export { loadReports };

export const GATING_OFF: PrrGatingProfile = {
  gates: { g0g1: 'off', g2: 'off', g3d: 'off', g3_g3s: 'off', g5: 'off', g6: 'off' },
  schedule: 'auto',
  tier_floor_applied: true,
  project_deploys: false,
};
export const GATING_ON: PrrGatingProfile = {
  gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
  schedule: 'auto',
  tier_floor_applied: true,
  project_deploys: true,
};

let n = 0;
export interface Seeded {
  readonly project: string;
  readonly repo: string;
}

/** A project and repo with an active PRR. `gating` is what the PRR (and so every new item) pins. */
export async function seedActivePrr(
  s: CoreStack,
  o: {
    project?: string;
    repo?: string;
    level?: Level;
    tier?: Tier;
    gating?: PrrGatingProfile;
    /** The PRR version to write (a second one supersedes the first). */
    version?: number;
    /** Overrides of the record's autonomy (M15.1: G4's mode reads it); the record hash follows. */
    autonomy?: Partial<ProjectReadinessRecord['autonomy']>;
  } = {},
): Promise<Seeded> {
  n += 1;
  const project = o.project ?? `wk-${n}`;
  const repo = o.repo ?? `acme/wk-${n}`;
  const version = o.version ?? 1;
  const deps = { pool: s.record.pool, clock: s.clock };
  let s0 = '';
  if (version === 1) {
    const r = await requestOnboarding(
      deps,
      request({ project_id: pid(project), repo, level: 'census', on_behalf_of: pr('alice') }),
    );
    if (!r.ok) throw new Error(r.error.message);
    s0 = r.value.s0_id;
  } else {
    s0 = (
      await s.record.pool.query<{ s0_id: string }>(
        `SELECT body ->> 's0_id' AS s0_id FROM record.record_event
          WHERE type = 's0.requested' AND lower(body ->> 'repo') = $1 ORDER BY global_seq LIMIT 1`,
        [repo.toLowerCase()],
      )
    ).rows[0]?.s0_id as string;
  }
  const gating = o.gating ?? GATING_ON;
  const { project_deploys, ...profile } = gating;
  const made = built(
    inputs({
      tier: o.tier ?? 'T1',
      level: o.level ?? 'full',
      gating: { ...profile, project_deploys } as never,
      over: { project_id: project, version, deploys: project_deploys },
    }),
  );
  const changed = o.autonomy ? { ...made, autonomy: { ...made.autonomy, ...o.autonomy } } : made;
  const prr = o.autonomy ? { ...changed, record_hash: prrRecordHash(changed) } : made;
  const stream = prrStream(project, repoIdOf(repo));
  const w = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`project:${project}`, `repo:${repo.toLowerCase()}`]);
    const p = await j.emit(
      stream,
      PRR_EVENT.proposed,
      PrrProposedPayload.parse({ s0_id: s0, prr }),
      'test',
    );
    if (!p.ok) return p;
    const a = await j.emit(
      stream,
      PRR_EVENT.activated,
      PrrActivatedPayload.parse({
        s0_id: s0,
        version,
        record_hash: prr.record_hash,
        m4: {
          ledger_entry_id: '00000000-0000-4000-8000-000000000001',
          decision_hash: sha256Hex('m4'),
        },
      }),
      'test',
    );
    return a.ok ? { ok: true as const, value: true } : a;
  });
  if (!w.ok) throw new Error(w.error.message);
  return { project, repo };
}

/** Releases the N8-held requests of a repo as an M4 does, in its own transaction (no card, no ledger). */
export async function releaseHeld(s: CoreStack, seeded: Seeded) {
  const deps = { pool: s.record.pool, clock: s.clock };
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`project:${seeded.project}`, `repo:${seeded.repo.toLowerCase()}`]);
    const state = await readPrrState(tx, seeded.project, repoIdOf(seeded.repo));
    const g = governingPrr(state);
    if (!g) throw new Error('no governing PRR');
    return fanOutHeld(j, tx, {
      repo: seeded.repo,
      prr: g.prr,
      version: g,
      s0_id: g.s0_id,
      now: s.clock.now(),
      actor: 'test',
    });
  });
}

/** Who holds the slots that decide an item's gates: one approver, `bob`, for every slot but nobody's own request. */
export function approvers(
  s: CoreStack,
  project: string,
  who: string[] = ['bob'],
  tier: Tier = 'T1',
) {
  setSlots(
    s,
    project,
    {
      admin: who,
      requesters: who,
      intent: who,
      design: who,
      g4: who,
      g5: who,
      x: who,
      sec: who,
      m4: who,
      kill: who,
    },
    tier,
  );
  s.elig.setPolicy(pid(project), { tier, two_person: { enabled: false } });
}

export function driverOver(
  s: CoreStack,
  o: { ports?: FakeStagePorts; decisions?: boolean; capacity?: CapacityPort } = {},
): WorkDriverDeps & { readonly ports: FakeStagePorts } {
  const ports = o.ports ?? new FakeStagePorts();
  return {
    pool: s.record.pool,
    clock: s.clock,
    ports,
    ...(o.capacity ? { capacity: o.capacity } : {}),
    ...(o.decisions === false ? {} : { decisions: s.config }),
  };
}

/** What a person does for an item that waits on one: decide its open gates, give the Ready decision, merge. */
export async function actFor(
  s: CoreStack,
  d: WorkDriverDeps,
  itemId: string,
  o: {
    approver?: string;
    decide?: (gate: string) => 'approve' | 'reject' | 'request_changes' | 'hold';
    stop?: (st: NonNullable<Awaited<ReturnType<typeof readItem>>>['state']) => boolean;
  } = {},
): Promise<boolean> {
  const item = await readItem(d.pool, itemId);
  if (!item || item.state.terminal !== null) return false;
  const st = item.state;
  if (o.stop?.(st)) return false;
  const w = st.waiting;
  if (w?.kind === 'human') {
    if (w.what === 'ready') {
      const r = await decideReady(
        { pool: d.pool, clock: s.clock },
        itemId,
        pr(o.approver ?? 'alice') as PrincipalId,
      );
      if (!r.ok) throw new Error(r.error.message);
      return true;
    }
    if (w.what === 'merge') {
      const r = await ingestItem({ pool: d.pool, clock: s.clock }, itemId, {
        type: 'item.merge_observed',
        payload: { merged_sha: 'abcdef1234567' },
        actor: 'system.codehost',
        idempotency_key: `merge:${itemId}`,
      });
      if (!r.ok) throw new Error(r.error.message);
      return true;
    }
    if (w.what === 'human_led') {
      const r = await ingestItem({ pool: d.pool, clock: s.clock }, itemId, {
        type: 'item.human_work_done',
        payload: { by: o.approver ?? 'bob' },
        actor: o.approver ?? 'bob',
        idempotency_key: `human:${itemId}`,
      });
      if (!r.ok) throw new Error(r.error.message);
      return true;
    }
    if (w.what === 'schedule') {
      const r = await ingestItem({ pool: d.pool, clock: s.clock }, itemId, {
        type: 'item.scheduled',
        payload: { by: o.approver ?? 'bob' },
        actor: o.approver ?? 'bob',
        idempotency_key: `schedule:${itemId}`,
      });
      if (!r.ok) throw new Error(r.error.message);
      return true;
    }
  }
  let acted = false;
  for (const g of st.gates.filter((x) => x.status === 'pending')) {
    const how = o.decide?.(g.gate) ?? 'approve';
    if (how === 'hold') continue;
    const r = await decideGate(s, g.gate_instance_id, o.approver ?? 'bob', how);
    if (!r.ok) throw new Error(`decide ${g.gate}: ${JSON.stringify(r.error)}`);
    acted = true;
  }
  return acted;
}

/** Drives the driver and the people until the item ends or `stop` says so. */
export async function runItem(
  s: CoreStack,
  d: WorkDriverDeps,
  itemId: string,
  o: Parameters<typeof actFor>[3] & { passes?: number } = {},
) {
  for (let i = 0; i < (o.passes ?? 80); i++) {
    await driveWork(d);
    const item = await readItem(d.pool, itemId);
    if (item?.state.terminal !== null && (item?.state.outstanding.length ?? 0) === 0) return item;
    const acted = await actFor(s, d, itemId, o);
    if (!acted) {
      await driveWork(d);
      const again = await readItem(d.pool, itemId);
      if (again && o.stop?.(again.state)) return again;
      if (again && again.state.outstanding.length === 0 && again.state.waiting?.kind !== 'gates') {
        const w = again.state.waiting;
        if (w === null || w.kind === 'stuck' || w.kind === 'parked' || w.kind === 'questions')
          return again;
      }
    }
  }
  return readItem(d.pool, itemId);
}

export const T0 = NOW;
export const ALICE = 'alice';

/** prepare, evidence viewed, decide (with a step-up where the gate needs one). */
export async function decideGate(s: CoreStack, gate: string, principal: string, decision: string) {
  const p = await prepare(s.config, { gate_instance_id: gate, principal: pr(principal) });
  if (!p.ok) return p;
  const v = await recordEvidenceViewed(s.config, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  const proof = p.value.step_up.required
    ? (s.config.stepUp as FakeStepUp).issue(p.value.step_up.bound_hash, principal)
    : null;
  return decide(s.config, {
    nonce: p.value.nonce,
    decision,
    ...(proof ? { step_up: { proof } } : {}),
  });
}
