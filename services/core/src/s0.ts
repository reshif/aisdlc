import { currentCatalogueRef } from '@aisdlc/catalogue';
import {
  BOOTSTRAP_CARDS,
  BOOTSTRAP_ENTRY_TYPE,
  PROJECT_EVENT,
  S0BootstrapGrantedPayload,
  REPO_EVENT,
  S0_EVENT,
  canTransitionOnboarding,
  levelRank,
  projectStream,
  repoIdOf,
  repoKeyOf,
  repoStream,
  s0Stream,
  type CatalogueRef,
  type CauseCode,
  type LedgerEntryDraft,
  type LedgerEntryId,
  type Level,
  type OnboardAttestations,
  type Tier,
  type OnboardRequest,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingStepState,
  type S0CardRequiredPayload,
  type S0StatusChangedPayload,
  type S0StepChangedPayload,
  type CardKind,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION } from '@aisdlc/decisions';
import { deterministicId, err, newId, ok, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type PendingConfirm,
} from '@aisdlc/ledger';
import type { PoolClient } from 'pg';
import { BOOTSTRAP_SLOT, bootstrapApplies } from './bootstrap.js';
import { coreError, type CoreError } from './errors.js';
import { isTerminal, type S0State } from './fold.js';
import {
  clockOf,
  inCoreLedgerTx,
  inCoreTx,
  lockKeys,
  type CoreDeps,
  type Journal,
} from './journal.js';

// The S0 record's writes (PLAN M7.1, M7.2): the `project.onboard` intake and every transition of the
// OnboardingRecord state machine (contracts `states/onboarding.ts`, exactly). A write folds the
// authoritative stream under the record's lock, checks the machine and the step's own state, and
// appends; an illegal transition is refused with `conflict` and nothing is written. Every change is
// one record event on the `s0:<uuid>` stream, so the read model rebuilds equal to live.

export const SYSTEM_ACTOR = 'system.core';

// ---------------------------------------------------------------- primitives (inside a transaction)

interface StatusOpts {
  readonly actor: string;
  readonly cause: CauseCode | null;
  readonly reason?: string | null;
  readonly superseded_by?: string | null;
  readonly rejected_at?: OnboardingStepId | null;
}

/** One edge of the machine. The caller holds the record's lock and has folded `s0`. */
export async function changeStatus(
  j: Journal,
  s0: S0State,
  to: OnboardingStatus,
  o: StatusOpts,
): Promise<Result<S0State, CoreError>> {
  const from = s0.record.status;
  if (!canTransitionOnboarding(from, to)) {
    return err(coreError('conflict', `an S0 record cannot go from ${from} to ${to}`));
  }
  const payload: S0StatusChangedPayload = {
    from,
    to,
    cause: o.cause,
    reason: o.reason ?? null,
    superseded_by: (o.superseded_by ?? null) as S0StatusChangedPayload['superseded_by'],
    rejected_at: o.rejected_at ?? null,
  };
  const w = await j.emit(s0Stream(s0.record.s0_id), S0_EVENT.status_changed, payload, o.actor);
  if (!w.ok) return w;
  return reload(j, s0);
}

/**
 * `from -> to`, through `running` when the machine has no direct edge (a card or a parked record
 * is superseded, or parked, only by way of `running`: both edges are in the table, so both are
 * recorded and nothing is bent). Refused when there is no way.
 */
export async function changeStatusVia(
  j: Journal,
  s0: S0State,
  to: OnboardingStatus,
  o: StatusOpts,
): Promise<Result<S0State, CoreError>> {
  const from = s0.record.status;
  if (canTransitionOnboarding(from, to)) return changeStatus(j, s0, to, o);
  if (canTransitionOnboarding(from, 'running') && canTransitionOnboarding('running', to)) {
    const first = await changeStatus(j, s0, 'running', {
      actor: o.actor,
      cause: 'transit',
      reason: `on the way to ${to}`,
    });
    if (!first.ok) return first;
    return changeStatus(j, first.value, to, o);
  }
  return err(coreError('conflict', `an S0 record cannot go from ${from} to ${to}`));
}

