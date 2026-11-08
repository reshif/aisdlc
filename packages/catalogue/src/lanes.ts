import {
  GATES,
  LANE_LABELS,
  LaneValues,
  STEPS,
  StepIdValues,
  type GateId,
  type Lane,
  type StageId,
  type StepId,
} from '@aisdlc/contracts';
import type {
  GatePosition,
  GatePresence,
  LaneDef,
  LaneProfile,
  LaneStage,
  OracleSource,
  StageMode,
} from './schema.js';

// Lanes L0-L8 as drawn in flow-corrected.mmd (FIX 5-7): stage subsets, gate positions, lane profile.
// Steps and gates are looked up in contracts' STEPS and GATES; nothing here re-lists them.

/** Stages that have steps, in flow order. S0 is onboarding, not a lane stage. */
const LANE_STAGES: readonly StageId[] = [
  ...new Set(StepIdValues.map((s) => STEPS[s].stage).filter((s) => s !== 'S0')),
];

const stepsOf = (stage: StageId): StepId[] => StepIdValues.filter((s) => STEPS[s].stage === stage);

const stage = (id: StageId, mode: StageMode, steps: readonly StepId[] | null = null): LaneStage => {
  switch (mode) {
    case 'full':
      return { stage: id, mode, steps: stepsOf(id) };
    case 'skipped':
      return { stage: id, mode, steps: [] };
    case 'partial':
      return { stage: id, mode, steps: steps === null ? null : [...steps] };
    case 'unspecified':
      return { stage: id, mode, steps: null };
  }
};

/** S2 without the L6-only steps 2.4 and 2.5. */
const S2_NO_ELABORATION: StepId[] = stepsOf('S2').filter((s) => s !== '2.4' && s !== '2.5');

type Modes = Partial<Record<StageId, LaneStage>>;
const stages = (overrides: Modes, fallback: StageMode = 'full'): LaneStage[] =>
  LANE_STAGES.map((s) => overrides[s] ?? stage(s, fallback));

const hasStep = (list: readonly LaneStage[], step: StepId): boolean =>
  list.some((l) => l.steps?.includes(step) === true);
const stageMode = (list: readonly LaneStage[], id: StageId): StageMode | undefined =>
  list.find((l) => l.stage === id)?.mode;

const pos = (
  gate: GateId,
  step: StepId,
  rel: 'at' | 'after',
  condition: string | null = null,
): GatePosition => {
  const toggled = GATES[gate].projectToggle !== null;
  const presence: GatePresence = toggled
    ? 'by_profile'
    : condition === null
      ? 'required'
      : 'conditional';
  return { gate, step, rel, presence, condition };
};

/**
 * Gate positions of a lane, from the flow edges and the lane's stage subset. Stage gates sit where
 * the flow draws them (G0 and G1 after 1.6, G2 after 3.5, G3d after 4.6, G3 and G3s after 5.8, G4
 * after 7.6, G5 after 8.2, G6 after 9.2, G1f at 2.5). Action, exception and oracle gates are
 * conditional on their trigger and are listed only where the lane has the step they hang off.
 */
function gatesFor(list: readonly LaneStage[], extra: readonly GatePosition[] = []): GatePosition[] {
  const out: GatePosition[] = [pos('G0', '1.6', 'after'), pos('G1', '1.6', 'after')];
  if (hasStep(list, '2.5')) out.push(pos('G1f', '2.5', 'at'));
  if (stageMode(list, 'S3') === 'full' || stageMode(list, 'S3') === 'partial') {
    out.push(pos('G2', '3.5', 'after'));
  }
  if (stageMode(list, 'S4') === 'full') out.push(pos('G3d', '4.6', 'after'));
  if (stageMode(list, 'S5') === 'full' || stageMode(list, 'S5') === 'partial') {
    out.push(pos('G3', '5.8', 'after'), pos('G3s', '5.8', 'after'));
  }
  if (stageMode(list, 'S6') === 'full') {
    out.push(
      pos('G3o', '6.3', 'after', 'oracle code deviates from the G2-approved specs'),
      pos('X1', '6.4', 'after', 'irreversible operation'),
      pos('X3', '6.4', 'after', 'new package'),
    );
  }
  if (stageMode(list, 'S4') === 'full') {
    out.push(pos('E2', '4.5', 'after', 'design violates the constitution'));
  }
  if (stageMode(list, 'S7') === 'full') {
    out.push(
      pos('E6', '7.2', 'after', 'locked test must change (B12)'),
      pos('X2', '7.4', 'after', 'protected path touched'),
      pos('E2', '7.5', 'after', 'constitution violation found in S7'),
      pos('G4', '7.6', 'after'),
    );
  }
  if (stageMode(list, 'S8b') === 'full') out.push(pos('G5', '8.2', 'after'));
  if (stageMode(list, 'S9') === 'full') out.push(pos('G6', '9.2', 'after'));
  if (hasStep(list, '9.3')) out.push(pos('X4', '9.3', 'after', 'break-glass was used'));
  return [...out, ...extra];
}

const MANDATORY_STEPS: StepId[] = StepIdValues.filter((s) => STEPS[s].stage === 'S7');
const MANDATORY_GATES: GateId[] = ['G4'];

const profile = (oracle: OracleSource, over: Partial<LaneProfile> = {}): LaneProfile => ({
  default_envelope: { budget_cents: null },
  oracle_source: oracle,
  mandatory_steps: MANDATORY_STEPS,
  mandatory_gates: MANDATORY_GATES,
  mandatory_exemption: null,
  ...over,
});

