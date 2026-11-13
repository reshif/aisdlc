import type { ModelCompleteRequest } from '@aisdlc/contracts';
import type { ScriptedReply } from './model-provider.js';

// Canned answers for the planning steps (S1 to S5), for the deterministic fake provider of a LOCAL factory
// (the gateway's `fake` adapter with `fixtures: "planning"`, never prod: the gateway refuses a fake in prod).
// The planning port puts the step in the input it sends (`Input (data, as JSON): {"step": ...}`), and the
// fake answers each step with one valid output of that step's schema, so a local stack can run a request
// through the real port, the real gateway and the real gates without a model. They cite no file (no commit
// the stack would have to know), and a call that is not a planning input gets no fixture (the fake's
// own default reply).

const doc = (document: string, title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'document',
  document,
  title,
  sections: [{ heading: `${title}: findings`, text: `What the ${title.toLowerCase()} says.` }],
  citations: [],
  assumptions: [],
  ...extra,
});

const schemaFile = JSON.stringify({
  type: 'object',
  properties: { rows: { type: 'array', items: { type: 'string' } } },
  required: ['rows'],
});

/** One valid output per planning step. */
export const PLANNING_FIXTURES: Readonly<Record<string, unknown>> = {
  '1.3': {
    kind: 'classification',
    work_type: 'change',
    size: 'standard',
    risk: 'standard',
    confidence: 0.9,
    rationale: 'an ordinary change of standard size',
  },
  '1.5': {
    kind: 'intent_block',
    goal: 'Let admins export the audit log as CSV.',
    non_goals: ['Scheduled exports'],
    acceptance_criteria: ['An admin can download a CSV of the audit log'],
    open_questions: [],
    assumptions: [{ kind: 'intent', text: 'CSV is enough' }],
  },
  '2.1': doc('context_brief', 'Context brief'),
  '2.1b': { kind: 'reverse_engineering', depth: 'focused', claims: [], unknowns: ['Retention'] },
  '2.2': doc('impact', 'Impact'),
  '2.3': {
    kind: 'options',
    options: [
      { title: 'Extend the log', summary: 'Add an export route.', pros: ['small'], cons: [] },
      { title: 'New service', summary: 'Export elsewhere.', pros: [], cons: ['large'] },
    ],
    recommended: 0,
    rationale: 'The smaller change fits the lane.',
    citations: [],
    assumptions: [],
  },
  '2.4': doc('initiative', 'Initiative'),
  '3.1': {
    kind: 'affected_requirements',
    requirements: [{ requirement_id: 'REQ-12', path: 'docs/specs/audit.md', reason: 'the log' }],
  },
  '3.2': {
    kind: 'spec_delta',
    delta: [
      {
        requirement_id: 'REQ-12',
        change: 'modified',
        text: 'The audit log can be exported as CSV.',
      },
    ],
    assumptions: [],
  },
  '3.4': {
    kind: 'oracle_specs',
    oracles: [
      {
        oracle_id: 'o1',
        requirement_id: 'REQ-12',
        description: 'GET /export returns CSV',
        expected_failure: 'the route does not exist: 404',
      },
    ],
  },
  '3.5': { kind: 'review', check: 'spec_review', verdict: 'pass', findings: [] },
  '4.1': doc('adr', 'Decisions'),
  '4.2': doc('contracts', 'Contracts', {
    contract_files: [
      { path: 'docs/contracts/export.schema.json', format: 'json_schema', content: schemaFile },
    ],
    network_calls: [],
  }),
  '4.3': doc('data_migration', 'Data', {
    migrations: [{ name: '0042_export_job', reversible: true }],
  }),
  '4.4': doc('nfr_threat_ops', 'NFR, threats and operations', { network_calls: [] }),
  '4.5': { kind: 'review', check: 'constitution', verdict: 'pass', findings: [] },
  '5.1': {
    kind: 'plan_split',
    units: [
      {
        unit_key: 'export-route',
        title: 'Export route',
        paths: ['src/audit/'],
        size: 'small',
        depends_on: [],
      },
      {
        unit_key: 'export-ui',
        title: 'Export button',
        paths: ['src/ui/audit.tsx'],
        size: 'medium',
        depends_on: ['export-route'],
      },
    ],
    assumptions: [],
  },
  '5.2': {
    kind: 'plan_sequence',
    order: ['export-route', 'export-ui'],
    rationale: 'the button needs the route',
    assumptions: [],
  },
  '5.3': {
    kind: 'plan_tasks',
    units: [
      {
        unit_key: 'export-route',
        tasks: [{ task_id: 't1', description: 'Add GET /export', verification: 'npm test' }],
      },
      {
        unit_key: 'export-ui',
        tasks: [{ task_id: 't2', description: 'Add the button', verification: 'npm test' }],
      },
    ],
    assumptions: [],
  },
  '5.4': {
    kind: 'plan_verification',
    bindings: [
      { unit_key: 'export-route', oracle_ids: ['o1'] },
      { unit_key: 'export-ui', oracle_ids: ['o1'] },
    ],
    assumptions: [],
  },
  '5.6': {
    kind: 'plan_capacity',
    max_parallel_units: 1,
    review_minutes: [
      { unit_key: 'export-route', minutes: 20 },
      { unit_key: 'export-ui', minutes: 30 },
    ],
    rationale: 'one reviewer',
    assumptions: [],
  },
};

