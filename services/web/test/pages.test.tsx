import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_ROLE_MAP } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { validateAgainst } from '../src/lib/schema';
import { ENTRY_HASH, RECORD_HASH } from './cardFixtures';
import { CARD_ID, NOW, S0_ID, me, mockApi, renderAt } from './helpers';

const GATE = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77';

const revision = (over: Record<string, unknown> = {}) => ({
  gate_instance_id: GATE,
  project_id: 'testbed',
  s0_id: S0_ID,
  rev_hash: 'c'.repeat(64),
  proposed_by: 'alice',
  status: 'pending',
  outcome: null,
  published: false,
  settings: {
    role_map: {
      ...EMPTY_ROLE_MAP,
      admin: { kind: 'principals', principals: ['alice'] },
      m4: { kind: 'principals', principals: ['alice', 'bob'] },
      g4: { kind: 'codeowners' },
    },
    two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
    gating_profile: {
      gates: { g0g1: 'on', g2: 'on', g3d: 'off', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: false,
    },
    kill_delegations: [],
  },
  evidence_hash: 'd'.repeat(64),
  deciders: {
    slot: 'admin',
    holders: ['alice'],
    single_operator: true,
    sod_waiver: true,
    tier: 'T0',
    t2: false,
    can_decide: true,
    error: null,
  },
  may_decide: true,
  principal_names: { alice: 'Alice Admin' },
  ...over,
});

describe('the settings revision (card 4 proposed it)', () => {
  const routes = (rev = revision(), extra: Record<string, unknown> = {}) => ({
    'GET /api/me': { json: me() },
    [`GET /api/revisions/${GATE}`]: { json: rev },
    [`POST /api/revisions/${GATE}/prepare`]: {
      json: { nonce: 'rn', expires_at: NOW, evidence_hash: rev.evidence_hash },
    },
    [`POST /api/revisions/${GATE}/evidence`]: { json: { evidence_viewed: true } },
    ...extra,
  });

  it('shows the pending role map and decides it: prepare, evidence, decide, receipt, published', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes(revision(), {
        [`POST /api/revisions/${GATE}/decide`]: {
          json: {
            entry: { ledger_seq: 12, entry_hash: ENTRY_HASH, decision: 'approve' },
            outcome: 'approve',
            published: true,
            publish_error: null,
          },
        },
      }),
    );
    renderAt(`/revisions/${GATE}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Settings revision pending' }),
    ).toBeInTheDocument();
    const roles = screen.getByRole('table', { name: 'Role map' });
    expect(within(roles).getAllByRole('row')).toHaveLength(11); // header and the ten slots
    expect(roles.querySelector('[data-slot="m4"]')).toHaveTextContent('alice, bob');
    expect(roles.querySelector('[data-slot="g4"]')).toHaveTextContent('the code owners on GitHub');
    const approve = await screen.findByRole('button', {
      name: 'Approve and publish these settings',
    });
    await waitFor(() => expect(approve).toBeEnabled());
    expect(m.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/api/revisions/${GATE}/prepare`,
      `/api/revisions/${GATE}/evidence`,
    ]);
    await user.click(approve);
    const box = await screen.findByTestId('receipt');
    expect(box).toHaveTextContent('#12');
    expect(box).toHaveTextContent('published');
    expect(m.calls.find((c) => c.path === `/api/revisions/${GATE}/decide`)?.body).toEqual({
      nonce: 'rn',
      decision: 'approve',
    });
  });

  it('an approval whose publish failed offers the publish again', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes(revision(), {
        [`POST /api/revisions/${GATE}/decide`]: {
          json: {
            entry: { ledger_seq: 12, entry_hash: ENTRY_HASH, decision: 'approve' },
            outcome: 'approve',
            published: false,
            publish_error: 'the ledger is busy',
          },
        },
        [`POST /api/revisions/${GATE}/publish`]: { json: { published: true } },
      }),
    );
    renderAt(`/revisions/${GATE}`);
    const approve = await screen.findByRole('button', {
      name: 'Approve and publish these settings',
    });
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);
    expect(await screen.findByText('the ledger is busy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish the approved revision' }));
    await waitFor(() => expect(screen.getByTestId('receipt')).toHaveTextContent('is published'));
    expect(m.calls.some((c) => c.path === `/api/revisions/${GATE}/publish`)).toBe(true);
  });

  it('someone who may not decide it can read it, and nothing is prepared', async () => {
    const m = mockApi(routes(revision({ may_decide: false })));
    renderAt(`/revisions/${GATE}`);
    expect(await screen.findByTestId('not-decidable')).toHaveTextContent(
      'look at this revision but not decide',
    );
    expect(m.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a published revision says it is in force', async () => {
    mockApi(
      routes(
        revision({ status: 'decided', outcome: 'approve', published: true, may_decide: false }),
      ),
    );
    renderAt(`/revisions/${GATE}`);
    expect(await screen.findByText('Published: this role map is in force.')).toBeInTheDocument();
  });
});

