import type { ModelCompleteRequest } from '@aisdlc/contracts';
import type { ScriptedReply } from './model-provider.js';
import { PLANNING_FIXTURES, planningStepOf } from './planning-fixtures.js';

// The deterministic fake provider's `testbed` fixtures (the gateway's `fake` adapter with `fixtures: "testbed"`, a LOCAL
// factory only: the gateway refuses a fake in prod). They carry ONE small change through the whole lifecycle of the
// compose stack's fake testbed repository (`reshif/asf-factory-testbed`: `src/index.js`, `node --test`), so the
// request-to-PR e2e runs every real port with no model:
//
//   - the planning steps (S1 to S5): the `planning` answers, with the ones that name the work replaced by a coherent
//     story for the testbed: a small change (the factory routes it to L3), one Unit `farewell` scoped to `src/`, one
//     oracle;
//   - 6.3 (A6 in a W session): a Write of one oracle test file carrying the marker the prompt asks for (id and spec hash
//     copied from the prompt), red before the implementation by an assertion, then the agent's final answer;
//   - 6.4 (the coder in a W session): a Write of the implementation (a NEW file, so the harness needs no prior Read),
//     then the implementation.v1 answer;
//   - 7.3 and 7.5 (A5 through the gateway): a passing review.v1 of the check the prompt names.
//
// A conversation is read for where it is: a session whose last turn carries a tool result has written its file and
// answers; one that has not writes it. Anything else gets no fixture (the fake's own default reply).

export const TESTBED_ORACLE_PATH = 'test/farewell.oracle.test.js';
export const TESTBED_IMPLEMENTATION_PATH = 'src/farewell.js';
export const TESTBED_IMPLEMENTATION = 'export const farewell = (name) => `goodbye ${name}`;\n';

/** The oracle test A6 writes, with the marker line the 6.3 prompt names. */
export const testbedOracle = (marker: string): string =>
  [
    marker,
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('farewell(name) says goodbye to name', async () => {",
    '  let m = {};',
    '  try {',
    "    m = await import('../src/farewell.js');",
    '  } catch {',
    '    // not written yet: the assertion below fails, as an oracle must before the implementation',
    '  }',
    "  assert.equal(typeof m.farewell === 'function' ? m.farewell('x') : undefined, 'goodbye x');",
    "  assert.equal(typeof m.farewell === 'function' ? m.farewell('Ana') : undefined, 'goodbye Ana');",
    '});',
    '',
  ].join('\n');

const UNIT = 'farewell';

/** The planning answers that name the work, for the testbed (the rest are the `planning` ones). */
export const TESTBED_PLANNING: Readonly<Record<string, unknown>> = {
  ...PLANNING_FIXTURES,
  '1.3': {
    kind: 'classification',
    work_type: 'change',
    size: 'small',
    risk: 'standard',
    confidence: 0.9,
    rationale: 'one new function next to the existing one, with its test',
  },
  '1.5': {
    kind: 'intent_block',
    goal: 'Add a farewell(name) function that says goodbye, next to greet.',
    non_goals: ['Changing greet'],
    acceptance_criteria: ['farewell("x") returns "goodbye x"'],
    open_questions: [],
    assumptions: [{ kind: 'intent', text: 'The wording mirrors greet' }],
  },
  '3.1': {
    kind: 'affected_requirements',
    requirements: [
      { requirement_id: 'REQ-1', path: 'docs/overview.md', reason: 'the testbed has one function' },
    ],
  },
  '3.2': {
    kind: 'spec_delta',
    delta: [
      {
        requirement_id: 'REQ-1',
        change: 'modified',
        text: 'The testbed also has farewell(name), which returns "goodbye <name>".',
      },
    ],
    assumptions: [],
  },
  '3.4': {
    kind: 'oracle_specs',
    oracles: [
      {
        oracle_id: 'o1',
        requirement_id: 'REQ-1',
        description: 'farewell(name) returns "goodbye <name>"',
        expected_failure: 'farewell does not exist: the assertion fails',
      },
    ],
  },
  '5.1': {
    kind: 'plan_split',
    units: [{ unit_key: UNIT, title: 'farewell', paths: ['src/'], size: 'small', depends_on: [] }],
    assumptions: [],
  },
  '5.2': { kind: 'plan_sequence', order: [UNIT], rationale: 'one Unit', assumptions: [] },
  '5.3': {
    kind: 'plan_tasks',
    units: [
      {
        unit_key: UNIT,
        tasks: [
          {
            task_id: 't1',
            description: 'Add src/farewell.js exporting farewell(name)',
            verification: 'npm test',
          },
        ],
      },
    ],
    assumptions: [],
  },
  '5.4': {
    kind: 'plan_verification',
    bindings: [{ unit_key: UNIT, oracle_ids: ['o1'] }],
    assumptions: [],
  },
  '5.6': {
    kind: 'plan_capacity',
    max_parallel_units: 1,
    review_minutes: [{ unit_key: UNIT, minutes: 10 }],
    rationale: 'one reviewer, one small Unit',
    assumptions: [],
  },
};

const textOf = (c: ModelCompleteRequest['messages'][number]['content'] | undefined): string =>
  typeof c === 'string' ? c : (c ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

/** Has the session already had a tool result back (its file is written)? */
const afterTool = (req: ModelCompleteRequest): boolean => {
  const last = req.messages[req.messages.length - 1];
  return (
    last !== undefined &&
    last.role === 'user' &&
    typeof last.content !== 'string' &&
    last.content.some((b) => b.type === 'tool_result')
  );
};

const write = (path: string, content: string): ScriptedReply => ({
  tool_uses: [{ name: 'Write', input: { file_path: `/work/repo/${path}`, content } }],
});

const MARKER = /^\s*(\/\/ aisdlc-oracle id=\S+ spec=[0-9a-f]{64})\s*$/m;
const REVIEW = /Answer with ONE review\.v1 JSON object whose "check" is "([a-z_]+)"/;

/** The fixture reply for a call of the testbed's lifecycle; `undefined` when the call is none of them. */
export function testbedFixtureReply(req: ModelCompleteRequest): ScriptedReply | undefined {
  const step = planningStepOf(req);
  if (step !== null) {
    const out = TESTBED_PLANNING[step];
    return out === undefined ? undefined : { text: JSON.stringify(out) };
  }
  const first = textOf(req.messages[0]?.content);
  const review = REVIEW.exec(textOf(req.messages[req.messages.length - 1]?.content));
  if (review) {
    return {
      text: JSON.stringify({ kind: 'review', check: review[1], verdict: 'pass', findings: [] }),
    };
  }
  if (first.includes('Step 6.3: write the oracle tests')) {
    const m = MARKER.exec(first);
    if (!m) return undefined;
    if (afterTool(req))
      return { text: JSON.stringify({ status: 'completed', summary: 'wrote the oracle' }) };
    return write(TESTBED_ORACLE_PATH, testbedOracle(m[1] as string));
  }
  if (/answer with ONE JSON object of the schema implementation\.v1/.test(first)) {
    if (afterTool(req)) {
      return {
        text: JSON.stringify({
          kind: 'implementation',
          status: 'completed',
          summary: 'added farewell(name)',
          files_changed: [{ path: TESTBED_IMPLEMENTATION_PATH, change: 'added' }],
          checks_run: [{ name: 'npm test', passed: true }],
        }),
      };
    }
    return write(TESTBED_IMPLEMENTATION_PATH, TESTBED_IMPLEMENTATION);
  }
  return undefined;
}