export async function changeStep(
  j: Journal,
  s0: S0State,
  step: OnboardingStepId,
  state: OnboardingStepState,
  o: { actor: string; blocked_cause?: CauseCode | null; reason?: string | null },
): Promise<Result<S0State, CoreError>> {
  const payload: S0StepChangedPayload = {
    step,
    state,
    blocked_cause: state === 'blocked' ? (o.blocked_cause ?? 'blocked') : null,
    reason: o.reason ?? null,
  };
  const w = await j.emit(s0Stream(s0.record.s0_id), S0_EVENT.step_changed, payload, o.actor);
  if (!w.ok) return w;
  return reload(j, s0);
}

/** Re-folds the record's stream, which includes what this transaction appended. */
async function reload(j: Journal, s0: S0State): Promise<Result<S0State, CoreError>> {
  const next = await j.s0(s0.record.s0_id);
  return next ? ok(next) : err(coreError('database', 'the S0 stream vanished'));
}

/** Locks the record and folds it; `not_found` when it has no stream. */
async function open(j: Journal, s0Id: string): Promise<Result<S0State, CoreError>> {
  await lockKeys(j.tx, [`s0:${s0Id}`]);
  const s0 = await j.s0(s0Id);
  return s0 ? ok(s0) : err(coreError('not_found', `no S0 record ${s0Id}`));
}

const requireStatus = (s0: S0State, ...allowed: OnboardingStatus[]): CoreError | null =>
  allowed.includes(s0.record.status)
    ? null
    : coreError('conflict', `the S0 record is ${s0.record.status}, not ${allowed.join(' or ')}`);

// ---------------------------------------------------------------- the intake (DEC-2)

export interface OnboardResult {
  readonly s0_id: string;
  /** `record:<intake event id>` (DEC-2). */
  readonly s0_ref: string;
  readonly project_id: string;
  readonly repo: string;
  readonly project_created: boolean;
  /** Older, unfinished S0 records of this repo that this one replaced. */
  readonly superseded: readonly string[];
  /** True when `request_id` had been seen: nothing was written. */
  readonly duplicate: boolean;
  /** The provisional admin this intake granted (PLAN M7.4), or `null`: the usual case. */
  readonly bootstrap: { readonly grantee: string; readonly ledger_entry_id: string } | null;
}

export interface OnboardOptions {
  /** The catalogue pin the record starts with. Default: this build's catalogue. */
  readonly catalogue?: CatalogueRef;
  /**
   * User decision 2026-11-12 (PLAN §7a): Full is reached ONLY as a level-up of a repo signed at Light (card 3 is decided
   * by the intent slot, which exists only after card 4's role map, and the bootstrap grant never covers card 3). The
   * level-up request (`requestVersion`) passes the version it raises (`light`), and the re-sign of an expired Full
   * record the version it renews (`full`); any other request for Full is refused.
   */
  readonly levelUp?: { readonly from_version: number; readonly from_level: 'light' | 'full' };
}

/** Why a request for Full that is not a level-up is refused (user decision 2026-11-12). */
export const FULL_ONLY_AS_LEVEL_UP =
  "Full is reached only as a level-up after a Light onboarding: card 3 is decided by the intent slot, which exists only after card 4's role map. Onboard at Light first, then ask for a level-up to Full.";

const hasAttestations = (a: OnboardAttestations | undefined): a is OnboardAttestations =>
  a !== undefined && Object.keys(a).length > 0;

/**
 * The `project.onboard` request, after the PDP allowed it: registers the project (if new) and the
 * repo, records the intake event, and creates the S0 record in `app`, with 0.2 and 0.3 recorded as
 * `skip` (not requested, DEC-3) where the level does not ask for them. The record stores
 * `s0_ref = record:<intake event id>`, its own UUID (the future gate subject of M4 and S0 X2, fix
 * #32: not a delivery item) and the catalogue pin. A newer S0 record for the same repo supersedes
 * every older one that has not ended.
 */