describe('the readiness record page', () => {
  const record = () => ({
    schema: 'prr/1',
    record_id: 'prr:testbed:reshif.asf',
    version: 1,
    supersedes: null,
    status: 'active',
    level: { requested: 'census', signed: 'census' },
    tier: { value: 'T0', floor: 'T0' },
    pillars: [
      { pillar: 'VRL', level: 2 },
      { pillar: 'ERL', level: 1 },
    ],
    composite: 1,
    autonomy: {
      tier_cap: 'A3',
      level_cap: 'A1',
      readiness_cap: 'A2',
      posture_cap: 'A2',
      probation_until: null,
      effective: 'A1',
      lanes_eligible: ['L2', 'L8'],
      r3_zones: [],
    },
    gaps: [
      { gap_id: 'gap:x:RS-AI-1', severity: 'tracked', disposition: 'track_only', status: 'open' },
      { gap_id: 'gap:x:RS-TH-1', severity: 'blocking', disposition: 'file_issue', status: 'open' },
    ],
    issued_at: NOW,
    fresh_until: '2027-02-06T10:00:00.000Z',
    review_by: null,
    record_hash: RECORD_HASH,
  });
  const view = (over: Record<string, unknown> = {}) => ({
    version: 1,
    status: 'active',
    effective_status: 'active',
    s0_id: S0_ID,
    proposed_at: NOW,
    activated_at: NOW,
    record: record(),
    ...over,
  });

  it('status, level, tier, pillars with composite, caps and what binds, lanes, gaps, dates and hash', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed/prr': {
        json: {
          project_id: 'testbed',
          repos: [{ repo: 'reshif/asf-factory-testbed', governing: view(), proposed: null }],
        },
      },
    });
    renderAt('/projects/testbed/readiness');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Readiness record of testbed' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('prr-level')).toHaveTextContent('census');
    expect(screen.getByTestId('prr-tier')).toHaveTextContent('T0 (floor T0)');
    expect(screen.getByTestId('prr-composite')).toHaveTextContent('1');
    expect(screen.getByTestId('prr-effective')).toHaveTextContent('A1');
    expect(screen.getByTestId('prr-lanes')).toHaveTextContent('L2, L8');
    // a record before the per-area table: one repo-wide area at the signed level
    const areas = screen.getByRole('table', {
      name: 'Per-area levels of reshif/asf-factory-testbed',
    });
    expect(areas).toHaveTextContent('the whole repository');
    expect(areas).toHaveTextContent('judged for the whole repository');
    expect(screen.getByText(/Binding: level/)).toBeInTheDocument();
    expect(screen.getByText(RECORD_HASH)).toBeInTheDocument();
    expect(screen.getByText('2027-02-06 10:00 UTC')).toBeInTheDocument();
    expect(screen.getByText('no review date at this level')).toBeInTheDocument();
    expect(screen.getByText(/2 gaps: 2 open, 1 blocking, 0 waived/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ledger entries of this project/ })).toHaveAttribute(
      'href',
      '/projects/testbed/ledger',
    );
  });

  it('an expired record reads expired, and says why', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed/prr': {
        json: {
          project_id: 'testbed',
          repos: [
            { repo: 'a/b', governing: view({ effective_status: 'expired' }), proposed: null },
          ],
        },
      },
    });
    renderAt('/projects/testbed/readiness');
    expect(
      await screen.findByText(/Recorded as active; it has passed its fresh-until date/),
    ).toBeInTheDocument();
    expect(document.querySelector('.prr')).toHaveAttribute('data-status', 'expired');
  });

  it('no record yet: says new work waits; a proposed one links to its onboarding', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed/prr': {
        json: {
          project_id: 'testbed',
          repos: [
            {
              repo: 'a/b',
              governing: null,
              proposed: { version: 1, record_hash: RECORD_HASH, s0_id: S0_ID, proposed_at: NOW },
            },
          ],
        },
      },
    });
    renderAt('/projects/testbed/readiness');
    expect(await screen.findByTestId('prr-none')).toHaveTextContent('new work for it waits');
    expect(screen.getByRole('link', { name: 'Open the onboarding' })).toHaveAttribute(
      'href',
      `/s0/${S0_ID}`,
    );
  });
});

