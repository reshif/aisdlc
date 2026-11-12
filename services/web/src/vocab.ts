import {
  STEPS,
  type EligibilityReason,
  type EligibilityRoute,
  type WorkIntakeState,
  type FloorItemStatus,
  type FloorRoom,
  type FloorStage,
  type Level,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingStepState,
} from '@aisdlc/contracts';

// Words for the vocabulary the contracts define. The lists of values (levels, step ids, statuses,
// states) are the contracts'; these maps only give each value its text, and `Record<Value, ...>`
// makes the compiler refuse a value the text does not cover.

/** The plain-language explanation of each level (OB §1A "In plain words"). */
export const LEVEL_TEXT: Readonly<Record<Level, { title: string; blurb: string }>> = {
  census: {
    title: 'Census',
    blurb: 'The factory understands the repo; people do the work.',
  },
  light: {
    title: 'Light',
    blurb: 'Agents may do small work (L1 to L3).',
  },
  full: {
    title: 'Full',
    blurb: 'Agents may do features (L4 to L6).',
  },
};

export const levelTitle = (l: Level | null): string =>
  l === null ? 'Not signed yet' : LEVEL_TEXT[l].title;

export type Tone = 'neutral' | 'active' | 'attention' | 'bad' | 'good';

/** The status of a whole S0 record: its name, its tone, and what it means for the person. */
export const STATUS_TEXT: Readonly<
  Record<OnboardingStatus, { label: string; tone: Tone; meaning: string }>
> = {
  app: {
    label: 'Waiting for the GitHub App',
    tone: 'attention',
    meaning: 'The factory cannot read the repo yet. Requests for this repo are held until it can.',
  },
  running: {
    label: 'Running',
    tone: 'active',
    meaning: 'The factory is working on a step. Nothing is needed from you right now.',
  },
  card: {
    label: 'Waiting for a decision',
    tone: 'attention',
    meaning: 'A card is open and needs a decision from the person who holds its slot.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'bad',
    meaning: 'A step could not finish. The cause is on the step below.',
  },
  starter: {
    label: 'Starter repo',
    tone: 'neutral',
    meaning: 'The repo is empty, so the factory is preparing a starter.',
  },
  parked: {
    label: 'Parked',
    tone: 'attention',
    meaning: 'Nobody answered in time, so the onboarding was parked. It can be resumed.',
  },
  done: { label: 'Done', tone: 'good', meaning: 'The project is onboarded.' },
  rejected: {
    label: 'Rejected',
    tone: 'bad',
    meaning: 'The owner rejected the onboarding. It can be restored or withdrawn.',
  },
  superseded: {
    label: 'Superseded',
    tone: 'neutral',
    meaning: 'A newer onboarding request for this repo replaced this one.',
  },
  withdrawn: { label: 'Withdrawn', tone: 'neutral', meaning: 'The onboarding was withdrawn.' },
};

/** Statuses after which nothing changes by itself: the page stops polling. */
export const QUIET_STATUSES: ReadonlySet<OnboardingStatus> = new Set<OnboardingStatus>([
  'done',
  'superseded',
  'withdrawn',
]);

export const STEP_STATE_TEXT: Readonly<Record<OnboardingStepState, { label: string; tone: Tone }>> =
  {
    todo: { label: 'To do', tone: 'neutral' },
    running: { label: 'Running', tone: 'active' },
    card: { label: 'Card open', tone: 'attention' },
    blocked: { label: 'Blocked', tone: 'bad' },
    done: { label: 'Done', tone: 'good' },
    skip: { label: 'Skipped', tone: 'neutral' },
  };

/** "0.1 Census": the id and the title the contracts give the step. */
export const stepName = (id: OnboardingStepId): string => `${id} ${STEPS[id].title}`;

// ---------------------------------------------------------------- the floor (M19)

