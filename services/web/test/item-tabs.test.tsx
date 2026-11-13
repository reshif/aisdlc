import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { SHA_A, SHA_B, T, agentRow, evalRun } from './screenFixtures';
import { ITEM, accessAt, itemView } from './verifyFixtures';

// P2-1, P2-3, P2-16, P3-5: the item page's tabs (Request, Intent, Documents, Timeline, Agent runs), the clarifying
// round where the questions are answered, the PR link and head, and the agent page. A tab reads only when it is
// opened; the intent and the documents are offered from view level V2; withheld text says so and keeps the hash.

const PATH = `/api/items/${ITEM}`;
const RUN = '0193a1b2-0000-7000-8000-0000000000a1';

const requestView = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'reshif/asf-factory-testbed',
  request_id: ITEM,
  requester: 'carol',
  channel: 'N1',
  request_text: {
    text: 'Export the orders as CSV',
    taint: 'untrusted',
    origin: 'request',
    provenance: {
      channel: 'N1',
      source: null,
      received_at: T,
      submitted_by: 'carol',
      raw_sha256: SHA_A,
      normalised_sha256: SHA_A,
    },
    flags: [],
  },
  text_withheld: false,
  text_sha256: SHA_A,
  injection: { suspected: false, rules: [], lines: [], text_sha256: SHA_A },
  dedupe_links: [],
  conflict_candidates: [],
  asked_lane: 'L5',
  proposed_lane: 'L8',
  lane: null,
  lane_bound_by: null,
  intake_route: 'l8',
  eligibility_reason: 'level_too_low',
  lane_opens_at: 'full',
  data_class: 'D1',
  ...over,
});

const version = (n: number, markdown: string | null, gates: unknown[] = []) => ({
  version: n,
  sha256: n === 1 ? SHA_A : SHA_B,
  step: '3.2',
  stored_at: T,
  bytes: 20,
  author: n === 1 ? { kind: 'agent', agent_id: 'A3', run_id: RUN } : { kind: 'factory' },
  markdown,
  withheld: markdown === null,
  gates,
});
const g2 = {
  gate: 'G2',
  gate_instance_id: 'g-2',
  subject_hash: SHA_B,
  status: 'decided',
  outcome: 'approve',
  approvers: ['bob'],
  ended_at: T,
  card_id: '55555555-6666-4777-8888-999999999999',
  ledger_entry_id: '0193a1b2-0000-7000-8000-0000000000ff',
};
const documentsView = (text = true) => ({
  item_id: ITEM,
  project_id: 'testbed',
  documents: [
    {
      type: 'intent_block',
      group: 'intent',
      versions: [
        {
          ...version(1, text ? '# Intent\nAdmins export orders' : null, [
            { ...g2, gate: 'G0', gate_instance_id: 'g-0' },
            { ...g2, gate: 'G1', gate_instance_id: 'g-1' },
          ]),
          step: '1.5',
        },
      ],
    },
    {
      type: 'spec_delta',
      group: 'spec',
      versions: [
        version(1, text ? '# Spec\nREQ-1 export\nREQ-2 filter' : null, [g2]),
        version(2, text ? '# Spec\nREQ-1 export as CSV\nREQ-2 filter' : null),
      ],
    },
  ],
  not_intact: 0,
  data_class: text ? 'D1' : 'D0',
});
const timelineView = () => ({
  item_id: ITEM,
  project_id: 'testbed',
  entries: [
    {
      global_seq: 1,
      at: T,
      kind: 'item.created',
      actor: 'system.work',
      by: null,
      step: null,
      gates: [],
      codes: [],
    },
    {
      global_seq: 9,
      at: T,
      kind: 'item.gate_decided',
      actor: 'system.work',
      by: null,
      step: null,
      gates: ['G2'],
      codes: ['outcome:approve'],
    },
  ],
});
const run = (over: Record<string, unknown> = {}) => ({
  run_id: RUN,
  item_id: ITEM,
  project_id: 'testbed',
  unit_id: null,
  step: '3.2',
  attempt: 1,
  lane: 'L4',
  agent_id: 'A3',
  contract_version: '1.0.0',
  prompt_ref: 'a3_plan@1.0.0',
  prompt_sha256: SHA_A,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  vkey_id: 'vk-1',
  calls: 2,
  tokens_in: 1000,
  tokens_out: 200,
  cost_micro_usd: 12_500,
  state: 'finished',
  result: 'completed',
  failure_code: null,
  started_at: T,
  ended_at: T,
  outcome: { run_id: RUN, verdict: 'accepted', judgements: [], back_edges: [], triggers: [] },
  ...over,
});