describe('the ledger page', () => {
  const entry = (n: number, over: Record<string, unknown> = {}) => ({
    ledger_seq: n,
    entry_id: `01a1bc26-f0e5-719a-a52b-a88a4b6cb${n.toString().padStart(3, '0')}`,
    entry_type: 'card.step_decision',
    gate_id: null,
    gate_instance_id: null,
    step: '0.1',
    card_id: CARD_ID,
    subject_kind: 's0_record',
    subject_id: S0_ID,
    decision: 'approve',
    actor: 'alice',
    sod_waiver: true,
    created_at: NOW,
    entry_hash: n.toString(16).padStart(2, '0').repeat(32),
    prev_hash: null,
    ...over,
  });

  it('lists the entries with seq, type, gate or step, decision, actor, alone, time and hash, and says how to verify', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed/ledger': {
        json: {
          project_id: 'testbed',
          s0_id: null,
          entries: [
            entry(3),
            entry(4, {
              entry_type: 'decision',
              gate_id: 'M4',
              step: null,
              sod_waiver: false,
              actor: 'bob',
            }),
          ],
          head: { ledger_seq: 9, entry_hash: 'f'.repeat(64) },
        },
      },
    });
    renderAt('/projects/testbed/ledger');
    const table = await screen.findByRole('table', { name: 'Ledger entries' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('3');
    expect(rows[1]).toHaveTextContent('step 0.1');
    expect(rows[1]).toHaveTextContent('sod_waiver');
    expect(rows[2]).toHaveTextContent('M4');
    expect(rows[2]).toHaveTextContent('bob');
    expect(within(rows[2] as HTMLElement).getByText('04'.repeat(32))).toBeInTheDocument();
    expect(screen.getByText(/aisdlc verify-ledger --db/)).toBeInTheDocument();
    expect(screen.getByText(/The ledger itself is at entry 9/)).toBeInTheDocument();
  });

  it('with ?s0= it asks for one record and offers the whole project', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/projects/testbed/ledger?s0=${S0_ID}`]: {
        json: { project_id: 'testbed', s0_id: S0_ID, entries: [], head: null },
      },
    });
    renderAt(`/projects/testbed/ledger?s0=${S0_ID}`);
    expect(await screen.findByTestId('ledger-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show the whole project' })).toHaveAttribute(
      'href',
      '/projects/testbed/ledger',
    );
    expect(m.calls.some((c) => c.path.includes(`s0=${S0_ID}`))).toBe(true);
  });

  it('a person without audit rights is told so', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed/ledger': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'audit.read denied' } },
      },
    });
    renderAt('/projects/testbed/ledger');
    expect(await screen.findByRole('alert')).toHaveTextContent('audit.read denied');
  });
});

describe('the schema check of the decision form', () => {
  const schema = {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: ['T0', 'T1'] },
      owners: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[a-z]+$' } },
      ok: { type: 'boolean', const: true },
      who: {
        oneOf: [
          {
            type: 'object',
            properties: { k: { const: 'a' } },
            required: ['k'],
            additionalProperties: false,
          },
          { type: 'string' },
        ],
      },
    },
    required: ['tier', 'owners'],
    additionalProperties: false,
  };
  it('accepts what fits and says in words what does not', () => {
    expect(validateAgainst(schema, { tier: 'T0', owners: ['alice'] })).toEqual([]);
    const bad = validateAgainst(schema, { tier: 'T9', owners: [], extra: 1, ok: false });
    expect(bad.join('|')).toMatch(/tier must be one of/);
    expect(bad.join('|')).toMatch(/owners needs at least 1 entry/);
    expect(bad.join('|')).toMatch(/extra is not something this decision takes/);
    expect(bad.join('|')).toMatch(/ok must be true/);
    expect(validateAgainst(schema, { owners: ['A'] }).join('|')).toMatch(/tier is required/);
    expect(validateAgainst(schema, { tier: 'T0', owners: ['A'] }).join('|')).toMatch(
      /owners\[0\] has a form/,
    );
    expect(
      validateAgainst(schema, { tier: 'T0', owners: ['a'], who: { k: 'b' } }).join('|'),
    ).toMatch(/does not fit/);
    expect(validateAgainst(schema, 'nope').join('|')).toMatch(/must be object/);
  });
});