const INPUT = /Input \(data, as JSON\):\n(\{[\s\S]*\})\s*$/;

/** The step a planning call is for (read from the input the planning port sent), or `null` for any other call. */
export function planningStepOf(req: ModelCompleteRequest): string | null {
  const first = req.messages[0];
  const text =
    typeof first?.content === 'string'
      ? first.content
      : (first?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  const m = INPUT.exec(text);
  if (!m) return null;
  try {
    const step = (JSON.parse(m[1] as string) as { step?: unknown }).step;
    return typeof step === 'string' ? step : null;
  } catch {
    return null;
  }
}

/** The fixture reply for a planning call; `undefined` when the call is not one (or the step has no fixture). */
export function planningFixtureReply(req: ModelCompleteRequest): ScriptedReply | undefined {
  const step = planningStepOf(req);
  const out = step === null ? undefined : PLANNING_FIXTURES[step];
  return out === undefined ? undefined : { text: JSON.stringify(out) };
}

/**
 * Portal v2: the onboarding agent's canned answer on a local stack (its system prompt is the registry's
 * `onboarding@` file). One valid `onboarding.v1` output that cites no file and proposes one fix with a file
 * (CODEOWNERS); the factory still checks every path and secret, and drops a file the repo already has.
 */
export const ONBOARDING_FIXTURE = {
  kind: 'onboarding',
  summary:
    'The repo was read at its census commit. A code owners file is proposed; the rest is what the census found.',
  learned: [
    {
      topic: 'owners',
      status: 'needs_fix',
      text: 'Owners should be named in CODEOWNERS.',
      evidence: [],
    },
    { topic: 'tests', status: 'unknown', text: 'The test command is not known yet.', evidence: [] },
  ],
  claims: [],
  fixes: [
    {
      fix_id: 'codeowners',
      fix_kind: 'codeowners',
      title: 'Add a code owners file',
      why: 'Code review needs an owner for every path.',
      files: [
        {
          path: '.github/CODEOWNERS',
          content: '# Proposed by the onboarding agent.\n* @alice-gh\n',
        },
      ],
      manual_steps: [],
    },
  ],
  questions: ['Does a merge to the default branch deploy anywhere?'],
  gap_suggestions: [],
};

/**
 * The onboarding console's canned answer on a local stack (its system prompt is the registry's `onboarder@` file): one
 * valid `onboarder.v1` turn that reads nothing and cites nothing. The factory still judges it like any other answer.
 */
export const ONBOARDER_FIXTURE = {
  kind: 'turn',
  text: 'I looked at where this onboarding stands. The list on the left says what is in the way and whose move it is; tell me what you want to look at first.',
  citations: [],
  next: 'await_person',
  noticed: [],
};

/** The fixture reply for the onboarder's call; `undefined` for any other call. */
export function onboarderFixtureReply(req: ModelCompleteRequest): ScriptedReply | undefined {
  return req.system?.startsWith('# onboarder @')
    ? { text: JSON.stringify(ONBOARDER_FIXTURE) }
    : undefined;
}

/** The fixture reply for the onboarding agent's call; `undefined` for any other call. */
export function onboardingFixtureReply(req: ModelCompleteRequest): ScriptedReply | undefined {
  return req.system?.startsWith('# onboarding @')
    ? { text: JSON.stringify(ONBOARDING_FIXTURE) }
    : undefined;
}
