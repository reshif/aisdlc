import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';
import {
  BASE,
  CARD,
  HEAD,
  ITEM,
  PACK,
  SUBJECT,
  accessAt,
  decided,
  gateCard,
  gateContext,
  packSummary,
  prepared,
} from './verifyFixtures';

// P1-3, P1-7, P1-8 (portal review §12): the G4 merge review, the G5 release, the G6 acceptance, X1 and G3o on the
// decide screen. What each decides is the gate context's `subject` (core's, cut by the bff); every decision is still
// prepare, evidence, decide with a reason through the same routes, and nothing is sent without a press.

const CARD_PATH = `/api/cards/${CARD}`;
const pr = {
  repo: 'acme/web',
  number: 12,
  head_ref: 'agent/x/main',
  state: 'open',
  url: 'https://github.com/acme/web/pull/12',
};
const steps = [
  { step: '7.1', check: 'deterministic', status: 'passed' },
  { step: '7.2', check: 'test_integrity', status: 'passed' },
  { step: '7.3', check: 'spec_conformance', status: 'passed' },
  { step: '7.4', check: 'secrets_dependencies', status: 'raised' },
  { step: '7.5', check: 'constitution', status: 'passed' },
];

const g4 = (b13 = { used: 0, limit: 2, left: 2, exhausted_to: 'D3' }) => ({
  kind: 'merge_review',
  review: {
    schema: 'g4-review/1',
    mode: 'C',
    reasons: ['sensitive_path'],
    units: [{ unit_key: 'main', pr_number: 12, head_sha: HEAD, base_sha: BASE, pack_sha256: PACK }],
    evidence_sha256: PACK,
    changed_paths: { count: 3, sha256: 'f'.repeat(64) },
    sensitive_paths: ['AGENTS.md', 'db/migrations/0002.sql'],
    step_up: true,
    deciders: { basis: 'path_owners', principals: ['alice'] },
    codeowners: { read: 'ok', at_sha: BASE, unmapped: ['@acme/dba'] },
    authors: [],
  },
  units: [
    {
      unit_key: 'main',
      head_sha: HEAD,
      base_sha: BASE,
      pack_sha256: PACK,
      pr,
      pack: packSummary(),
      steps,
      paths: [
        { path: 'AGENTS.md', sensitive: true, protected: true },
        { path: 'db/migrations/0002.sql', sensitive: true, protected: false },
        { path: 'src/app.ts', sensitive: false, protected: false },
      ],
      paths_truncated: false,
    },
  ],
  standing: 'pending',
  b13,
});

const g5 = (over: Record<string, unknown> = {}) => ({
  kind: 'release',
  binding: {
    status: 'bound',
    item_id: ITEM,
    project_id: 'testbed',
    repo: 'acme/web',
    pr_number: 12,
    unit_key: 'main',
    merged_sha: '1'.repeat(40),
    pack_sha256: PACK,
    pack_head_sha: HEAD,
    environment: 'production',
  },
  target_now: { state: 'ok', setting: { mode: 'target', environment: 'production' } },
  target_changed: false,
  pr,
  pack: packSummary(),
  steps,
  deployment: { state: 'none', refusal: null, marker: null, rollback_marker_id: null },
  ...over,
});

const g6 = (intent: Record<string, unknown> = {}) => ({
  kind: 'acceptance',
  acceptance: { requester: 'alice', merged_sha: '1'.repeat(40), release_output: null },
  intent: {
    sha256: 'e'.repeat(64),
    bound_by: 'gate:g-G1',
    intact: true,
    goal: 'Admins can export orders',
    acceptance_criteria: ['An admin can download a CSV', 'One row per order'],
    non_goals: ['No PDF'],
    withheld: false,
    ...intent,
  },
  merged: [{ unit_key: 'main', pr, head_sha: HEAD, pack: packSummary(), steps }],
  release: null,
});

const x1 = (command: string | null = 'git push --force origin main', withheld = false) => ({
  kind: 'irreversible_operation',
  reason_code: 'irreversible_operation',
  operation: {
    kind: 'irreversible_operation',
    source: 'tripwire',
    what: 'a force push',
    command,
    target: null,
    agent_note: null,
  },
  command_withheld: withheld,
});

const g3o = (known = true) => ({
  kind: 'oracle_deviation',
  reason_code: 'oracle_deviation',
  chained_from: null,
  approved: {
    gate_instance_id: 'g-G2',
    sha256: '6'.repeat(64),
    intact: true,
    oracles: [
      {
        oracle_id: 'O1',
        requirement_id: 'R1',
        spec_sha256: '1'.repeat(64),
        description: 'add adds',
        expected_failure: 'add(2,2) is 5',
      },
      {
        oracle_id: 'O2',
        requirement_id: 'R2',
        spec_sha256: '2'.repeat(64),
        description: 'mul multiplies',
        expected_failure: 'mul(2,3) is 5',
      },
    ],
  },
  diff: known
    ? [
        { oracle_id: 'O1', path: null, status: 'as_approved' },
        { oracle_id: 'O2', path: 'test/mul.test.js', status: 'spec_mismatch' },
        { oracle_id: null, path: 'test/extra.test.js', status: 'no_marker' },
      ]
    : [
        { oracle_id: 'O1', path: null, status: 'unknown' },
        { oracle_id: 'O2', path: null, status: 'unknown' },
      ],
  deviations_known: known,
  text_withheld: false,
});