export async function requestOnboarding(
  deps: CoreDeps,
  req: OnboardRequest,
  opts: OnboardOptions = {},
): Promise<Result<OnboardResult, CoreError>> {
  const actor = req.on_behalf_of;
  const key = repoKeyOf(req.repo);
  const s0Id = req.request_id
    ? deterministicId<'S0Record'>(`aisdlc.s0:${req.request_id}`)
    : newId<'S0Record'>();
  const catalogue = opts.catalogue ?? currentCatalogueRef();
  type Done = { value: OnboardResult; pending: readonly PendingConfirm[] };
  const body = async (
    j: Journal,
    tx: PoolClient,
    ledger: NonNullable<CoreDeps['ledger']> | null,
  ): Promise<Result<Done, CoreError>> => {
    await lockKeys(tx, [`project:${req.project_id}`, `repo:${key}`, `s0:${s0Id}`]);

    // A retry of a request already recorded is that request.
    if (req.request_id) {
      const seen = await j.s0(s0Id);
      if (seen) {
        if (
          seen.record.project_id !== req.project_id ||
          repoKeyOf(seen.repo) !== key ||
          seen.record.requested_level !== req.level
        ) {
          return err(coreError('conflict', 'request_id was used for a different request'));
        }
        return ok({
          value: {
            s0_id: s0Id,
            s0_ref: seen.record.intake_ref,
            project_id: req.project_id,
            repo: seen.repo,
            project_created: false,
            superseded: [],
            duplicate: true,
            bootstrap: null,
          },
          pending: [],
        });
      }
    }

    if (req.level === 'full' && !opts.levelUp)
      return err(coreError('refused', FULL_ONLY_AS_LEVEL_UP));

    const existingRepo = await j.repo(req.repo);
    if (existingRepo && existingRepo.project_id !== req.project_id) {
      return err(
        coreError(
          'conflict',
          `repository ${existingRepo.repo_ref} belongs to project ${existingRepo.project_id}`,
        ),
      );
    }

    // The older S0 records of this repo (the repo key is held, so no other request is adding one).
    const older = await tx.query<{ s0_id: string }>(
      `SELECT body ->> 's0_id' AS s0_id FROM record.record_event
        WHERE type = $1 AND lower(body ->> 'repo') = $2 ORDER BY global_seq`,
      [S0_EVENT.requested, key],
    );
    const olderIds = older.rows.map((r) => r.s0_id).filter((id) => id !== s0Id);
    await lockKeys(
      tx,
      olderIds.map((id) => `s0:${id}`),
    );

    // The bootstrap decider (PLAN M7.4): the project's first onboarding, with no published role
    // map and no other live grant (an older request of this repo that this one supersedes does not
    // count), makes the requester the provisional admin of this record's cards 1, 2, 4 and 5. It
    // needs the ledger: the grant is stated there, or it is not made. The ledger lock is taken
    // here, before the first record append, and the entry is written last (AGENTS.md lock order).
    const pending: PendingConfirm[] = [];
    let grantEntryId: LedgerEntryId | null = null;
    if (ledger && (await bootstrapApplies(tx, req.project_id, olderIds))) {
      await lockLedger(tx);
      const caught = await importUnconfirmed(tx, ledger);
      if (!caught.ok) return err(coreError('unavailable', caught.error.message));
      pending.push(...caught.value.pending);
      grantEntryId = newId<'LedgerEntry'>(clockOf(deps).nowMs());
    }

    // Project.
    let projectCreated = false;
    if (!(await j.project(req.project_id))) {
      const w = await j.emit(
        projectStream(req.project_id),
        PROJECT_EVENT.registered,
        {
          project_id: req.project_id,
          name: req.name ?? req.project_id,
          team_id: req.team_id ?? null,
          classification: 'internal',
          stack: null,
          deploys: null,
          owner: null,
          requested_by: actor,
        },
        actor,
      );
      if (!w.ok) return w;
      projectCreated = true;
    }
    if (hasAttestations(req.attestations)) {
      const w = await j.emit(
        projectStream(req.project_id),
        PROJECT_EVENT.attested,
        { s0_id: s0Id, attestations: req.attestations, by: actor },
        actor,
      );
      if (!w.ok) return w;
    }

    // Repo.
    if (!existingRepo) {
      const [owner, name] = req.repo.split('/') as [string, string];
      const w = await j.emit(
        repoStream(req.repo),
        REPO_EVENT.registered,
        {
          repo_id: repoIdOf(req.repo),
          repo_ref: req.repo,
          project_id: req.project_id,
          host: 'github.com',
          owner,
          name,
        },
        actor,
      );
      if (!w.ok) return w;
    }

    // The intake event. Its own id is the record's `s0_ref`.
    const intakeId = newId<'RecordEvent'>();
    const intake = await j.emit(
      s0Stream(s0Id),
      S0_EVENT.requested,
      {
        s0_id: s0Id,
        project_id: req.project_id,
        repo: req.repo,
        repo_id: repoIdOf(req.repo),
        requested_level: req.level,
        attestations: req.attestations ?? {},
        requested_by: actor,
        catalogue_ref: catalogue,
      },
      actor,
      { event_id: intakeId },
    );
    if (!intake.ok) return intake;
    let s0 = (await j.s0(s0Id)) as S0State;
    if (grantEntryId !== null) {
      const g = await j.emit(
        s0Stream(s0Id),
        S0_EVENT.bootstrap_granted,
        S0BootstrapGrantedPayload.parse({
          s0_id: s0Id,
          project_id: req.project_id,
          grantee: actor,
          slot: BOOTSTRAP_SLOT,
          cards: [...BOOTSTRAP_CARDS],
          basis: 'first_onboarding_no_role_map',
          ledger_entry_id: grantEntryId,
        }),
        actor,
      );
      if (!g.ok) return g;
    }
    // DEC-3: 0.2 and 0.3 run only if requested; otherwise they are recorded, never silently absent.
    for (const [step, needs] of [
      ['0.2', 'light'],
      ['0.3', 'full'],
    ] as const) {
      if (levelRank(req.level) >= levelRank(needs)) continue;
      const r = await changeStep(j, s0, step, 'skip', { actor, reason: 'not_requested' });
      if (!r.ok) return r;
      s0 = r.value;
    }

    const superseded: string[] = [];
    for (const id of olderIds) {
      const old = await j.s0(id);
      if (!old || isTerminal(old.record.status)) continue;
      const r = await changeStatusVia(j, old, 'superseded', {
        actor,
        cause: 'superseded',
        reason: 'a newer S0 record exists for the repository',
        superseded_by: s0Id,
      });
      if (!r.ok) return r;
      superseded.push(id);
    }

    // The ledger entry that states the provisional grant: the LAST write.
    if (ledger && grantEntryId !== null) {
      const draft: LedgerEntryDraft = {
        entry_id: grantEntryId,
        entry_type: BOOTSTRAP_ENTRY_TYPE,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: 's0_record',
        subject_id: s0Id,
        subject_hash: null,
        decision: null,
        actor,
        sod_waiver: false,
        policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
        body: {
          kind: 'bootstrap_grant',
          project_id: req.project_id,
          grantee: actor,
          slot: BOOTSTRAP_SLOT,
          cards: [...BOOTSTRAP_CARDS],
          basis: 'first_onboarding_no_role_map',
          s0_ref: s0.record.intake_ref,
        },
        created_at: clockOf(deps).now().toISOString(),
      };
      const w = await appendLedgerEntryTx(tx, ledger, draft);
      if (!w.ok) return err(coreError('unavailable', w.error.message));
      pending.push(...w.value.pending);
    }
    return ok({
      value: {
        s0_id: s0Id,
        s0_ref: s0.record.intake_ref,
        project_id: req.project_id,
        repo: req.repo,
        project_created: projectCreated,
        superseded,
        duplicate: false,
        bootstrap: grantEntryId === null ? null : { grantee: actor, ledger_entry_id: grantEntryId },
      },
      pending,
    });
  };
  if (deps.ledger) {
    const ledger = deps.ledger;
    return inCoreLedgerTx<OnboardResult>({ ...deps, ledger }, (j, tx) => body(j, tx, ledger));
  }
  return inCoreTx<OnboardResult>(deps, async (j, tx) => {
    const r = await body(j, tx, null);
    return r.ok ? ok(r.value.value) : r;
  });
}

