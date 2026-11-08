import {
  PROJECT_EVENT,
  ProjectAttestedPayload,
  ProjectRegisteredPayload,
  ProjectSignedPayload,
  REPO_EVENT,
  RepoLevelSetPayload,
  RepoObservedPayload,
  RepoRegisteredPayload,
  S0CardRequiredPayload,
  S0CensusReadyPayload,
  S0JobStartedPayload,
  S0MachineFailedPayload,
  S0RequestedPayload,
  S0SendBackPayload,
  S0SignableLevelPayload,
  S0StatusChangedPayload,
  S0StepChangedPayload,
  S0WaitingPayload,
  S0_EVENT,
  OnboardingStepId,
  levelRank,
  s0RefOf,
  type OnboardAttestations,
  type OnboardingStatus,
  type OnboardingStepState,
  type Project,
  type RecordEvent,
  type Repo,
  type S0Record,
} from '@aisdlc/contracts';

// The aggregates of the Projects and Onboarding context as pure folds of their record streams. The
// writers fold the authoritative streams (never a read model, which may lag) and the `core`
// projection folds the same streams into tables, so there is one definition of each state. A fold
// trusts its events: the writer checked the state machine before it appended them.

export const STEPS: readonly OnboardingStepId[] = OnboardingStepId.options;

// ---------------------------------------------------------------- Project

export interface ProjectState {
  readonly project: Project;
  /** The highest of every raise-only attestation given so far. */
  readonly attestations: OnboardAttestations;
}

const TIER_RANK = { T0: 0, T1: 1, T2: 2 } as const;

/** Merges attestations raise-only: a later one can add or raise, never lower. */
export function raiseAttestations(
  a: OnboardAttestations,
  b: OnboardAttestations,
): OnboardAttestations {
  const tier =
    a.tier_floor !== undefined && b.tier_floor !== undefined
      ? TIER_RANK[a.tier_floor] >= TIER_RANK[b.tier_floor]
        ? a.tier_floor
        : b.tier_floor
      : (a.tier_floor ?? b.tier_floor);
  return {
    ...(a.classification === 'confidential' || b.classification === 'confidential'
      ? { classification: 'confidential' as const }
      : {}),
    ...(tier !== undefined ? { tier_floor: tier } : {}),
    ...(a.deploys === true || b.deploys === true ? { deploys: true as const } : {}),
    ...(a.mode === 'team' || b.mode === 'team' ? { mode: 'team' as const } : {}),
  };
}

export function foldProject(events: readonly RecordEvent[]): ProjectState | null {
  let project = null as Project | null;
  let attestations: OnboardAttestations = {};
  for (const e of events) {
    if (e.type === PROJECT_EVENT.registered) {
      const p = ProjectRegisteredPayload.parse(e.payload);
      project = {
        project_id: p.project_id,
        name: p.name,
        team_id: p.team_id,
        classification: p.classification,
        stack: p.stack,
        deploys: p.deploys,
        tier: null,
        level: null,
        owner: p.owner,
        version: 1,
        updated_at: e.occurred_at,
      };
    } else if (e.type === PROJECT_EVENT.attested && project) {
      const p = ProjectAttestedPayload.parse(e.payload);
      attestations = raiseAttestations(attestations, p.attestations);
      project = {
        ...project,
        // Raise-only: confidential stays confidential; "deploys" turns an unknown into true.
        classification:
          p.attestations.classification === 'confidential'
            ? 'confidential'
            : project.classification,
        deploys: p.attestations.deploys === true ? true : project.deploys,
        version: e.stream_seq,
        updated_at: e.occurred_at,
      };
    } else if (e.type === PROJECT_EVENT.signed && project) {
      const p = ProjectSignedPayload.parse(e.payload);
      project = {
        ...project,
        tier: p.tier,
        // The project's level is the highest any of its repos was signed at.
        level:
          project.level === null || levelRank(p.level) > levelRank(project.level)
            ? p.level
            : project.level,
        version: e.stream_seq,
        updated_at: e.occurred_at,
      };
    }
  }
  return project ? { project, attestations } : null;
}