const NO_ENVELOPE = 'default envelope value: the flow names "profile envelope" and gives none';

function lane(
  id: Lane,
  def: Omit<LaneDef, 'id' | 'label' | 'gates'> & { gates?: GatePosition[] },
): LaneDef {
  const { gates, ...rest } = def;
  return { id, label: LANE_LABELS[id], ...rest, gates: gates ?? gatesFor(def.stages) };
}

const SMALL_LANE_NOTES = [
  NO_ENVELOPE,
  'oracle source: the flow names it only for L0 and the full path',
  'which steps of the partial S3 and S5 run: the flow says "partial" and no more',
  'default gating for G3 and G3s on L1-L3: OB §1C gives defaults for L4-L6 only',
  'how L1, L2 and L3 differ: the flow groups them as one',
];

const FULL_PATH_NOTES = [NO_ENVELOPE];

const L1_L3 = (id: 'L1' | 'L2' | 'L3'): LaneDef =>
  lane(id, {
    enter_at: '3.1',
    stages: stages({
      S2: stage('S2', 'skipped'),
      S3: stage('S3', 'partial', null),
      S4: stage('S4', 'skipped'),
      S5: stage('S5', 'partial', null),
    }),
    profile: profile('unspecified'),
    exit: 'standard',
    follow_up: null,
    reentry: null,
    unspecified: SMALL_LANE_NOTES,
  });

const L4_L5 = (id: 'L4' | 'L5'): LaneDef =>
  lane(id, {
    enter_at: '2.1',
    stages: stages({ S2: stage('S2', 'partial', S2_NO_ELABORATION) }),
    profile: profile('g2_oracle_specs'),
    exit: 'standard',
    follow_up: null,
    reentry: null,
    unspecified: [
      ...FULL_PATH_NOTES,
      'how L4 and L5 differ in the flow: not drawn (L5 needs staging separation, OB §2.1)',
    ],
  });

export const LANES: Readonly<Record<Lane, LaneDef>> = {
  L0: lane('L0', {
    enter_at: 'SCHED',
    stages: stages({
      S2: stage('S2', 'skipped'),
      S3: stage('S3', 'skipped'),
      S4: stage('S4', 'skipped'),
      S5: stage('S5', 'skipped'),
    }),
    profile: profile('repro_test'),
    exit: 'standard',
    follow_up: {
      lane: 'L1',
      overdue: { key: 'overdue', value: 5, unit: 'business_days', tune: false },
      effect: 'block_new_agent_items',
    },
    reentry: null,
    unspecified: [NO_ENVELOPE, 'whether L0 is allowed at any onboarding level (OB §2.1 is silent)'],
  }),
  L1: L1_L3('L1'),
  L2: L1_L3('L2'),
  L3: L1_L3('L3'),
  L4: L4_L5('L4'),
  L5: L4_L5('L5'),
  L6: lane('L6', {
    enter_at: '2.1',
    stages: stages({}),
    profile: profile('g2_oracle_specs'),
    exit: 'standard',
    follow_up: null,
    reentry: null,
    unspecified: FULL_PATH_NOTES,
  }),
  L7: lane('L7', {
    enter_at: '2.1',
    stages: stages(
      {
        S1: stage('S1', 'full'),
        S2: stage('S2', 'partial', S2_NO_ELABORATION),
        S3: stage('S3', 'skipped'),
        S4: stage('S4', 'skipped'),
        S5: stage('S5', 'skipped'),
        S6: stage(
          'S6',
          'partial',
          stepsOf('S6').filter((s) => s !== '6.6'),
        ),
        S7: stage('S7', 'skipped'),
        S8: stage('S8', 'skipped'),
        S8b: stage('S8b', 'skipped'),
        S9: stage('S9', 'partial', ['9.3']),
      },
      'skipped',
    ),
    profile: profile('unspecified', {
      mandatory_steps: [],
      mandatory_gates: [],
      mandatory_exemption:
        'L7 never reaches the Push Broker or G4 (FIX 6): the throwaway S6 ends in the spike report, which goes straight to 9.3',
    }),
    exit: 'spike_report',
    follow_up: null,
    reentry: null,
    unspecified: [
      NO_ENVELOPE,
      'whether L7 is allowed at any onboarding level (OB §2.1 is silent)',
      'oracle source of a throwaway build',
      'whether 9.4 Learn runs after the spike report (the flow draws SPIKE -> 9.3 only)',
      'whether the X-gates of 6.4 apply in the throwaway S6',
    ],
  }),
  L8: lane('L8', {
    enter_at: null,
    stages: stages({
      S2: stage('S2', 'unspecified'),
      S3: stage('S3', 'unspecified'),
      S4: stage('S4', 'unspecified'),
      S5: stage('S5', 'unspecified'),
      S6: stage('S6', 'unspecified'),
      S8b: stage('S8b', 'unspecified'),
      S9: stage('S9', 'unspecified'),
    }),
    profile: profile('unspecified'),
    exit: 'standard',
    follow_up: null,
    reentry: { D4: '6.4', D5: '7.1' },
    unspecified: [
      NO_ENVELOPE,
      'oracle source of human-led work',
      'which of S2-S5 the lane carries before the human takes over',
      'whether S8b, S9 and the G5/G6 gates follow after G4',
    ],
  }),
};

/** Lane ids in order, for iteration. */
export const LANE_IDS: readonly Lane[] = LaneValues;