// ---------------------------------------------------------------- human-side transitions

/** Statuses an S0 record may be withdrawn from (DM §6.3 `WITHDRAWABLE`). */
export async function withdrawS0(
  deps: CoreDeps,
  s0Id: string,
  o: { actor: string; reason?: string },
): Promise<Result<{ status: OnboardingStatus; changed: boolean }, CoreError>> {
  return inCoreTx<{ status: OnboardingStatus; changed: boolean }>(deps, async (j) => {
    const s0 = await open(j, s0Id);
    if (!s0.ok) return s0;
    if (s0.value.record.status === 'withdrawn') {
      return ok({ status: 'withdrawn' as const, changed: false });
    }
    const r = await changeStatus(j, s0.value, 'withdrawn', {
      actor: o.actor,
      cause: 'withdrawn',
      reason: o.reason ?? null,
    });
    return r.ok ? ok({ status: 'withdrawn' as const, changed: true }) : r;
  });
}

/**
 * `blocked`, `parked`, `starter` or `rejected` back to `running`: a retry, a resume, a merged
 * starter, a restore request. The step that was blocked, parked or rejected returns to `running`
 * too (failures start at 0; a rejected step has a fresh send-back allowance), and the driver picks
 * up from there, raising the step's card again.
 */
export async function resumeS0(
  deps: CoreDeps,
  s0Id: string,
  o: { actor: string; reason?: string },
): Promise<Result<S0State, CoreError>> {
  return inCoreTx(deps, async (j) => {
    const opened = await open(j, s0Id);
    if (!opened.ok) return opened;
    let s0 = opened.value;
    const refused = requireStatus(s0, 'blocked', 'parked', 'starter', 'rejected');
    if (refused) return err(refused);
    const rejectedAt = s0.record.rejected_at;
    const r = await changeStatus(j, s0, 'running', {
      actor: o.actor,
      cause: `resumed.${s0.record.status}`,
      reason: o.reason ?? null,
    });
    if (!r.ok) return r;
    s0 = r.value;
    for (const step of s0.steps.values()) {
      const stuck = step.state === 'blocked' || (step.step === rejectedAt && step.state === 'card');
      if (!stuck) continue;
      const c = await changeStep(j, s0, step.step, 'running', {
        actor: o.actor,
        reason: 'resumed',
      });
      if (!c.ok) return c;
      s0 = c.value;
    }
    return ok(s0);
  });
}

