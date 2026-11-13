import type { AgentId } from '@aisdlc/contracts';

// One valid output per output kind of every agent: the deterministic fake of an agent's answer (M12's
// planning port and the eval fake provider script from these), and the fixture of the schema tests.
// They are data, not logic; `validateOutput` accepts every one (a test checks), and a test checks that
// every kind of every schema has a sample.

const SHA = 'a'.repeat(40);
const ITEM = '0190a000-0000-7000-8000-000000000001';
const evidence = [{ path: 'src/app.ts', commit_sha: SHA, lines: '10-20' }];

const implementation = [
  {
    kind: 'implementation',
    status: 'completed',
    summary: 'Added the endpoint and its test.',
    files_changed: [{ path: 'src/app.ts', change: 'modified' }],
    checks_run: [{ name: 'npm test', passed: true }],
  },
  {
    kind: 'implementation',
    status: 'blocked',
    summary: 'Needs a new package.',
    files_changed: [],
    checks_run: [],
    blocker: { reason: 'new_dependency', detail: 'The task needs `left-pad`.' },
  },
];

/** `AgentId` -> valid outputs, one per `kind`. */
export const SAMPLE_OUTPUTS: Readonly<Record<AgentId, readonly Record<string, unknown>[]>> = {
  A1: [
    {
      kind: 'duplicate_scan',
      duplicates: [{ item_id: ITEM, similarity: 0.9, reason: 'same endpoint' }],
      conflicts: [],
    },
    {
      kind: 'classification',
      work_type: 'change',
      size: 'small',
      risk: 'standard',
      confidence: 0.8,
      rationale: 'a small change in one module',
    },
    { kind: 'suitability', suitable: true, concerns: [] },
  ],
  A2: [
    { kind: 'questions', questions: [{ text: 'Which clients call this?', material: 'blocking' }] },
    {
      kind: 'intent_block',
      goal: 'Let admins export the audit log.',
      non_goals: ['Scheduled exports'],
      acceptance_criteria: ['An admin can download a CSV'],
      open_questions: [],
      assumptions: [{ kind: 'intent', text: 'CSV is enough' }],
    },
    {
      kind: 'affected_requirements',
      requirements: [
        { requirement_id: 'REQ-12', path: 'docs/specs/audit.md', reason: 'defines the log' },
      ],
    },
    {
      kind: 'spec_delta',
      delta: [
        { requirement_id: 'REQ-12', change: 'modified', text: 'The log can be exported as CSV.' },
      ],
      assumptions: [],
    },
  ],
  A3: [
    {
      kind: 'document',
      document: 'context_brief',
      title: 'Context',
      sections: [{ heading: 'Where it lives', text: 'The log is written by the audit module.' }],
      citations: evidence,
      assumptions: [],
    },
    {
      kind: 'options',
      options: [
        { title: 'Extend the log', summary: 'Add an export route.', pros: ['small'], cons: [] },
        { title: 'New service', summary: 'Export elsewhere.', pros: [], cons: ['large'] },
      ],
      recommended: 0,
      rationale: 'The smaller change fits the lane.',
      citations: evidence,
      assumptions: [],
    },
    {
      kind: 'plan_split',
      units: [
        {
          unit_key: 'u1',
          title: 'Export route',
          paths: ['src/audit/'],
          size: 'small',
          depends_on: [],
        },
      ],
      assumptions: [],
    },
    { kind: 'plan_sequence', order: ['u1'], rationale: 'One Unit.', assumptions: [] },
    {
      kind: 'plan_tasks',
      units: [
        {
          unit_key: 'u1',
          tasks: [{ task_id: 't1', description: 'Add GET /export', verification: 'npm test' }],
        },
      ],
      assumptions: [],
    },
    {
      kind: 'plan_verification',
      bindings: [{ unit_key: 'u1', oracle_ids: ['o1'] }],
      assumptions: [],
    },
    {
      kind: 'plan_capacity',
      max_parallel_units: 1,
      review_minutes: [{ unit_key: 'u1', minutes: 30 }],
      rationale: 'One reviewer.',
      assumptions: [],
    },
    {
      kind: 'learn',
      observations: ['Two rounds were spent on the oracle specs.'],
      proposals: [{ target_key: 'catalogue.limits', rationale: 'B3 is hit often' }],
    },
  ],
  A4: implementation,
  A5: [
    { kind: 'review', check: 'spec_review', verdict: 'pass', findings: [] },
    {
      kind: 'review',
      check: 'constitution',
      verdict: 'findings',
      findings: [
        {
          severity: 'high',
          rule_id: 'C-4',
          location: { path: 'src/app.ts', line: 12 },
          message: 'Reads a secret from the environment.',
        },
      ],
    },
  ],
  A6: [
    {
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
  ],
  A7: [{ kind: 'unspecified', summary: 'No behaviour is defined for this agent.' }],
  A8: [{ kind: 'unspecified', summary: 'No behaviour is defined for this agent.' }],
  A9: [
    {
      kind: 'reverse_engineering',
      depth: 'shallow',
      claims: [{ claim_id: 'c1', text: 'The audit log is a table.', confidence: 'high', evidence }],
      unknowns: ['Retention is unclear'],
    },
  ],
  A10: [{ kind: 'unspecified', summary: 'No behaviour is defined for this agent.' }],
  A11: [
    {
      kind: 'handoff_pack',
      attempted: ['Three rounds of the check failing on the export test'],
      current_state: 'The route exists; the CSV header is wrong.',
      open_questions: ['Is a BOM wanted?'],
      recommended_choice: 'resume',
    },
  ],
  A12: [
    {
      kind: 'extraction',
      items: [{ item_kind: 'living_spec_seed', title: 'Audit log export', evidence }],
    },
  ],
  coder: implementation,
  onboarding: [
    {
      kind: 'onboarding',
      summary:
        'A small TypeScript service. Tests run with `npm test`; there is no CODEOWNERS file.',
      learned: [
        { topic: 'tests', status: 'ok', text: 'npm test runs vitest.', evidence },
        { topic: 'owners', status: 'needs_fix', text: 'No CODEOWNERS file.', evidence: [] },
      ],
      claims: [{ claim_id: 'c1', text: 'Tests run with npm test.', confidence: 'high', evidence }],
      fixes: [
        {
          fix_id: 'codeowners',
          fix_kind: 'codeowners',
          title: 'Add a CODEOWNERS file',
          why: 'Code review needs an owner for every path.',
          files: [{ path: '.github/CODEOWNERS', content: '* @alice\n' }],
          manual_steps: [],
        },
        {
          fix_id: 'protect-main',
          fix_kind: 'protect_main_ruleset',
          title: 'Protect the main branch',
          why: 'Agents may only open PRs into a protected branch.',
          files: [],
          manual_steps: ['On GitHub open Settings, Rules, Rulesets, and import the ruleset.'],
        },
      ],
      questions: ['Does a merge to main deploy?'],
      gap_suggestions: [
        { gap_id: 'g1', disposition: 'file_issue', why: 'Blocking for the level.' },
      ],
    },
  ],
  assistant: [
    {
      kind: 'answer',
      text: 'Step 0.4 waits on card 4: it asks what the factory cannot read, then the role map.',
      citations: [
        { kind: 'record', ref: 's0:0190a000-0000-7000-8000-000000000002' },
        { kind: 'file', path: 'AGENTS.md', commit_sha: SHA, line_from: 1, line_to: 4 },
      ],
      proposals: [
        {
          action: 'open_card',
          target: '0190a000-0000-7000-8000-000000000003',
          label: 'Open card 4',
        },
      ],
      drafts: [],
      noticed: [],
    },
    {
      kind: 'refusal',
      text: 'I never decide or affirm a card. I can open it; you decide it there.',
      citations: [],
      proposals: [],
      drafts: [],
      noticed: [],
    },
  ],
};
