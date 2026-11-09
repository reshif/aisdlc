import {
  STEP_ARTEFACT,
  type ArtefactType,
  type AssumptionReport,
  type Lane,
  type ProposalKind,
  type StageOutcome,
  type StepId,
} from '@aisdlc/contracts';
import type { OutputFieldError } from '@aisdlc/agents';
import { R2_TRIGGER } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';

// The planning steps of S2 and S3 (PLAN M12.1, M12.2) as data: which agent output each expects, which
// earlier artefacts it is given, which artefact it becomes and what the step answers once it is stored.
// 3.3 is the one deterministic step (`agent: false`): code, not an agent.

export const PLANNING_STEPS = [
  '2.1',
  '2.1b',
  '2.2',
  '2.3',
  '2.4',
  '3.1',
  '3.2',
  '3.3',
  '3.4',
  '3.5',
] as const satisfies readonly StepId[];
export type PlanningStep = (typeof PLANNING_STEPS)[number];
export const isPlanningStep = (s: StepId): s is PlanningStep =>
  (PLANNING_STEPS as readonly string[]).includes(s);

type Out = Record<string, unknown>;
type StageOutcomeHash = Extract<StageOutcome, { outcome: 'completed' }>['output_hash'];

export interface StepSpec {
  readonly agent: boolean;
  readonly artefact: ArtefactType;
  readonly proposal: ProposalKind | null;
  /** The factory's instruction for the step (context level 1), naming the output the schema must carry. */
  readonly task: string;
  /** The earlier artefacts the step is given (the newest of each type; absent ones are skipped). */
  readonly inputs: readonly ArtefactType[];
  /** The request text is given as data (steps that read the ask itself). */
  readonly request: boolean;
  /** The output must be this kind of the agent's schema (a field-level error otherwise). */
  readonly expects: (o: Out) => boolean;
}

const doc = (kind: string) => (o: Out) => o['kind'] === 'document' && o['document'] === kind;

export const STEP_SPECS: Readonly<Record<PlanningStep, StepSpec>> = {
  '2.1': {
    agent: true,
    artefact: 'context_brief',
    proposal: 'shape',
    task: 'Step 2.1, ground the request in the code and docs. Answer with a `document` output whose `document` is `context_brief`. List in `ambiguity` every point where the accepted intent is unclear; leave it out when it is clear. Cite evidence only from the merged commit.',
    inputs: [],
    request: true,
    expects: doc('context_brief'),
  },
  '2.1b': {
    agent: true,
    artefact: 'reverse_engineering',
    proposal: 'reverse_engineering',
    task: 'Step 2.1b, focused reverse-engineering of the area the change touches. Answer with a `reverse_engineering` output with `depth` `focused`. Every claim carries evidence from the merged commit.',
    inputs: ['context_brief'],
    request: false,
    expects: (o) => o['kind'] === 'reverse_engineering' && o['depth'] === 'focused',
  },
  '2.2': {
    agent: true,
    artefact: 'impact',
    proposal: 'shape',
    task: 'Step 2.2, impact and stakeholders. Answer with a `document` output whose `document` is `impact`.',
    inputs: ['context_brief', 'reverse_engineering'],
    request: false,
    expects: doc('impact'),
  },
  '2.3': {
    agent: true,
    artefact: 'decision_brief',
    proposal: 'shape',
    task: 'Step 2.3, options and a decision brief. Answer with an `options` output. Set `sizing` to `smaller` only when the work is smaller than the lane it was routed to.',
    inputs: ['context_brief', 'reverse_engineering', 'impact'],
    request: false,
    expects: (o) => o['kind'] === 'options',
  },
  '2.4': {
    agent: true,
    artefact: 'initiative',
    proposal: 'shape',
    task: 'Step 2.4, initiative elaboration. Answer with a `document` output whose `document` is `initiative`.',
    inputs: ['context_brief', 'reverse_engineering', 'impact', 'decision_brief'],
    request: false,
    expects: doc('initiative'),
  },
  '3.1': {
    agent: true,
    artefact: 'affected_requirements',
    proposal: 'spec',
    task: 'Step 3.1, locate the requirements this change affects. Answer with an `affected_requirements` output.',
    inputs: ['context_brief', 'impact', 'decision_brief'],
    request: true,
    expects: (o) => o['kind'] === 'affected_requirements',
  },
  '3.2': {
    agent: true,
    artefact: 'spec_delta',
    proposal: 'spec',
    task: 'Step 3.2, draft the delta spec. Answer with a `spec_delta` output: one entry per requirement, each with its id. When earlier findings are given, fix every one of them.',
    inputs: [
      'affected_requirements',
      'decision_brief',
      'spec_delta',
      'validation_report',
      'spec_review',
    ],
    request: true,
    expects: (o) => o['kind'] === 'spec_delta',
  },
  '3.3': {
    agent: false,
    artefact: 'validation_report',
    proposal: null,
    task: '',
    inputs: ['spec_delta', 'affected_requirements'],
    request: false,
    expects: () => true,
  },
  '3.4': {
    agent: true,
    artefact: 'oracle_specs',
    proposal: 'oracle',
    task: 'Step 3.4, oracle specs. Answer with an `oracle_specs` output: every oracle maps to a requirement of the delta spec by its id.',
    inputs: ['spec_delta'],
    request: false,
    expects: (o) => o['kind'] === 'oracle_specs',
  },
  '3.5': {
    agent: true,
    artefact: 'spec_review',
    proposal: 'review',
    task: 'Step 3.5, review the delta spec and its oracle specs. You see only those artefacts. Answer with a `review` output whose `check` is `spec_review`.',
    inputs: ['spec_delta', 'oracle_specs'],
    request: false,
    expects: (o) => o['kind'] === 'review' && o['check'] === 'spec_review',
  },
};