/**
 * A person's "send back" at a human step (DEC-9). The first one per step returns the step to
 * `running` (the factory re-drafts and raises the card again); a second one rejects the record at
 * that step (`rejected_at:<step>`).
 */
export async function sendBackStep(
  deps: CoreDeps,
  s0Id: string,
  step: OnboardingStepId,
  o: { actor: string; reason?: string; limit: number },
): Promise<Result<{ outcome: 'sent_back' | 'rejected'; count: number }, CoreError>> {
  return inCoreTx<{ outcome: 'sent_back' | 'rejected'; count: number }>(deps, async (j) => {
    const opened = await open(j, s0Id);
    if (!opened.ok) return opened;
    return sendBackIn(j, opened.value, step, o);
  });
}

/** `sendBackStep` inside a transaction that holds the record's lock (the card layer's apply). */
export async function sendBackIn(
  j: Journal,
  s0Start: S0State,
  step: OnboardingStepId,
  o: { actor: string; reason?: string; limit: number },
): Promise<Result<{ outcome: 'sent_back' | 'rejected'; count: number }, CoreError>> {
  let s0 = s0Start;
  const s0Id = s0.record.s0_id;
  const refused = requireStatus(s0, 'card');
  if (refused) return err(refused);
  const st = s0.steps.get(step);
  if (!st || st.state !== 'card') {
    return err(coreError('conflict', `step ${step} has no card waiting for a person`));
  }
  const count = st.send_backs + 1;
  const w = await j.emit(
    s0Stream(s0Id),
    S0_EVENT.send_back,
    { step, count, by: o.actor, reason: o.reason ?? null },
    o.actor,
  );
  if (!w.ok) return w;
  s0 = (await j.s0(s0Id)) as S0State;
  if (count > o.limit) {
    const r = await changeStatus(j, s0, 'rejected', {
      actor: o.actor,
      cause: 'send_back.exhausted',
      reason: o.reason ?? null,
      rejected_at: step,
    });
    return r.ok ? ok({ outcome: 'rejected' as const, count }) : r;
  }
  const c = await changeStep(j, s0, step, 'running', {
    actor: o.actor,
    reason: 'sent_back',
  });
  if (!c.ok) return c;
  const r = await changeStatus(j, c.value, 'running', {
    actor: o.actor,
    cause: 'send_back',
    reason: o.reason ?? null,
  });
  return r.ok ? ok({ outcome: 'sent_back' as const, count }) : r;
}