/** The floor's station names (the design reference's words for each stage). */
export const FLOOR_STAGE_TEXT: Readonly<Record<FloorStage, string>> = {
  S1: 'Intake & triage',
  S2: 'Shape',
  S3: 'Specify',
  S4: 'Design',
  S5: 'Plan',
  S6: 'Build in sandbox',
  S7: 'Verify',
  S8: 'Human merge',
  S9: 'Close & learn',
};

/** The side rooms: what each holds, and what happens next to an item there. */
export const FLOOR_ROOM_TEXT: Readonly<
  Record<FloorRoom, { title: string; sub: string; next: string }>
> = {
  SCHED: {
    title: 'Scheduler',
    sub: 'lease, pod and envelope',
    next: 'Admission (6.0) checks the approver slot (H1), coding sessions (H2), the envelope (H3) and WIP; first in, first out.',
  },
  HOLD: {
    title: 'Holding shelf',
    sub: 'held, parked, waiting on a person',
    next: 'Held items keep their saved work and their pod is released. They return when the hold lifts or the person decides (X1, X3, E6, G3o).',
  },
  QUAR: {
    title: 'Quarantine',
    sub: 'security triage first',
    next: 'Security triage (SECT) first. A false positive rebuilds cold; a confirmed one keeps the branch quarantined and the item goes human-led.',
  },
  DESK: {
    title: 'Handoff desk',
    sub: 'the owner of record chooses',
    next: 'The owner of record chooses D1 to D5: reshape, extend the envelope (E3), hand to a person, park, or abandon.',
  },
  BIN: {
    title: 'Declined, abandoned',
    sub: 'closed with a cause',
    next: 'Closed with a cause. Reopening is a new request linked to this one.',
  },
  DONE: {
    title: 'Done',
    sub: 'closed in the last 24 hours',
    next: 'Closed with its close-out record.',
  },
};

export const FLOOR_STATUS_TEXT: Readonly<
  Record<FloorItemStatus, { label: string; tone: 'info' | 'gate' | 'back' | 'bad' | 'ok' | 'mute' }>
> = {
  working: { label: 'working', tone: 'info' },
  waiting: { label: 'waiting', tone: 'gate' },
  held: { label: 'held', tone: 'back' },
  stuck: { label: 'stuck', tone: 'bad' },
  done: { label: 'done', tone: 'ok' },
  declined: { label: 'declined', tone: 'mute' },
};

/** 1.4's reason for a verdict on the asked lane, for the request receipt (P2-17). */
export const ELIGIBILITY_REASON_TEXT: Readonly<Record<EligibilityReason, string>> = {
  eligible: 'the repo is ready for the lane you asked for',
  no_active_prr: 'the repo has no active readiness record yet',
  prr_stale: 'the repo’s readiness record is stale',
  prr_suspended: 'the repo’s readiness record is suspended (drift)',
  prr_expired: 'the repo’s readiness record has expired',
  level_too_low: 'the repo’s level does not open the lane you asked for',
  lane_unspecified:
    'the catalogue leaves this lane undecided at the repo’s level, so it is not open',
  tier_requires_full: 'the project’s tier needs Full for an agent-led lane',
  posture_red: 'the repo’s security posture is red',
  staging_separation_not_attested: 'the lane needs staging separation attested, and it is not',
  circuit_breaker: 'the lane’s circuit breaker is tripped for the project',
  followup_overdue: 'a hotfix follow-up is overdue on the project',
  area_unknown: 'the readiness record does not cover the area named',
};

/** Where 1.4 sends a request. */
export const ELIGIBILITY_ROUTE_TEXT: Readonly<Record<EligibilityRoute, string>> = {
  normal: 'runs in the lane',
  n8_hold: 'held (N8) until a readiness record opens the lane',
  l8: 'routed to L8: a person does the work, the factory checks it',
};

/** Where a request stands once intake ran. */
export const INTAKE_STATE_TEXT: Readonly<Record<WorkIntakeState, string>> = {
  requested: 'recorded',
  held: 'held: no item until the lane opens',
  admitted: 'admitted: a work item was made',
  routed_l8: 'routed to L8: a work item was made',
  released: 'released from its hold',
  l8_offered: 'offered as L8',
};