// A step's artefact must be the one the contracts say (`STEP_ARTEFACT`): the table above restates nothing else.
for (const s of PLANNING_STEPS) {
  if (STEP_ARTEFACT[s] !== STEP_SPECS[s].artefact)
    throw new Error(`step ${s}: artefact table drift`);
}

/** The field-level errors of an output of the wrong kind for its step. */
export const wrongKind = (spec: StepSpec, o: Out): OutputFieldError[] =>
  spec.expects(o)
    ? []
    : [{ path: 'kind', code: 'wrong_kind_for_step', message: 'not the output this step expects' }];

/** Every `commit_sha` an output cites must be the merged head (merged-SHA grounding, M11.4). */
export function ungrounded(o: unknown, merged: string, path = '$'): OutputFieldError[] {
  const out: OutputFieldError[] = [];
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'commit_sha' && typeof x === 'string' && x !== merged) {
          out.push({
            path: `${at}.${k}`,
            code: 'not_grounded',
            message: 'cites a commit that is not the merged head',
          });
        } else walk(x, at === '$' ? k : `${at}.${k}`);
      }
    }
  };
  walk(o, path);
  return out;
}

const reportsOf = (o: Out): AssumptionReport[] =>
  (Array.isArray(o['assumptions'])
    ? (o['assumptions'] as Array<{ kind: string; text: string }>)
    : []
  ).map((a) => ({
    kind: a.kind as AssumptionReport['kind'],
    text_hash: sha256Hex(a.text) as AssumptionReport['text_hash'],
  }));

/**
 * What the step answers once its artefact is stored. 2.1 with an ambiguity is B2 (back to 1.5, G1 again, 2x
 * then E4: the engine counts); 2.3 `smaller` is R2 toward the next rung down the ladder (E1 decides); 3.3 and
 * 3.5 with findings are B3 (the validator and the critic: 3 automatic rounds, then ET8: the engine counts).
 */
export function outcomeFor(
  step: PlanningStep,
  content: Out,
  sha256: string,
  ctx: { readonly lane: Lane; readonly shallower: Lane | null },
): StageOutcome {
  const hash = sha256 as StageOutcomeHash;
  switch (step) {
    case '2.1': {
      const amb = Array.isArray(content['ambiguity']) ? content['ambiguity'] : [];
      if (amb.length > 0) return { outcome: 'rework', edge: 'B2', reason_code: 'intent_ambiguous' };
      break;
    }
    case '2.3':
      if (content['sizing'] === 'smaller' && ctx.shallower !== null) {
        return {
          outcome: 'relane',
          edge: 'R2',
          trigger: R2_TRIGGER,
          to_lane: ctx.shallower,
          reason_code: 'smaller_than_lane',
        };
      }
      break;
    case '3.3':
      if (content['verdict'] === 'findings') {
        return { outcome: 'rework', edge: 'B3', reason_code: 'validator_failed' };
      }
      break;
    case '3.5':
      if (content['verdict'] === 'findings') {
        return { outcome: 'rework', edge: 'B3', reason_code: 'critic_findings' };
      }
      break;
    default:
      break;
  }
  const assumptions = reportsOf(content);
  return {
    outcome: 'completed',
    output_hash: hash,
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}