/**
 * The card layer's hand-back (M7.3): the human step is decided. The step is `done` and the record
 * goes back to `running`, for the driver to take the next step.
 */
export async function completeStep(
  deps: CoreDeps,
  s0Id: string,
  step: OnboardingStepId,
  o: { actor: string },
): Promise<Result<S0State, CoreError>> {
  return inCoreTx(deps, async (j) => {
    const opened = await open(j, s0Id);
    if (!opened.ok) return opened;
    return completeStepIn(j, opened.value, step, o);
  });
}

/** `completeStep` inside a transaction that holds the record's lock (the card layer's apply). */
export async function completeStepIn(
  j: Journal,
  s0: S0State,
  step: OnboardingStepId,
  o: { actor: string },
): Promise<Result<S0State, CoreError>> {
  const refused = requireStatus(s0, 'card');
  if (refused) return err(refused);
  if (s0.steps.get(step)?.state !== 'card') {
    return err(coreError('conflict', `step ${step} has no card waiting for a person`));
  }
  const c = await changeStep(j, s0, step, 'done', { actor: o.actor });
  if (!c.ok) return c;
  return changeStatus(j, c.value, 'running', { actor: o.actor, cause: 'card.decided' });
}

/**
 * Records the level this onboarding will sign, at or below the requested one (DEC-9: "the human may
 * sign a lower level"). Requested and signable are both kept. Steps the level no longer reaches
 * that have not started are recorded as `skip`.
 */
export async function setSignableLevel(
  deps: CoreDeps,
  s0Id: string,
  level: Level,
  o: { actor: string; reason: CauseCode },
): Promise<Result<S0State, CoreError>> {
  return inCoreTx(deps, async (j) => {
    const opened = await open(j, s0Id);
    if (!opened.ok) return opened;
    return applySignableLevel(j, opened.value, level, o);
  });
}

export async function applySignableLevel(
  j: Journal,
  s0Start: S0State,
  level: Level,
  o: { actor: string; reason: CauseCode },
): Promise<Result<S0State, CoreError>> {
  let s0 = s0Start;
  if (isTerminal(s0.record.status)) {
    return err(coreError('conflict', `the S0 record is ${s0.record.status}`));
  }
  if (levelRank(level) > levelRank(s0.record.requested_level)) {
    return err(
      coreError('invalid_input', 'the signable level cannot be above the requested level'),
    );
  }
  if (level === s0.record.signable_level) return ok(s0);
  const w = await j.emit(
    s0Stream(s0.record.s0_id),
    S0_EVENT.signable_level_set,
    {
      requested_level: s0.record.requested_level,
      signable_level: level,
      reason: o.reason,
      by: o.actor,
    },
    o.actor,
  );
  if (!w.ok) return w;
  s0 = (await j.s0(s0.record.s0_id)) as S0State;
  for (const [step, needs] of [
    ['0.2', 'light'],
    ['0.3', 'full'],
  ] as const) {
    const st = s0.steps.get(step);
    if (!st || st.state !== 'todo' || levelRank(level) >= levelRank(needs)) continue;
    const r = await changeStep(j, s0, step, 'skip', {
      actor: o.actor,
      reason: 'above_signable_level',
    });
    if (!r.ok) return r;
    s0 = r.value;
  }
  return ok(s0);
}

// ---------------------------------------------------------------- hand-off to the card layer

export const CARD_OF_STEP: Readonly<Record<OnboardingStepId, CardKind>> = {
  '0.1': 'C1',
  '0.2': 'C2',
  '0.3': 'C3',
  '0.4': 'C4',
  '0.5': 'C5',
};

/**
 * A step reached its person: `card_required` is recorded (the card layer, M7.3, opens the card),
 * the step is `card` and the record `card`. `kinds` adds separate cards raised by the same step
 * (the security card at 0.1).
 */
