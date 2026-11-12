import { primaryAgentFor } from '@aisdlc/agents';
import { catalogueFor } from '@aisdlc/catalogue';
import {
  UNIT_EVENT,
  UnitAdmittedPayload,
  unitBranchOf,
  unitStream,
  type AdmissionHold,
  type AdmissionSlot,
  type Unit,
  type UnitState,
  canTransitionUnit,
  type UnitEnvelope,
} from '@aisdlc/contracts';
import { readAdmissionSettings, readSandboxCaps } from '@aisdlc/config';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import {
  freeCodingSlots,
  type EnvelopePort,
  type ProjectSettingsPort,
  type SandboxSlotsPort,
  type WaitSnapshotPort,
} from '@aisdlc/ports';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { itemWorkHold } from '../drift/hold.js';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { budgetEnvelope } from '../planning/plan.js';
import { listUnits, planUnits } from '../planning/units.js';
import { emitUnitEvent } from './events.js';
import { unitLockKey } from './fold.js';
import { ACTIVE_SESSIONS_SQL, activeGrantCount } from './read.js';

// 6.0 admission (PLAN M13.1; FL "SCHEDULED: admission needs lease + slot + envelope"; DM §6.4 `Planned -> Admitted`).
//
// DETERMINISTIC: a function of the record (the Units, the leases and grants, the role map) and of the answers of
// two ports (the envelope, the kill switch the driver asks first). An admission needs ALL of
//   (a) a lease on the Unit's branch `agent/<item>/<unit>` with a fresh epoch (the lease table: the epoch only
//       increases, and is higher than every epoch the item's engine has already handed out),
//   (b) an approver slot (H1): the deciders downstream exist in the role map: the G4 slot and the X slot,
//   (c) capacity (H2): fewer grants hold a coding slot than CODING_SESSION_CAP, and (M14.2, when the sandbox-controller
//       is wired) the controller reports a free coding slot under its runner host's caps (unreachable: none free),
//   (d) the envelope from 5.5 reserved: a budget group in the gateway created for the Unit with that envelope (H3),
//   (e) the kill switch's admission (the work driver asks it before it dispatches the command: unreachable is a
//       refusal, and the command is deferred, not failed).
// Any miss is HELD with the reason of the first check that failed, in the order H1, H2, H3, then the lease
// (WIP: another holder has the Unit's branch). Nothing is reserved by a refusal that could not be reserved
// again: the envelope's group is idempotent and the lease and grant are written together or not at all.
//
// A grant records the lease epoch, the slot and the envelope ref; it ends (GrantReleased) on a handoff, when the
// item ends or when G4 is decided (`syncUnits`).

export interface AdmissionDeps extends CoreDeps {
  readonly settings: ProjectSettingsPort;
  readonly envelope: EnvelopePort;
  readonly snapshots: WaitSnapshotPort;
  /**
   * Grants that may hold a coding slot at once. Default (M15.5): the coding cap of `sandbox.caps` for `runnerHost`, the
   * very value that host's sandbox-controller enforces (unreadable: the defaults, never higher).
   */
  readonly sessionCap?: number;
  /** The runner host whose caps H2 follows (`SANDBOX_CONTROLLER_HOST_ID`; default `local`). */
  readonly runnerHost?: string;
  /**
   * M14.2: the sandbox-controller's slots (ADR-0003 §6: H2 is asked of it). Read IN ADDITION to the grant count: the
   * free coding sessions are the lower of the two. An error is "cannot tell": no slot is free and the item waits.
   * Absent: the grant count alone (an in-process driver).
   */
  readonly slots?: SandboxSlotsPort;
  /** Called after an admission attempt, whatever it said (the capacity port's pledge for the item is spent). */
  readonly attempted?: (project_id: string) => void;
}

/** What the work driver is given to run admission: the ports and the cap (the pool and clock are its own). */
export type AdmissionPorts = Omit<AdmissionDeps, keyof CoreDeps>;

export type Admission =
  | {
      readonly admitted: true;
      readonly unit_id: string;
      readonly grant_id: string;
      readonly lease_epoch: number;
      readonly output_hash: string;
    }
  | { readonly admitted: false; readonly reason: AdmissionHold; readonly why: string };