// ---------------------------------------------------------------- Repo

export function foldRepo(events: readonly RecordEvent[]): Repo | null {
  let repo = null as Repo | null;
  for (const e of events) {
    if (e.type === REPO_EVENT.registered) {
      const p = RepoRegisteredPayload.parse(e.payload);
      repo = {
        repo_id: p.repo_id,
        repo_ref: p.repo_ref,
        project_id: p.project_id,
        host: p.host,
        owner: p.owner,
        name: p.name,
        visibility: null,
        owner_type: null,
        plan: null,
        default_branch: null,
        stack: null,
        onboarding_level: 'none',
      };
    } else if (e.type === REPO_EVENT.observed && repo) {
      const p = RepoObservedPayload.parse(e.payload);
      repo = {
        ...repo,
        visibility: p.visibility,
        owner_type: p.owner_type,
        default_branch: p.default_branch,
      };
    } else if (e.type === REPO_EVENT.level_set && repo) {
      repo = { ...repo, onboarding_level: RepoLevelSetPayload.parse(e.payload).level };
    }
  }
  return repo;
}

// ---------------------------------------------------------------- S0

/** What the driver and the read model know of one step, beyond the `OnboardingStep` contract. */
export interface StepProgress {
  readonly step: OnboardingStepId;
  readonly state: OnboardingStepState;
  readonly blocked_cause: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  /** Send-backs used (DEC-9). */
  readonly send_backs: number;
  /** Machine failures since the step last changed state. */
  readonly failures: number;
  readonly last_failure_at: string | null;
  /** When the step's card was last raised; the silence clock of the PARK rule starts here. */
  readonly card_raised_at: string | null;
  /** Cards raised for the step so far (the first is `first`, later ones `again`). */
  readonly card_raises: number;
  readonly reminded: boolean;
  readonly overdue: boolean;
}

export interface S0JobState {
  readonly job_id: string;
  readonly started_at: string;
}

export interface S0State {
  readonly record: S0Record;
  readonly steps: ReadonlyMap<OnboardingStepId, StepProgress>;
  readonly waiting: string | null;
  /** The running census job of step 0.1, if one was started and has not ended. */
  readonly job: S0JobState | null;
  readonly census: S0CensusReadyPayload | null;
  /** When the status last changed. */
  readonly status_since: string;
  /** The stream's head. */
  readonly head_seq: number;
  /** The repo as requested (`owner/name`). */
  readonly repo: string;
}

const blankStep = (step: OnboardingStepId): StepProgress => ({
  step,
  state: 'todo',
  blocked_cause: null,
  started_at: null,
  finished_at: null,
  send_backs: 0,
  failures: 0,
  last_failure_at: null,
  card_raised_at: null,
  card_raises: 0,
  reminded: false,
  overdue: false,
});