export async function raiseCard(
  j: Journal,
  s0Start: S0State,
  step: OnboardingStepId,
  o: { actor: string; extra?: readonly CardKind[] },
): Promise<Result<S0State, CoreError>> {
  let s0 = s0Start;
  const st = s0.steps.get(step) as NonNullable<ReturnType<S0State['steps']['get']>>;
  const reduced = step === '0.4' && s0.record.signable_level === 'census';
  const payload = (card: CardKind): S0CardRequiredPayload => ({
    step,
    card,
    reduced: card === 'C4' && reduced,
    occasion: st.card_raises === 0 ? 'first' : 'again',
  });
  if (st.state === 'todo') {
    const r = await changeStep(j, s0, step, 'running', { actor: o.actor });
    if (!r.ok) return r;
    s0 = r.value;
  }
  for (const card of [CARD_OF_STEP[step], ...(o.extra ?? [])]) {
    const w = await j.emit(
      s0Stream(s0.record.s0_id),
      S0_EVENT.card_required,
      payload(card),
      o.actor,
    );
    if (!w.ok) return w;
  }
  const c = await changeStep(j, (await j.s0(s0.record.s0_id)) as S0State, step, 'card', {
    actor: o.actor,
  });
  if (!c.ok) return c;
  return changeStatus(j, c.value, 'card', { actor: o.actor, cause: 'card.required' });
}

export { open as openS0 };

// ---------------------------------------------------------------- what M4 signs (M7.5 calls this)

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };

/**
 * Records what M4 signed: the project's tier and level, and the repo's onboarding level. The
 * signed level is at most the record's `signable_level` (DEC-9: requested and signable are both
 * kept, and the human may sign a lower one), and the tier is never below a floor attested at the
 * request (raise-only). This writes the Project and Repo streams only: the S0 record's own move to
 * `done` and the PRR's activation are `approveM4In`'s (m4.ts), in the same transaction.
 */
export async function recordSigned(
  deps: CoreDeps,
  input: { s0_id: string; tier: Tier; level: Level; actor: string },
): Promise<Result<{ project_id: string; repo: string }, CoreError>> {
  return inCoreTx<{ project_id: string; repo: string }>(deps, async (j, tx) => {
    const opened = await open(j, input.s0_id);
    if (!opened.ok) return opened;
    return recordSignedIn(j, tx, opened.value, input);
  });
}

/**
 * `recordSigned` inside a transaction that holds the record's lock (M4's apply, PLAN M7.5). The
 * caller also holds the project and repo locks, taken together with the record's, in that order.
 */
export async function recordSignedIn(
  j: Journal,
  tx: PoolClient,
  s0: S0State,
  input: { s0_id: string; tier: Tier; level: Level; actor: string },
): Promise<Result<{ project_id: string; repo: string }, CoreError>> {
  await lockKeys(tx, [`project:${s0.record.project_id}`, `repo:${repoKeyOf(s0.repo)}`]);
  if (s0.record.status === 'withdrawn' || s0.record.status === 'superseded') {
    return err(coreError('conflict', `the S0 record is ${s0.record.status}`));
  }
  if (levelRank(input.level) > levelRank(s0.record.signable_level)) {
    return err(
      coreError(
        'refused',
        `this onboarding can sign ${s0.record.signable_level} at most (requested ${s0.record.requested_level})`,
      ),
    );
  }
  const project = await j.project(s0.record.project_id);
  if (!project) return err(coreError('not_found', 'the project of the record is missing'));
  const floor = project.attestations.tier_floor;
  if (floor !== undefined && TIER_RANK[input.tier] < TIER_RANK[floor]) {
    return err(coreError('refused', `the tier cannot be signed below the attested floor ${floor}`));
  }
  const signed = await j.emit(
    projectStream(project.project.project_id),
    PROJECT_EVENT.signed,
    { s0_id: input.s0_id, tier: input.tier, level: input.level, by: input.actor },
    input.actor,
  );
  if (!signed.ok) return signed;
  const lvl = await j.emit(
    repoStream(s0.repo),
    REPO_EVENT.level_set,
    { level: input.level, s0_id: input.s0_id },
    input.actor,
  );
  if (!lvl.ok) return lvl;
  return ok({ project_id: project.project.project_id, repo: s0.repo });
}