const SLOT: Record<string, string> = {
  G4: 'g4',
  G5: 'g5',
  G6: 'requesters',
  X1: 'x',
  G3o: 'design',
};

const routes = (
  gate: string,
  subject: unknown,
  o: { ctx?: Record<string, unknown>; card?: Record<string, unknown>; stepUp?: boolean } = {},
) => ({
  'GET /api/me': { json: me() },
  'GET /api/me/access': { json: accessAt('V2') },
  [`GET ${CARD_PATH}`]: { status: 404, json: { error: { code: 'not_found', message: 'no' } } },
  [`GET ${CARD_PATH}/gate`]: {
    json: gateCard(gate, {
      gates: [
        {
          gate_instance_id: `g-${gate}`,
          gate,
          slot: SLOT[gate],
          status: 'pending',
          outcome: null,
          step_up_required: o.stepUp ?? false,
        },
      ],
      deciders: { slots: [SLOT[gate]], holders: ['alice', 'bob'] },
      ...o.card,
    }),
  },
  [`GET ${CARD_PATH}/gate/context`]: {
    json: gateContext(gate, {
      subject,
      ...(['G4', 'G5', 'G6'].includes(gate) ? { station: gate, step: null } : {}),
      ...(o.stepUp ? { step_up: { required: true, bound_hash: SUBJECT } } : {}),
      ...o.ctx,
    }),
  },
  [`POST ${CARD_PATH}/gate/prepare`]: { json: prepared(gate, o.stepUp ?? false) },
  [`POST ${CARD_PATH}/gate/evidence`]: { json: { evidence_viewed: true } },
  [`POST ${CARD_PATH}/gate/decide`]: (c: Call) => ({
    json: decided(gate, (c.body as { decision: string }).decision),
  }),
  'POST /api/step-up': {
    json: { status: 'ready', method: 'reconfirm', proof: 'proof-1', bound_hash: SUBJECT },
  },
});

const decideCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/gate/decide'));

async function readyToDecide() {
  await waitFor(() =>
    expect(screen.queryByText(/Getting the decision form ready/)).not.toBeInTheDocument(),
  );
}

describe('G4 merge review (P1-3)', () => {
  it('shows the pack, the PR link, the diff by path flagged, the mode and B13’s rounds left; step-up then decide', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes('G4', g4(), { stepUp: true }));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Merge review' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('review-mode')).toHaveTextContent('mode C');
    expect(screen.getByTestId('review-mode')).toHaveTextContent(/sensitive_path/);
    expect(screen.getByTestId('review-mode')).toHaveTextContent(
      /0 of 2 rounds used · 2 left, then D3/,
    );
    const link = screen.getAllByTestId('pr-link')[0] as HTMLElement;
    expect(link).toHaveAttribute('href', 'https://github.com/acme/web/pull/12');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const unit = screen.getByTestId('unit-main');
    expect(within(unit).getByText('passing')).toBeInTheDocument();
    const table = within(unit).getByRole('table', { name: /Changed paths/ });
    const agents = within(table)
      .getByRole('rowheader', { name: 'AGENTS.md' })
      .closest('tr') as HTMLElement;
    expect(within(agents).getByText('protected')).toBeInTheDocument();
    expect(within(agents).getByText('sensitive')).toBeInTheDocument();
    const app = within(table)
      .getByRole('rowheader', { name: 'src/app.ts' })
      .closest('tr') as HTMLElement;
    expect(within(app).queryByText('protected')).toBeNull();
    expect(screen.getByTestId('sensitive-banner')).toHaveTextContent(
      '2 sensitive or protected paths',
    );
    await readyToDecide();
    expect(
      screen.getByRole('button', { name: 'Request changes (B13: 2 of 2 left)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm my identity' }));
    expect(await screen.findByTestId('stepup-ready')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.type(screen.getByLabelText(/Reason/), 'Read the migration and the pack.');
    await user.click(screen.getByRole('button', { name: 'Approve the merge' }));
    expect(await screen.findByTestId('receipt')).toHaveTextContent('#42');
    expect(decideCalls(m.calls)[0]?.body).toEqual({
      decision: 'approve',
      reason: 'Read the migration and the pack.',
      votes: [{ nonce: 'nonce-G4', step_up: { proof: 'proof-1' } }],
    });
  });

  it('no B13 round left: the button says where changes go; paths not in the record read unknown', async () => {
    const s = g4({ used: 2, limit: 2, left: 0, exhausted_to: 'D3' });
    const unit = { ...(s.units[0] as object), paths: null };
    mockApi(routes('G4', { ...s, units: [unit] }));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('paths-unknown')).toHaveTextContent('[unknown]');
    await readyToDecide();
    expect(
      screen.getByRole('button', { name: 'Request changes (no B13 round left: D3)' }),
    ).toBeInTheDocument();
  });

  it('a G4 whose subject facts are missing says so and is not decided blind', async () => {
    mockApi(routes('G4', null));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('subject-missing')).toHaveTextContent('Do not decide');
  });
});