const held = (reason: AdmissionHold, why: string): Result<Admission, CoreError> =>
  ok({ admitted: false, reason, why });

/** A Unit that others depend on is ready for its dependants once it has a pushed head. */
const DEPENDENCY_DONE: readonly UnitState[] = [
  'Pushed',
  'Verifying',
  'InReview',
  'Merged',
  'Released',
];

export const grantIdOf = (unitId: string, epoch: number): string => `${unitId}@${epoch}`;
/** The runner host a sandbox-controller names itself by default. */
export const DEFAULT_RUNNER_HOST = 'local';

/**
 * H2's cap (M15.5, portal-config §5 gap 10): the deployment's override, else the published `sandbox.caps` coding cap of
 * the runner host (`readSandboxCaps`: the controller's own reader, so core never admits more than the controller
 * places; anything unreadable is the defaults).
 */
export async function sessionCapOf(d: {
  readonly pool: pg.Pool;
  readonly sessionCap?: number;
  readonly runnerHost?: string;
}): Promise<number> {
  if (d.sessionCap !== undefined) return d.sessionCap;
  return (await readSandboxCaps(d.pool, d.runnerHost ?? DEFAULT_RUNNER_HOST)).coding;
}

/** The project's admission limits (ADR-0003 §6), or why they cannot be read (unknown is unmet: the item waits). */
async function projectLimits(
  pool: pg.Pool,
  projectId: string,
): Promise<Result<{ wip_limit: number | null; default_envelope: UnitEnvelope | null }, string>> {
  try {
    const r = await readAdmissionSettings(pool, projectId);
    return r.state === 'ok' ? ok(r.value) : err("the project's admission limits are unreadable");
  } catch (e) {
    return err(`the project's admission limits: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const PROJECT_ACTIVE_SQL = `SELECT count(*)::text AS n FROM core.admission_grant
  WHERE project_id = $1 AND status = 'active'`;

/** A Unit's envelope under the project's default envelope: never more than it (each bound separately). */
export const capEnvelope = (u: UnitEnvelope, cap: UnitEnvelope | null): UnitEnvelope =>
  cap === null
    ? u
    : {
        max_tokens: Math.min(u.max_tokens, cap.max_tokens),
        max_cost_micro_usd: Math.min(u.max_cost_micro_usd, cap.max_cost_micro_usd),
      };

/**
 * The coding sessions the sandbox-controller can start now (H2's second half), or `Infinity` where no controller is
 * wired. Unreachable, refused or malformed is 0: unknown means unmet, the item waits in core's queue.
 */
export async function controllerCodingFree(d: { slots?: SandboxSlotsPort }): Promise<number> {
  if (!d.slots) return Number.POSITIVE_INFINITY;
  try {
    const r = await d.slots.slots();
    return r.ok ? Math.max(0, freeCodingSlots(r.value)) : 0;
  } catch {
    return 0;
  }
}

/** The approver slot (H1): the G4 and X deciders exist in the role map. Unknown (an error) is unmet. */
export async function approverSlot(
  d: Pick<AdmissionDeps, 'settings'>,
  projectId: string,
): Promise<Result<AdmissionSlot, string>> {
  const got = await d.settings.get(projectId as never);
  if (!got.ok) return err(`the project's role map could not be read: ${got.error.code}`);
  const map = got.value.settings.role_map;
  const g4 = map.g4;
  const x = map.x;
  if (g4.kind === 'principals' && g4.principals.length === 0) {
    return err('no principal holds the g4 slot');
  }
  if (x.kind !== 'principals' || x.principals.length === 0) {
    return err('no principal holds the x slot');
  }
  return ok({
    g4: { kind: g4.kind, count: g4.kind === 'principals' ? g4.principals.length : 0 },
    x: { count: x.principals.length },
  });
}

/**
 * An item no plan made Units for (an L0 hotfix: "profile envelope + repro oracle") gets ONE implicit Unit `main`,
 * recorded as a `units.planned` event like any plan's, with the envelope the lane profile and the coder's
 * contract give a medium Unit (5.5's own function).
 */
async function ensureUnits(d: CoreDeps, s: ItemState): Promise<Result<Unit[], CoreError>> {
  const have = await listUnits(d.pool, s.item_id);
  if (have.length > 0) return ok(have);
  const cat = catalogueFor(s.catalogue_ref);
  if (!cat.ok)
    return err(coreError('refused', 'the item is pinned to a catalogue this build lacks'));
  const coder = primaryAgentFor('6.4')?.contract.budget;
  if (!coder) return err(coreError('unavailable', 'no coding budget contract'));
  const lane = s.lane ?? s.proposed_lane;
  const { envelopes } = budgetEnvelope({
    lane,
    lane_default_budget_cents: cat.value.lanes[lane].profile.default_envelope.budget_cents,
    coder_budget: coder,
    units: [{ unit_key: 'main', size: 'medium' }],
    base_sha: '',
  });
  const derived = envelopes.get('main');
  if (!derived) return err(coreError('unavailable', 'no envelope for the implicit Unit'));
  // M15.5: an item with no plan takes the project's default envelope when the project has one
  const limits = await projectLimits(d.pool, s.project_id);
  if (!limits.ok) return err(coreError('unavailable', limits.error));
  const envelope = limits.value.default_envelope ?? derived;
  const planned = await planUnits(d, {
    item_id: s.item_id,
    project_id: s.project_id,
    repo: s.repo,
    plan_sha256: hashCanonical({ implicit: true, item_id: s.item_id }),
    base_sha: null,
    units: [
      {
        unit_key: 'main',
        title: 'The whole request (no plan: the lane profile envelope)',
        paths: ['.'],
        size: 'medium',
        depends_on: [],
        position: 0,
        envelope,
      },
    ],
  });
  if (!planned.ok) return planned;
  return ok(await listUnits(d.pool, s.item_id));
}

/** The next Unit to admit: the first `Planned` one, in DAG order, whose dependencies have a pushed head. */
export function nextUnit(units: readonly Unit[]): Unit | null {
  const state = new Map(units.map((u) => [u.unit_key, u.state]));
  for (const u of [...units].sort((a, b) => a.position - b.position)) {
    if (u.state !== 'Planned') continue;
    if (u.depends_on.every((k) => DEPENDENCY_DONE.includes(state.get(k) as UnitState))) return u;
  }
  return null;
}

/** The recorded admission of a command, if there is one (a redelivery after the commit gets the same answer). */
async function recordedAdmission(
  pool: pg.Pool,
  itemId: string,
  key: string,
): Promise<UnitAdmittedPayload | null> {
  const q = await pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND idempotency_key = $2`,
    [unitStream(itemId), `admit:${key}`],
  );
  const row = q.rows[0];
  return row ? UnitAdmittedPayload.parse(row.body) : null;
}

const answerOf = (p: UnitAdmittedPayload): Admission => ({
  admitted: true,
  unit_id: p.unit_id,
  grant_id: p.grant_id,
  lease_epoch: p.lease_epoch,
  output_hash: hashCanonical({ grant_id: p.grant_id, unit_id: p.unit_id, epoch: p.lease_epoch }),
});

/**
 * The checks and the write of one admission, for the Unit `u` (or a re-admission of a waiting grant: `resumes`).
 * Returns HELD with the first failing check's reason, or the grant.
 */
export async function admitCandidate(
  d: AdmissionDeps,
  s: ItemState,
  u: Unit,
  command_key: string,
  resumes: { grant_id: string; snapshot_ref: string } | null,
): Promise<Result<Admission, CoreError>> {
  try {
    // H1: the approver slot
    const slot = await approverSlot(d, s.project_id);
    if (!slot.ok) return held('H1', slot.error);
    // H2: capacity (a first look; the write below checks it again under the lock)
    const cap = await sessionCapOf(d);
    if ((await activeGrantCount(d.pool)) >= cap) {
      return held('H2', `${cap} coding session(s) already hold a slot`);
    }
    if ((await controllerCodingFree(d)) <= 0) {
      return held('H2', 'the sandbox-controller has no free coding slot (or did not answer)');
    }
    // M15.5: the project's WIP limit and default envelope (ADR-0003 §6), unreadable is unmet
    const limits = await projectLimits(d.pool, s.project_id);
    if (!limits.ok) return held('WIP', limits.error);
    const wip = limits.value.wip_limit;
    if (wip !== null) {
      const n = await d.pool.query<{ n: string }>(PROJECT_ACTIVE_SQL, [s.project_id]);
      if (Number(n.rows[0]?.n ?? 0) >= wip) {
        return held('WIP', `the project's WIP limit (${wip}) is reached`);
      }
    }
    const envelopeIn = capEnvelope(u.envelope, limits.value.default_envelope);
    // H3: the envelope, reserved in the gateway for this Unit (idempotent)
    const group_id = `unit-envelope:${u.unit_id}`;
    const r = await d.envelope.reserve({
      group_id,
      max_tokens: envelopeIn.max_tokens,
      max_cost_micro_usd: envelopeIn.max_cost_micro_usd,
    });
    if (!r.ok) return held('H3', `the envelope could not be reserved: ${r.error.code}`);

    // (a) the lease and the grant, together, under the item's lock and the capacity check
    const w = await inCoreTx(d, async (j, tx) => {
      await lockKeys(tx, [unitLockKey(s.item_id), 'admission:capacity']);
      const again = await recordedAdmission(d.pool, s.item_id, command_key);
      if (again) return ok(answerOf(again));
      const n = await tx.query<{ n: string }>(ACTIVE_SESSIONS_SQL);
      if (Number(n.rows[0]?.n ?? 0) >= cap) {
        return ok<Admission>({
          admitted: false,
          reason: 'H2',
          why: 'capacity was taken meanwhile',
        });
      }
      if (wip !== null) {
        const p = await tx.query<{ n: string }>(PROJECT_ACTIVE_SQL, [s.project_id]);
        if (Number(p.rows[0]?.n ?? 0) >= wip) {
          return ok<Admission>({
            admitted: false,
            reason: 'WIP',
            why: `the project's WIP limit (${wip}) was reached meanwhile`,
          });
        }
      }
      const cur = await tx.query<{ epoch: number; status: string; holder_kind: string }>(
        'SELECT epoch, status, holder_kind FROM core.lease WHERE unit_id = $1 FOR UPDATE',
        [u.unit_id],
      );
      const lease = cur.rows[0];
      // another holder has the branch: a developer (takeover) or a session that is still granted: WIP
      const live = await tx.query(
        `SELECT 1 FROM core.admission_grant WHERE unit_id = $1 AND status = 'active'`,
        [u.unit_id],
      );
      if (
        lease &&
        lease.status === 'held' &&
        (lease.holder_kind === 'human' || live.rows.length > 0)
      ) {
        return ok<Admission>({
          admitted: false,
          reason: 'WIP',
          why: `the branch of ${u.unit_id} is leased (epoch ${lease.epoch}, ${lease.holder_kind})`,
        });
      }
      // fresh: above this Unit's last epoch AND above every epoch the item's engine has handed out
      const epoch = Math.max(lease?.epoch ?? 0, s.lease_seq) + 1;
      const payload = UnitAdmittedPayload.parse({
        grant_id: grantIdOf(u.unit_id, epoch),
        unit_id: u.unit_id,
        item_id: s.item_id,
        project_id: s.project_id,
        repo: s.repo,
        unit_key: u.unit_key,
        branch: unitBranchOf(s.item_id, u.unit_key),
        lease_epoch: epoch,
        slot: slot.value,
        envelope: {
          ref: group_id,
          max_tokens: envelopeIn.max_tokens,
          max_cost_micro_usd: envelopeIn.max_cost_micro_usd,
        },
        command_key,
        resumes,
      });
      const e = await emitUnitEvent(
        j,
        tx,
        s.item_id,
        UNIT_EVENT.admitted,
        payload,
        `admit:${command_key}`,
      );
      if (!e.ok) return e;
      return ok(answerOf(payload));
    });
    return w;
  } finally {
    d.attempted?.(s.project_id);
  }
}