const routes = (over: Record<string, unknown> = {}, level: 'V1' | 'V2' = 'V2') => ({
  'GET /api/me': { json: me() },
  'GET /api/me/access': { json: accessAt(level) },
  [`GET ${PATH}`]: { json: itemView({ phase: 'S4', waiting: null }) },
  ...over,
});

async function open(tab: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
}

describe('the Request tab', () => {
  it('shows the text as kept, the taint mark, and the lane with why intake routed it (P2-17)', async () => {
    const m = mockApi(routes({ [`GET ${PATH}/request`]: { json: requestView() } }));
    renderAt(`/items/${ITEM}`);
    await screen.findByRole('tab', { name: 'Request' });
    // nothing is read before the tab is opened
    expect(m.calls.map((c) => c.path)).not.toContain(`${PATH}/request`);
    await open('Request');
    expect(await screen.findByTestId('request-text')).toHaveTextContent('Export the orders as CSV');
    expect(screen.getByTestId('request-text')).toHaveTextContent('untrusted');
    const lane = screen.getByTestId('request-lane');
    expect(lane).toHaveTextContent('not eligible');
    expect(lane).toHaveTextContent('level does not open the lane');
    expect(lane).toHaveTextContent('routed to L8');
    expect(lane).toHaveTextContent('L5 opens at');
    expect(screen.getByTestId('request-injection')).toHaveTextContent('none');
    expect(screen.getByTestId('request-dedupe')).toHaveTextContent('No earlier item');
  });

  it('says the text is withheld below D1 and shows its hash', async () => {
    mockApi(
      routes(
        {
          [`GET ${PATH}/request`]: {
            json: requestView({ request_text: null, text_withheld: true, data_class: 'D0' }),
          },
        },
        'V1',
      ),
    );
    renderAt(`/items/${ITEM}`);
    await open('Request');
    const t = await screen.findByTestId('request-text');
    expect(t).toHaveTextContent('needs data class D1');
    expect(t).toHaveTextContent(SHA_A.slice(0, 12));
    expect(t).not.toHaveTextContent('Export the orders');
  });
});

describe('the Documents and Intent tabs', () => {
  it('lists each document with its versions, who wrote them, the gate that approved a version, and a diff', async () => {
    mockApi(
      routes({
        [`GET ${PATH}/documents`]: { json: documentsView() },
        [`GET ${PATH}/evidence`]: { json: { item_id: ITEM, project_id: 'testbed', packs: [] } },
      }),
    );
    renderAt(`/items/${ITEM}`);
    const user = await open('Documents');
    const spec = await screen.findByTestId('doc-spec_delta');
    const rows = within(spec).getAllByTestId('doc-version');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('v1');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'agent A3' })).toHaveAttribute(
      'href',
      '/agents/A3',
    );
    expect(rows[0]).toHaveTextContent('approve by bob');
    expect(rows[1]).toHaveTextContent('no gate');
    expect(rows[1]).toHaveTextContent('the factory');
    // the newest version is shown; comparing with v1 shows the changed line
    expect(within(spec).getByLabelText('spec delta version 2')).toHaveTextContent('export as CSV');
    await user.selectOptions(within(spec).getByLabelText('Compare with'), '1');
    expect(within(spec).getByTestId('doc-diff-summary')).toHaveTextContent(
      'Version 1 to 2: 1 line added, 1 removed.',
    );
    const diff = within(spec).getByLabelText('Changes from version 1');
    expect(diff.querySelector('[data-op="del"]')).toHaveTextContent('REQ-1 export');
    expect(diff.querySelector('[data-op="add"]')).toHaveTextContent('REQ-1 export as CSV');
    expect(screen.getByTestId('docs-evidence')).toHaveTextContent('No Evidence Pack is signed yet');
  });

  it('withholds the text below D1 and keeps the hashes; the Intent tab says which gates approved', async () => {
    mockApi(routes({ [`GET ${PATH}/documents`]: { json: documentsView(false) } }));
    renderAt(`/items/${ITEM}`);
    await open('Intent');
    expect(await screen.findByTestId('intent-status')).toHaveTextContent(
      'The intent block version 1 was approved (G0, G1).',
    );
    const card = screen.getByTestId('doc-intent_block');
    expect(within(card).getByTestId('doc-withheld')).toHaveTextContent('needs data class D1');
    expect(card).toHaveTextContent(SHA_A.slice(0, 12));
  });

  it('offers neither below V2', async () => {
    mockApi(routes({}, 'V1'));
    renderAt(`/items/${ITEM}`);
    await screen.findByRole('tab', { name: 'Request' });
    await waitFor(() => expect(screen.getByTestId('verify-hidden')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Documents' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Intent' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Timeline' })).toBeInTheDocument();
  });
});