describe('G5 release and G6 acceptance (P1-7)', () => {
  it('G5: the target, the release evidence, gate-relay’s state; only approve or deny', async () => {
    mockApi(routes('G5', g5(), { stepUp: true }));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Release' })).toBeInTheDocument();
    expect(screen.getByTestId('release-binding')).toHaveTextContent('production');
    expect(screen.getByTestId('release-evidence')).toHaveTextContent('passing');
    expect(screen.getByTestId('deployment-state')).toHaveTextContent('none');
    await readyToDecide();
    expect(screen.getByRole('button', { name: 'Confirm my identity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny (release held)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('G5: an unbound card and a moved target are said plainly', async () => {
    mockApi(
      routes(
        'G5',
        g5({
          binding: {
            status: 'unbound',
            item_id: ITEM,
            project_id: 'testbed',
            repo: 'acme/web',
            reason: 'pack_head_not_pr_head',
          },
          target_changed: false,
          pr: null,
          pack: null,
          steps: [],
          deployment: {
            state: 'refused',
            refusal: 'unbound',
            marker: null,
            rollback_marker_id: null,
          },
        }),
      ),
    );
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('unbound')).toHaveTextContent('pack_head_not_pr_head');
    expect(screen.getByTestId('pack-missing')).toBeInTheDocument();
    expect(screen.getByTestId('deployment')).toHaveTextContent('refused by gate-relay');
  });

  it('G6: the requester sees the intent and its criteria against what merged, and accepts', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes('G6', g6(), { ctx: { requester: 'alice' } }));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Acceptance' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('criteria')).toHaveTextContent('An admin can download a CSV');
    expect(screen.getByTestId('merged')).toHaveTextContent('acme/web#12');
    expect(screen.getByText(/G6 is your own acceptance/)).toBeInTheDocument();
    await readyToDecide();
    expect(screen.getByRole('button', { name: 'Reject (B18)' })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.type(screen.getByLabelText(/Reason/), 'It does what I asked.');
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({ decision: 'approve' });
  });

  it('G6 below D1: the intent text is withheld, the hashes stay', async () => {
    mockApi(
      routes('G6', g6({ goal: null, acceptance_criteria: [], non_goals: [], withheld: true })),
    );
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('intent')).toHaveTextContent('needs data class D1');
    expect(screen.queryByTestId('criteria')).toBeNull();
  });
});

describe('X1 and G3o in S6 (P1-8)', () => {
  it('X1: the command and its target, two people; deny is D1', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes('X1', x1(), { ctx: { quorum_required: 2 } }));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Irreversible operation' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('x1-command')).toHaveTextContent('git push --force origin main');
    expect(screen.getByTestId('operation')).toHaveTextContent(/Target\s*\[unknown\]/);
    expect(screen.getByTestId('two-person')).toHaveTextContent('0 of 2 approvals');
    await readyToDecide();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.type(screen.getByLabelText(/Reason/), 'Not on main.');
    await user.click(screen.getByRole('button', { name: 'Deny (D1)' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({ decision: 'reject' });
  });

  it('X1 below D2: the command is withheld', async () => {
    mockApi(routes('X1', x1(null, true)));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('operation')).toHaveTextContent(
      'withheld: the command needs data class D2',
    );
    expect(screen.queryByTestId('x1-command')).toBeNull();
  });

  it('G3o: the oracle diff against the G2-approved specs; at 6.3 a denial asks for an alternative', async () => {
    mockApi(routes('G3o', g3o()));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Oracle deviation' }),
    ).toBeInTheDocument();
    const t = screen.getByRole('table', { name: 'Oracles against the approved specs' });
    const o2 = within(t).getByRole('rowheader', { name: 'O2' }).closest('tr') as HTMLElement;
    expect(o2).toHaveTextContent('mul multiplies');
    expect(o2).toHaveTextContent('implements another version of the spec');
    expect(within(t).getByText('test/extra.test.js')).toBeInTheDocument();
    expect(screen.getByTestId('oracle-diff')).toHaveTextContent('approved at G2');
    await readyToDecide();
    expect(
      screen.getByRole('button', { name: 'Deny (find an alternative, 1×)' }),
    ).toBeInTheDocument();
  });

  it('G3o with no reported deviations: each oracle reads unknown, never as approved', async () => {
    mockApi(routes('G3o', g3o(false)));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('oracle-diff')).toHaveTextContent(/were not reported/);
    expect(screen.queryByText('as approved')).toBeNull();
  });
});
