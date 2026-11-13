import { explain as glossaryExplain, label as glossaryLabel } from '@aisdlc/contracts';
import {
  STEPS,
  type AgentRunState,
  type AgentRunVerdict,
  type DocumentGroup,
  type ItemTimelineKind,
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

/** The floor's station names: the glossary's stage labels (portal v2). */
export const FLOOR_STAGE_TEXT: Readonly<Record<FloorStage, string>> = {
  S1: glossaryLabel('stage', 'S1'),
  S2: glossaryLabel('stage', 'S2'),
  S3: glossaryLabel('stage', 'S3'),
  S4: glossaryLabel('stage', 'S4'),
  S5: glossaryLabel('stage', 'S5'),
  S6: glossaryLabel('stage', 'S6'),
  S7: glossaryLabel('stage', 'S7'),
  S8: glossaryLabel('stage', 'S8'),
  S9: glossaryLabel('stage', 'S9'),
};

/** The side rooms: the glossary's names and tooltips, and what happens next to an item there. */
export const FLOOR_ROOM_TEXT: Readonly<
  Record<FloorRoom, { title: string; sub: string; next: string }>
> = {
  SCHED: {
    title: glossaryLabel('room', 'SCHED'),
    sub: glossaryExplain('room', 'SCHED'),
    next: 'Before building starts the factory checks there is an approver, a free coding slot, budget and room under the work-in-progress limit; first in, first out.',
  },
  HOLD: {
    title: glossaryLabel('room', 'HOLD'),
    sub: glossaryExplain('room', 'HOLD'),
    next: 'Paused items keep their saved work and give up their coding slot. They return when the pause lifts or a person decides the approval they wait for.',
  },
  QUAR: {
    title: glossaryLabel('room', 'QUAR'),
    sub: glossaryExplain('room', 'QUAR'),
    next: 'A security approver decides first. A false alarm rebuilds in a new sandbox; a real one keeps the branch held and a person does the work.',
  },
  DESK: {
    title: glossaryLabel('room', 'DESK'),
    sub: glossaryExplain('room', 'DESK'),
    next: 'Its owner chooses what happens next: resume, more budget, re-plan, rewrite the spec, take over, or stop the work.',
  },
  BIN: {
    title: glossaryLabel('room', 'BIN'),
    sub: glossaryExplain('room', 'BIN'),
    next: 'Closed with a cause. Reopening is a new request linked to this one.',
  },
  DONE: {
    title: glossaryLabel('room', 'DONE'),
    sub: 'Closed in the last 24 hours.',
    next: 'Closed with its final record.',
  },
};

/** What an item on the floor is doing: the glossary's words. */
export const FLOOR_STATUS_TEXT: Readonly<
  Record<FloorItemStatus, { label: string; tone: 'info' | 'gate' | 'back' | 'bad' | 'ok' | 'mute' }>
> = {
  working: { label: glossaryLabel('floorStatus', 'working'), tone: 'info' },
  waiting: { label: glossaryLabel('floorStatus', 'waiting'), tone: 'gate' },
  held: { label: glossaryLabel('floorStatus', 'held'), tone: 'back' },
  stuck: { label: glossaryLabel('floorStatus', 'stuck'), tone: 'bad' },
  done: { label: glossaryLabel('floorStatus', 'done'), tone: 'ok' },
  declined: { label: glossaryLabel('floorStatus', 'declined'), tone: 'mute' },
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
  r3_zone:
    'knowledge defects put the area under re-onboarding (an R3 zone): only human-led work runs there',
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

/** P2-1: how the Documents tab names its groups of artefacts. */
export const DOCUMENT_GROUP_TEXT: Readonly<
  Record<DocumentGroup, { title: string; blurb: string }>
> = {
  intent: { title: 'Intent', blurb: 'the classification and the intent block (S1)' },
  analysis: { title: 'Analysis', blurb: 'context, impact and the decision brief (S2)' },
  spec: { title: 'Spec', blurb: 'the spec delta, its oracles, validation and review (S3)' },
  design: {
    title: 'Design and decisions',
    blurb: 'ADR-style decisions, contracts, data and NFRs (S4)',
  },
  constitution: {
    title: 'Constitution report',
    blurb: 'the factory constitution over the design (4.5)',
  },
  plan: { title: 'Plan', blurb: 'Units, sequence, tasks, verification and the envelope (S5)' },
  build: { title: 'Build', blurb: 'oracle code, the patch and session records (S6)' },
  evidence: { title: 'Evidence', blurb: 'what S7 signed' },
  other: { title: 'Other', blurb: 'other records of the item' },
};

/** P2-1: a timeline entry in words (the record's event kinds are the contracts'). */
export const TIMELINE_KIND_TEXT: Readonly<Record<ItemTimelineKind, string>> = {
  'item.created': 'The work item was made from the request',
  'item.submitted': 'The request was submitted',
  'item.stage_completed': 'A step finished',
  'item.stage_failed': 'A step failed',
  'item.stage_gate_needed': 'A step raised a gate',
  'item.questions_raised': 'The factory asked the requester questions',
  'item.question_answered': 'A question was answered',
  'item.eligibility_checked': 'The lane was checked against the repo’s readiness (1.4)',
  'item.ready_decided': 'Someone said the request is ready (1.6)',
  'item.scheduled': 'The work was scheduled',
  'item.merge_observed': 'A merge was seen on the code host',
  'item.human_work_done': 'A person said the human-led work is done',
  'item.gates_opened': 'Gates were opened for a decision',
  'item.gate_decided': 'A gate was decided',
  'item.hold_placed': 'The item was held',
  'item.hold_released': 'A hold was released',
  'item.abandoned': 'The item was abandoned',
  'item.withdrawn': 'The item was withdrawn',
  'item.spawn_requested': 'A follow-up item was asked for',
  'item.spawned': 'A follow-up item was made',
  'item.command_done': 'The factory finished a command',
  'item.stage_held': 'A step was held',
  'item.rework_requested': 'The work was sent back (a back-edge)',
  'item.relane_requested': 'A change of lane was asked for',
  'item.trigger_fired': 'A handoff trigger fired',
  'item.timer_fired': 'A business-day timer ran out',
  'item.handoff_chosen': 'The owner of record chose what happens after the handoff',
  'item.hand_back': 'The developer handed the work back (D4)',
  'item.env_fixed': 'The environment was fixed',
  'item.release_re_requested': 'The release was asked for again',
  'item.assumption_raised': 'An assumption was recorded',
  'item.assumption_decided': 'An assumption was decided',
  'artefact.stored': 'A document was stored',
};

/** P2-1, P2-3: what came of an agent run. */
export const AGENT_RUN_VERDICT_TEXT: Readonly<
  Record<AgentRunVerdict, { label: string; tone: 'ok' | 'warn' | 'bad' | 'mute' }>
> = {
  pending: { label: 'not judged yet', tone: 'mute' },
  accepted: { label: 'accepted', tone: 'ok' },
  rejected: { label: 'rejected', tone: 'bad' },
  sent_back: { label: 'sent back', tone: 'warn' },
  reworked: { label: 'reworked', tone: 'warn' },
  handed_off: { label: 'handed off', tone: 'bad' },
};

export const AGENT_RUN_STATE_TEXT: Readonly<Record<AgentRunState, string>> = {
  dispatched: 'running',
  finished: 'finished',
  failed: 'failed',
};

/** Micro-dollars as dollars, for a cost column. */
export const usd = (micro: number): string =>
  micro === 0
    ? '$0'
    : micro < 10_000
      ? `$${(micro / 1_000_000).toFixed(4)}`
      : `$${(micro / 1_000_000).toFixed(2)}`;
