import {
  STEPS,
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
