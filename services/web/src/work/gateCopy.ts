import type { GateId } from '@aisdlc/contracts';
import type { DecisionVerb } from '../ui';

// What each approval asks, in plain words (glossary §4, §9): the one sentence of "What you are approving", where
// "Reject" sends the work, what happens after, and which of the three verbs the approval offers. The approval's name
// is the glossary's; nothing here repeats it.

export interface GateCopy {
  /** "What you are approving", one or two sentences. `{item}` is replaced by "item 1acc2b3c". */
  readonly what: string;
  /** Where "Reject" sends the work. */
  readonly rejectTo: string;
  /** What happens once it is approved. */
  readonly after: string;
  /** The verbs this approval offers; omitted: all three. */
  readonly allowed?: readonly DecisionVerb[];
  /** The evidence a person must read first, in a few words. */
  readonly read: string;
}

const STAGE_REJECT = 'the work stops';

export const GATE_COPY: Readonly<Partial<Record<GateId, GateCopy>>> = {
  G0: {
    what: 'Whether the factory takes on the request of {item}, on the track it picked.',
    rejectTo: 'the request is declined',
    after: 'The factory confirms the goal next and starts research.',
    read: 'the request text and the track',
  },
  G1: {
    what: 'The agreed goal of {item}: what the request is for, before the factory studies it.',
    rejectTo: 'the request is declined',
    after: 'Research starts on the agreed goal.',
    read: 'the agreed goal',
  },
  G1f: {
    what: 'The final goal of the large initiative {item}, after it was worked out.',
    rejectTo: STAGE_REJECT,
    after: 'The spec is written next.',
    read: 'the initiative outline',
  },
  G2: {
    what: 'The spec change of {item} and the acceptance criteria that prove it.',
    rejectTo: STAGE_REJECT,
    after: 'The design (or the plan, on a small track) is written next.',
    read: 'the spec change and the acceptance criteria',
  },
  G3d: {
    what: 'The design of {item} and the risks it names.',
    rejectTo: STAGE_REJECT,
    after: 'The plan is written next.',
    read: 'the design documents',
  },
  G3s: {
    what: 'How {item} is split into parts and in which order they are built.',
    rejectTo: STAGE_REJECT,
    after: 'The full plan is decided with this outline.',
    read: 'the parts and their order',
  },
  G3: {
    what: 'The full plan of {item}, for exactly the commit it was made against.',
    rejectTo: STAGE_REJECT,
    after: 'Building starts when a coding slot is free.',
    read: 'the plan and its parts',
  },
  G3o: {
    what: 'The acceptance tests of {item} differ from the criteria approved with the spec. You approve the difference as shown.',
    rejectTo: 'the work goes to a person',
    after: 'The tests are locked as they are and the build goes on.',
    allowed: ['approve', 'reject'],
    read: 'the difference against the approved criteria',
  },
  G4: {
    what: 'The pull request of {item} at exactly the commit shown, with the signed evidence of that commit. A new push makes this decision void.',
    rejectTo: 'back to the build, then to a person',
    after: 'A person merges the pull request on GitHub. The factory never merges.',
    read: 'the checks, the evidence pack and the change',
  },
  G5: {
    what: 'Deploying what merged for {item} to the environment shown.',
    rejectTo: 'the release is held',
    after: 'The release runs once; a failed release is held.',
    allowed: ['approve', 'reject'],
    read: 'what merged, the evidence and the environment',
  },
  G6: {
    what: 'Whether what merged for {item} does what you asked for.',
    rejectTo: 'a new linked item carries what is missing',
    after: 'The final record is written and the item closes.',
    allowed: ['approve', 'reject'],
    read: 'the agreed goal and what merged',
  },
  X1: {
    what: 'The agent on {item} wants to do something that cannot be undone, once.',
    rejectTo: 'the work goes to a person',
    after: 'The agent may do this once; the build goes on.',
    allowed: ['approve', 'reject'],
    read: 'the action, its command and its target',
  },
  X2: {
    what: 'The change on {item} touches files only people may change. You approve exactly this change.',
    rejectTo: 'the change is refused',
    after: 'The build goes on with this change; a later push needs this approval again.',
    read: 'the change to the protected files',
  },
  X3: {
    what: 'The change on {item} adds a new package.',
    rejectTo: 'the change is refused',
    after: 'The step runs again with the package allowed.',
    read: 'the package and what is known about it',
  },
  E1: {
    what: 'Moving {item} to a lighter track with fewer steps.',
    rejectTo: 'it stays on its track',
    after: 'The track is picked again.',
    read: 'why the work is smaller',
  },
  E2: {
    what: '{item} breaks a factory rule. You allow it once, or not.',
    rejectTo: 'the work stops',
    after: 'The step goes on with the exception; the rule itself does not change.',
    read: 'the factory rules check',
  },
  E4: {
    what: 'The agents on {item} stopped. You take it as its owner, then choose on the item what happens next.',
    rejectTo: 'it stays waiting for an owner',
    after:
      'Choose on the item page: resume, re-plan, rewrite the spec, take over or stop the work.',
    read: 'why the agents stopped',
  },
  E6: {
    what: 'A locked acceptance test of {item} must change because the spec it came from changed.',
    rejectTo: 'the work goes to a person',
    after: 'The test is changed once and locked again; the checks run again.',
    read: 'the test and the spec change',
  },
  SECT: {
    what: 'Work on {item} stopped because an agent did something unsafe. Approve if it was a false alarm; reject if the hold was real.',
    rejectTo: 'confirmed: the work goes to a person',
    after: 'False alarm: the build starts again in a new sandbox.',
    read: 'the check that found it and the evidence',
  },
};

/** The copy of a gate; a gate the table does not have reads only its name. */
export const copyOf = (gate: string): GateCopy | null =>
  (GATE_COPY as Readonly<Record<string, GateCopy>>)[gate] ?? null;