describe('the Timeline and Agent runs tabs', () => {
  it('folds the record to plain steps with who and when', async () => {
    mockApi(routes({ [`GET ${PATH}/timeline`]: { json: timelineView() } }));
    renderAt(`/items/${ITEM}`);
    await open('Timeline');
    const tl = await screen.findByRole('list', { name: 'What happened to the item' });
    expect(tl).toHaveTextContent('The work item was made from the request');
    expect(tl).toHaveTextContent('A gate was decided: G2');
    expect(tl).toHaveTextContent('outcome approve');
  });

  it('lists each run with agent, step, state, verdict, cost and prompt sha', async () => {
    mockApi(
      routes({
        [`GET /api/agent-runs?item=${ITEM}`]: {
          json: { item_id: ITEM, project_id: 'testbed', runs: [run()] },
        },
      }),
    );
    renderAt(`/items/${ITEM}`);
    await open('Agent runs');
    const t = await screen.findByTestId('agent-runs-tab');
    expect(within(t).getByRole('link', { name: 'A3' })).toHaveAttribute('href', '/agents/A3');
    expect(t).toHaveTextContent('3.2');
    expect(t).toHaveTextContent('finished');
    expect(t).toHaveTextContent('accepted');
    expect(t).toHaveTextContent('$0.01');
    expect(t).toHaveTextContent(SHA_A.slice(0, 12));
  });
});

describe('the clarifying round (P2-16) and the PR (P3-5) on the item', () => {
  it('says the round of the limit and the date the item parks on', async () => {
    mockApi(
      routes({
        [`GET ${PATH}`]: {
          json: itemView({
            phase: 'Clarifying',
            waiting: 'questions:q-1',
            questions: [
              {
                question_id: 'q-1',
                item_id: ITEM,
                stage: 'S1',
                step: '1.5',
                round: 1,
                material: 'blocking',
                text: 'Which table?',
                state: 'open',
                asked_at: T,
                answered_at: null,
                answered: false,
                answer_flagged: false,
              },
            ],
            clarify: {
              round: 1,
              rounds_max: 2,
              open: 1,
              since: T,
              deadline: '2026-11-19T10:00:00.000Z',
              then: 'parks',
            },
          }),
        },
      }),
    );
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('clarify-round')).toHaveTextContent(
      'Round 1 of 2. If nobody answers, the item parks on 2026-11-19 10:00 UTC.',
    );
  });

  it('links the pull request and shows its head at S8a', async () => {
    mockApi(
      routes({
        [`GET ${PATH}`]: {
          json: itemView({
            phase: 'S8',
            waiting: 'gates:G4',
            pull_requests: [
              {
                repo: 'reshif/asf-factory-testbed',
                number: 12,
                unit_key: 'main',
                head_ref: `agent/${ITEM}/main`,
                head_sha: 'c'.repeat(40),
                state: 'open',
                draft: false,
                url: 'https://github.com/reshif/asf-factory-testbed/pull/12',
              },
            ],
          }),
        },
        [`GET ${PATH}/verify`]: { status: 404, json: { error: { code: 'not_found' } } },
        [`GET ${PATH}/gate-check`]: { status: 404, json: { error: { code: 'not_found' } } },
      }),
    );
    renderAt(`/items/${ITEM}`);
    const prs = await screen.findByTestId('item-prs');
    expect(within(prs).getByRole('link', { name: '#12' })).toHaveAttribute(
      'href',
      'https://github.com/reshif/asf-factory-testbed/pull/12',
    );
    expect(prs).toHaveTextContent('open');
    expect(prs).toHaveTextContent('c'.repeat(12));
  });
});