/**
 * 6.0 for an item: picks its next Unit and admits it. HELD (`WIP`) when no Unit can be admitted yet (every
 * Unit is admitted already, or the dependencies of the next have no pushed head).
 */
export async function admitUnit(
  d: AdmissionDeps,
  s: ItemState,
  command_key: string,
): Promise<Result<Admission, CoreError>> {
  const again = await recordedAdmission(d.pool, s.item_id, command_key);
  if (again) return ok(answerOf(again));
  // M16 part 3 (OB §8): no session starts on a repo whose agent work is held (a suspended readiness record)
  const hold = await itemWorkHold(d.pool, s);
  if (hold) {
    d.attempted?.(s.project_id);
    return held('WIP', hold.why);
  }
  const units = await ensureUnits(d, s);
  if (!units.ok) return units;
  const u = nextUnit(units.value);
  if (!u) {
    d.attempted?.(s.project_id);
    return held('WIP', 'no Unit of the item can be admitted yet');
  }
  return admitCandidate(d, s, u, command_key, null);
}

// ---------------------------------------------------------------- Stale epochs

/**
 * The epoch rule, as a function every writer calls: a write that names a lease epoch is refused unless the
 * Unit's lease is HELD at exactly that epoch (a smaller one is stale; a larger one was never granted; a released
 * lease takes no writes). `unit_id` the Unit, `epoch` what the writer was given at admission.
 */
