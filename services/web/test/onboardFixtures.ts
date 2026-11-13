import type { OnboardingSummaryView } from '@aisdlc/contracts';
import { S0_ID } from './helpers';

// The one onboarding summary as core assembles it (portal v2, N12): a Read-only onboarding at card 1 with the agent's
// proposal, a fix PR open on GitHub and one fix only a person can do.

const H = 'a'.repeat(64);
const SHA = 'c'.repeat(40);

export function summary(over: Partial<OnboardingSummaryView> = {}): OnboardingSummaryView {
  return {
    s0_id: S0_ID as never,
    project_id: 'testbed',
    repo: 'reshif/asf-factory-testbed' as never,
    status: 'card',
    requested_level: 'census',
    signable_level: 'census',
    steps: [
      { step: '0.1', state: 'card', cause: null },
      { step: '0.2', state: 'skip', cause: null },
      { step: '0.4', state: 'todo', cause: null },
    ],
    waiting: null,
    agent: {
      output_hash: H as never,
      model: 'fake-onboarding',
      proposed_at: '2026-11-13T10:00:00.000Z',
      summary: 'reshif/asf-factory-testbed was read at commit ccccccc.',
      learned: [
        { topic: 'owners', status: 'needs_fix', text: 'No CODEOWNERS file.', evidence: [] },
        {
          topic: 'tests',
          status: 'ok',
          text: 'npm test runs vitest.',
          evidence: ['package.json:12'],
        },
      ],
      claims: [
        {
          claim_id: 'c1',
          text: 'Tests run with npm test.',
          confidence: 'high',
          evidence: ['package.json:12'],
        },
      ],
      questions: ['Does a merge to the default branch deploy anywhere?'],
      dropped: 0,
    },
    fixes: [
      {
        fix_id: 'codeowners',
        fix_kind: 'codeowners',
        title: 'Add a code owners file',
        why: 'Code review needs an owner for every path.',
        paths: ['.github/CODEOWNERS'],
        manual_steps: [],
        state: 'pr_open',
        pr: {
          number: 7,
          url: 'https://github.com/reshif/asf-factory-testbed/pull/7',
          branch: 'agent/x/onboarding-fixes',
        },
        approval: { card_id: 'card-x2', status: 'approve', may_decide: false },
      },
      {
        fix_id: 'protect-main',
        fix_kind: 'protect_main_ruleset',
        title: 'Protect the main branch',
        why: 'Agents may only open PRs into a protected branch.',
        paths: [],
        manual_steps: ['On GitHub, open Settings, then Rules, then Rulesets.'],
        state: 'manual',
        pr: null,
        approval: null,
      },
    ],
    census: {
      census_hash: H as never,
      baseline_sha: SHA as never,
      posture: 'amber',
      tier_floor: 'T0',
      t0_required: true,
      attest: [],
      blockers_open: [],
      gaps: [
        {
          gap_id: 'g1',
          criterion: 'LF2',
          severity: 'blocking',
          allowed: ['file_issue'],
          suggested: 'file_issue',
          why: 'It blocks the level.',
        },
      ],
    },
    controls: {
      report_hash: H as never,
      blocking_open: [],
      rows: [
        {
          id: 'protect_main',
          status: 'not_met',
          blocking: false,
          instruction: 'Protect main on GitHub.',
        },
      ],
      attestations_required: [],
      operations_md: false,
    },
    role_map: {
      proposed: Object.fromEntries(
        ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'].map(
          (s) => [
            s,
            { kind: 'principals', principals: s === 'admin' || s === 'm4' ? ['alice'] : [] },
          ],
        ),
      ) as never,
      unmapped_logins: [],
      tier: 'T0',
    },
    light: null,
    readiness: { level: 'census', prr: null },
    cards: [{ card: 'C1', card_id: 'card-c1', status: 'open', live: true, by_sign_off: true }],
    sign_off: { state: 'ready', note: null, may_sign: true, step_up: null, started_by: null },
    summary_hash: H as never,
    ...over,
  };
}