describe('the agent page (P2-3)', () => {
  const agentRoutes = () => ({
    'GET /api/me': { json: me(['quality.read']) },
    'GET /api/agents/A3': {
      json: {
        agent: agentRow({ agent_id: 'A3', name: 'planner', steps: ['3.2'] }),
        input_schema_id: 'a3_input.v1',
        input_schema: { type: 'object', properties: { item_id: { type: 'string' } } },
        output_schema: { oneOf: [{ type: 'object' }] },
        lock_format: 'aisdlc-prompts-lock/v1',
      },
    },
    'GET /api/agents/A3/stats': {
      json: {
        agent_id: 'A3',
        project_id: null,
        runs: 10,
        finished: 9,
        failed: 1,
        judged: 8,
        accepted: 6,
        rejected: 0,
        sent_back: 2,
        reworked: 0,
        handed_off: 0,
        with_back_edge: 2,
        acceptance_rate: 0.75,
        back_edge_rate: 2 / 9,
        calls: 20,
        tokens_in: 1,
        tokens_out: 1,
        cost_micro_usd: 90_000,
        cost_per_run_micro_usd: 9_000,
      },
    },
    'GET /api/agents/A3/scores': {
      json: {
        agent_id: 'A3',
        scores: [
          {
            score_id: 's-1',
            agent_id: 'A3',
            prompt_sha256: SHA_A,
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            eval_runs: 2,
            eval_trials: 12,
            pass_rate: 11 / 12,
            pass_k: 0.75,
            cost_per_pass_micro_usd: null,
            status: 'pass',
            last_eval_at: T,
            production_runs: 10,
            production_judged: 8,
            accept_rate: 0.75,
            sent_back_rate: 0.25,
            rework_rate: 0,
          },
        ],
      },
    },
    'GET /api/evals/runs?agent=A3&limit=50': {
      json: {
        runs: [
          evalRun({
            agent_id: 'A3',
            ended_at: '2026-11-12T11:00:00.000Z',
            pass_rate: 1,
            passes: 12,
          }),
          evalRun({
            eval_run_id: '0193a1b2-0000-7000-8000-0000000000e2',
            agent_id: 'A3',
            prompt_sha256: SHA_B,
          }),
        ],
      },
    },
    'GET /api/agents/A3/runs?limit=50': { json: { agent_id: 'A3', runs: [run()], total: 10 } },
  });

  it('shows the contract and schemas, production outcomes, pass^k, scores over time and recent runs', async () => {
    mockApi(agentRoutes());
    renderAt('/agents/A3');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A3 planner' }),
    ).toBeInTheDocument();
    const c = screen.getByTestId('agent-contract');
    expect(c).toHaveTextContent('a3_input.v1');
    expect(c).toHaveTextContent(SHA_A.slice(0, 12));
    expect(screen.getByTestId('agent-input-schema')).toHaveTextContent('"item_id"');
    expect(await screen.findByRole('list', { name: 'Production outcomes' })).toHaveTextContent(
      '75%',
    );
    const scores = await screen.findByTestId('agent-scores');
    expect(scores).toHaveTextContent('current');
    expect(scores).toHaveTextContent('75%');
    const hist = await screen.findByTestId('agent-eval-history');
    const rates = within(hist).getAllByTestId('eval-rate');
    // oldest first: the other prompt's run, then the newer one at 100%
    expect(rates[0]).toHaveTextContent('92%');
    expect(rates[1]).toHaveTextContent('100%');
    expect(hist).toHaveTextContent('other prompt');
    const recent = await screen.findByTestId('agent-recent-runs');
    expect(recent).toHaveTextContent('Recent runs (1 of 10)');
    expect(within(recent).getByRole('link', { name: `item ${ITEM.slice(0, 8)}` })).toHaveAttribute(
      'href',
      `/items/${ITEM}`,
    );
  });

  it('is the 403 page without quality.read, before any read', async () => {
    const m = mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/agents/A3');
    await waitFor(() => expect(screen.getByText(/See my access/)).toBeInTheDocument());
    expect(m.calls.map((c) => c.path)).not.toContain('/api/agents/A3');
  });
});