export async function assertLeaseEpoch(
  db: Pick<pg.Pool, 'query'>,
  unitId: string,
  epoch: number,
): Promise<Result<void, CoreError>> {
  const q = await db.query<{ epoch: number; status: string }>(
    'SELECT epoch, status FROM core.lease WHERE unit_id = $1',
    [unitId],
  );
  const l = q.rows[0];
  if (!l) return err(coreError('refused', `no lease for ${unitId}`, { code: 'no_lease' }));
  if (epoch < l.epoch) {
    return err(
      coreError('refused', `stale lease epoch ${epoch}: the lease is at ${l.epoch}`, {
        code: 'stale_epoch',
        current: l.epoch,
      }),
    );
  }
  if (epoch > l.epoch || l.status !== 'held') {
    return err(
      coreError('refused', `epoch ${epoch} is not a held lease of ${unitId}`, { code: 'not_held' }),
    );
  }
  return ok(undefined);
}

/**
 * A Unit moved (a session began, a patch was pushed, the evidence was verified, the PR was reviewed...): the
 * later milestones' writer. The lease epoch the caller holds must be the held one, and the move must be one the
 * Unit's state table draws.
 */
export async function recordUnitProgress(
  d: CoreDeps,
  p: {
    item_id: string;
    unit_id: string;
    lease_epoch: number;
    to: UnitState;
    reason: string;
    key: string;
    head_sha?: string;
    pr_ref?: string;
  },
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [unitLockKey(p.item_id)]);
    const fresh = await assertLeaseEpoch(tx, p.unit_id, p.lease_epoch);
    if (!fresh.ok) return fresh;
    const cur = await tx.query<{ state: UnitState }>(
      'SELECT state FROM core.unit WHERE unit_id = $1',
      [p.unit_id],
    );
    const from = cur.rows[0]?.state;
    if (from === undefined) return err(coreError('not_found', `no Unit ${p.unit_id}`));
    if (from !== p.to && !canTransitionUnit(from, p.to)) {
      return err(coreError('conflict', `a Unit cannot go from ${from} to ${p.to}`));
    }
    const e = await emitUnitEvent(
      j,
      tx,
      p.item_id,
      UNIT_EVENT.state_changed,
      {
        unit_id: p.unit_id,
        item_id: p.item_id as never,
        lease_epoch: p.lease_epoch,
        to: p.to,
        ...(p.head_sha ? { head_sha: p.head_sha } : {}),
        ...(p.pr_ref ? { pr_ref: p.pr_ref } : {}),
        reason: p.reason,
      },
      `unit:state:${p.key}`,
    );
    return e.ok ? ok({ duplicate: e.value.duplicate }) : e;
  });
}