export function foldS0(events: readonly RecordEvent[]): S0State | null {
  let record = null as S0Record | null;
  let repo = '';
  let steps = new Map<OnboardingStepId, StepProgress>();
  let waiting: string | null = null;
  let job: S0JobState | null = null;
  let census: S0CensusReadyPayload | null = null;
  let statusSince = '';
  let head = 0;
  const upd = (step: OnboardingStepId, f: (s: StepProgress) => StepProgress): void => {
    const cur = steps.get(step);
    if (cur) steps.set(step, f(cur));
  };
  for (const e of events) {
    head = e.stream_seq;
    if (e.type === S0_EVENT.requested) {
      const p = S0RequestedPayload.parse(e.payload);
      record = {
        s0_id: p.s0_id,
        project_id: p.project_id,
        repo_id: p.repo_id,
        status: 'app',
        requested_level: p.requested_level,
        signable_level: p.requested_level,
        intake_ref: s0RefOf(e.event_id),
        rejected_at: null,
        readiness_version: null,
        catalogue_ref: p.catalogue_ref,
        version: e.stream_seq,
        created_at: e.occurred_at,
        updated_at: e.occurred_at,
      };
      repo = p.repo;
      steps = new Map(STEPS.map((s) => [s, blankStep(s)]));
      statusSince = e.occurred_at;
      continue;
    }
    if (!record) continue;
    record = { ...record, version: e.stream_seq, updated_at: e.occurred_at };
    switch (e.type) {
      case S0_EVENT.status_changed: {
        const p = S0StatusChangedPayload.parse(e.payload);
        const wasRejectedAt = record.rejected_at;
        record = {
          ...record,
          status: p.to,
          rejected_at: p.to === 'rejected' ? p.rejected_at : null,
        };
        statusSince = e.occurred_at;
        // A restore gives the step that was rejected a fresh send-back allowance.
        if (p.from === 'rejected' && p.to === 'running' && wasRejectedAt !== null) {
          upd(wasRejectedAt, (s) => ({ ...s, send_backs: 0 }));
        }
        break;
      }
      case S0_EVENT.step_changed: {
        const p = S0StepChangedPayload.parse(e.payload);
        upd(p.step, (s) => ({
          ...s,
          state: p.state,
          blocked_cause: p.state === 'blocked' ? p.blocked_cause : null,
          started_at: p.state === 'running' && s.started_at === null ? e.occurred_at : s.started_at,
          finished_at: p.state === 'done' ? e.occurred_at : s.finished_at,
          // A change of state ends the run of failures (a blocked step that is retried starts at 0).
          failures: 0,
          last_failure_at: null,
          card_raised_at: p.state === 'card' ? s.card_raised_at : null,
        }));
        break;
      }
      case S0_EVENT.card_required: {
        const p = S0CardRequiredPayload.parse(e.payload);
        // The security card is separate: it neither starts nor restarts the step's silence clock.
        if (p.card !== 'SECR') {
          upd(p.step, (s) => ({
            ...s,
            card_raised_at: e.occurred_at,
            card_raises: s.card_raises + 1,
            reminded: false,
          }));
        }
        break;
      }
      case S0_EVENT.job_started: {
        const p = S0JobStartedPayload.parse(e.payload);
        job = { job_id: p.job_id, started_at: e.occurred_at };
        break;
      }
      case S0_EVENT.census_ready:
        census = S0CensusReadyPayload.parse(e.payload);
        job = null;
        break;
      case S0_EVENT.machine_failed: {
        const p = S0MachineFailedPayload.parse(e.payload);
        upd(p.step, (s) => ({ ...s, failures: s.failures + 1, last_failure_at: e.occurred_at }));
        job = null;
        break;
      }
      case S0_EVENT.send_back: {
        const p = S0SendBackPayload.parse(e.payload);
        upd(p.step, (s) => ({ ...s, send_backs: p.count }));
        break;
      }
      case S0_EVENT.waiting:
        waiting = S0WaitingPayload.parse(e.payload).waiting;
        break;
      case S0_EVENT.reminder: {
        const step = OnboardingStepId.parse((e.payload as { step?: unknown }).step);
        upd(step, (s) => ({ ...s, reminded: true }));
        break;
      }
      case S0_EVENT.timebox_exceeded: {
        const step = OnboardingStepId.parse((e.payload as { step?: unknown }).step);
        upd(step, (s) => ({ ...s, overdue: true }));
        break;
      }
      case S0_EVENT.signable_level_set:
        record = {
          ...record,
          signable_level: S0SignableLevelPayload.parse(e.payload).signable_level,
        };
        break;
    }
  }
  return record
    ? { record, steps, waiting, job, census, status_since: statusSince, head_seq: head, repo }
    : null;
}

export const isTerminal = (s: OnboardingStatus): boolean =>
  s === 'done' || s === 'superseded' || s === 'withdrawn';

/** The statuses whose repo the code host may be asked about (P-MUST-3): a live or finished onboarding. */
export const REGISTERED_STATUSES: readonly OnboardingStatus[] = [
  'app',
  'running',
  'card',
  'blocked',
  'starter',
  'parked',
  'done',
  'rejected',
];
