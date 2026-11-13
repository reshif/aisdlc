import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EVIDENCE, c1View, decided, detail, secrView, gap, ENTRY_HASH } from './cardFixtures';
import { CARD_ID, me, mockApi, renderAt, S0_ID } from './helpers';

// The Decide screens of the onboarding cards that are their own approval (the security card; cards 2 and 3 have
// their own files), and cards 1, 4, 5, which portal v2 decides through the one onboarding sign-off (onboard-v2).

const base = (card: ReturnType<typeof detail>, extra: Record<string, unknown> = {}) => ({
  'GET /api/me': { json: me() },
  [`GET /api/cards/${CARD_ID}`]: { json: card },
  [`POST /api/cards/${CARD_ID}/prepare`]: {
    json: {
      nonce: 'nonce-1',
      expires_at: '2026-11-08T10:15:00.000Z',
      evidence_hash: EVIDENCE,
      step_up: null,
    },
  },
  [`POST /api/cards/${CARD_ID}/evidence`]: { json: { evidence_viewed: true } },
  ...extra,
});

const ready = async () => {
  // the decide buttons come on once the nonce is issued and the evidence has been reported
  await screen.findByRole('region', { name: 'Decision' });
  await waitFor(() => expect(screen.queryByText(/Getting the decision form ready/)).toBeNull());
};

const sent = (m: ReturnType<typeof mockApi>, path: string) =>
  m.calls.filter((c) => c.path === path);

describe('cards 1, 4 and 5 (portal v2)', () => {
  it('are decided by the one onboarding sign-off: the card page says so and links to the summary, with no form', async () => {
    mockApi(base(detail('C1', c1View())));
    renderAt(`/cards/${CARD_ID}`);
    const p = await screen.findByTestId('decided-on-summary');
    expect(within(p).getByRole('link', { name: 'Open the onboarding summary' })).toHaveAttribute(
      'href',
      `/onboard/${S0_ID}`,
    );
    expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
  });
});

describe('the security card', () => {
  it('shows counts only and decides one finding with a state and a reason', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(
        detail('SECR', secrView(), {
          deciders: { ...detail('SECR', {}).deciders, slot: 'sec' } as never,
        }),
        {
          [`POST /api/cards/${CARD_ID}/decide`]: { json: decided() },
        },
      ),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: /Security card/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Finding counts' })).toHaveTextContent('open: 2');
    expect(screen.getByText(/Finding 1 of 2/)).toBeInTheDocument();
    await ready();
    expect(screen.queryByRole('button', { name: 'Reject the onboarding' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Record this decision' });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/Rotated:/));
    await user.type(screen.getByLabelText(/What you did/), 'rotated the deploy key');
    await user.click(button);
    await screen.findByTestId('receipt');
    expect(sent(m, `/api/cards/${CARD_ID}/decide`)[0]?.body).toEqual({
      nonce: 'nonce-1',
      decision: 'approve',
      content: { state: 'rotated', reason: 'rotated the deploy key' },
    });
  });
});

void gap;

describe('a work-item gate card (G2): the artefacts it decides', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    card_id: CARD_ID,
    project_id: 'testbed',
    item_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
    gates: ['G2'],
    subject_hash: 'c'.repeat(64),
    intact: true,
    artefacts: [
      {
        step: '3.2',
        type: 'spec_delta',
        sha256: 'd'.repeat(64),
        version: 2,
        markdown:
          '# Spec delta\n\n## REQ-12 (modified)\n\n<img src=x onerror=alert(1)> exports CSV\n',
        intact: true,
      },
      {
        step: '3.4',
        type: 'oracle_specs',
        sha256: 'e'.repeat(64),
        version: 1,
        markdown: '# Oracle specs\n\n## o1 for REQ-12\n',
        intact: true,
      },
    ],
    ...over,
  });
  const notOnboarding = {
    status: 404,
    json: { error: { code: 'not_found', message: 'not an onboarding card' } },
  };

  it('renders both artefacts with their hashes, as text (nothing in them becomes markup)', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/cards/${CARD_ID}`]: notOnboarding,
      [`GET /api/cards/${CARD_ID}/artefacts`]: { json: view() },
      [`GET /api/cards/${CARD_ID}/gate`]: {
        status: 403,
        json: { error: { code: 'forbidden', message: 'x' } },
      },
    });
    const { container } = renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', { name: /Spec and oracle-spec approval/ }),
    ).toBeTruthy();
    expect(screen.getByText('d'.repeat(64))).toBeTruthy();
    expect(screen.getByText('e'.repeat(64))).toBeTruthy();
    expect(screen.getByLabelText('spec_delta').textContent).toContain(
      '<img src=x onerror=alert(1)> exports CSV',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText(/not intact/i)).toBeNull();
  });

  it('P3-8: asks the card kind once and never probes the onboarding route (no 404 in the console)', async () => {
    const { calls } = mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/cards/${CARD_ID}/kind`]: { json: { card_id: CARD_ID, kind: 'work_gate' } },
      [`GET /api/cards/${CARD_ID}/artefacts`]: { json: view() },
      [`GET /api/cards/${CARD_ID}/gate`]: {
        status: 403,
        json: { error: { code: 'forbidden', message: 'x' } },
      },
    });
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByRole('heading', { name: /Spec and oracle-spec approval/ });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain(`/api/cards/${CARD_ID}/kind`);
    expect(paths).not.toContain(`/api/cards/${CARD_ID}`);
  });

  it('says so, loudly, when an artefact is not intact, and shows no text for it', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/cards/${CARD_ID}`]: notOnboarding,
      [`GET /api/cards/${CARD_ID}/artefacts`]: {
        json: view({
          intact: false,
          artefacts: [
            {
              step: '3.2',
              type: 'spec_delta',
              sha256: 'd'.repeat(64),
              version: null,
              markdown: null,
              intact: false,
            },
          ],
        }),
      },
      [`GET /api/cards/${CARD_ID}/gate`]: {
        status: 403,
        json: { error: { code: 'forbidden', message: 'x' } },
      },
    });
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/An artefact is not intact/)).toBeTruthy();
    expect(screen.getByLabelText('spec_delta').querySelector('pre')).toBeNull();
  });
});

describe('deciding a work-item gate card (G0 and G1, G2, G3d, G3 ...): prepare, evidence viewed, decide', () => {
  const SUBJECT = 'c'.repeat(64);
  const GATE_A = '0190a000-0000-7000-8000-0000000000a1';
  const GATE_B = '0190a000-0000-7000-8000-0000000000a2';
  const artefactsView = (over: Record<string, unknown> = {}) => ({
    card_id: CARD_ID,
    project_id: 'testbed',
    item_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
    gates: ['G0', 'G1'],
    subject_hash: SUBJECT,
    intact: true,
    artefacts: [
      {
        step: '1.3',
        type: 'classification',
        sha256: 'd'.repeat(64),
        version: 1,
        markdown: '# Classification\n\n- work type: change\n',
        intact: true,
      },
      {
        step: '1.5',
        type: 'intent_block',
        sha256: 'e'.repeat(64),
        version: 1,
        markdown: '# Intent\n\n## Goal\n\nLet admins export the audit log.\n',
        intact: true,
      },
    ],
    ...over,
  });
  const gateCard = (over: Record<string, unknown> = {}) => ({
    card_id: CARD_ID,
    project_id: 'testbed',
    item_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
    status: 'open',
    gates: [
      {
        gate_instance_id: GATE_A,
        gate: 'G0',
        slot: 'intent',
        status: 'pending',
        outcome: null,
        step_up_required: false,
      },
      {
        gate_instance_id: GATE_B,
        gate: 'G1',
        slot: 'intent',
        status: 'pending',
        outcome: null,
        step_up_required: false,
      },
    ],
    subject_hash: SUBJECT,
    proposed_lane: 'L4',
    base_sha: null,
    injection_suspected: false,
    deciders: { slots: ['intent'], holders: ['alice'] },
    decisions_allowed: ['approve', 'reject', 'request_changes'],
    decision_reason: null,
    may_decide: true,
    principal_names: { alice: 'Alice Admin' },
    ...over,
  });
  const prepared = (subject = SUBJECT) => ({
    card_id: CARD_ID,
    gates: [
      {
        gate_instance_id: GATE_A,
        gate: 'G0',
        nonce: 'nonce-a',
        expires_at: '2026-11-08T10:15:00.000Z',
        subject_hash: subject,
        evidence_hash: subject,
        step_up: { required: false, bound_hash: subject },
      },
      {
        gate_instance_id: GATE_B,
        gate: 'G1',
        nonce: 'nonce-b',
        expires_at: '2026-11-08T10:15:00.000Z',
        subject_hash: subject,
        evidence_hash: subject,
        step_up: { required: false, bound_hash: subject },
      },
    ],
  });
  const notOnboarding = {
    status: 404,
    json: { error: { code: 'not_found', message: 'not an onboarding card' } },
  };
  const routes = (
    o: { gate?: unknown; art?: unknown; prep?: unknown; extra?: Record<string, unknown> } = {},
  ) => ({
    'GET /api/me': { json: me() },
    [`GET /api/cards/${CARD_ID}`]: notOnboarding,
    [`GET /api/cards/${CARD_ID}/artefacts`]: { json: o.art ?? artefactsView() },
    [`GET /api/cards/${CARD_ID}/gate`]: { json: o.gate ?? gateCard() },
    [`POST /api/cards/${CARD_ID}/gate/prepare`]: { json: o.prep ?? prepared() },
    [`POST /api/cards/${CARD_ID}/gate/evidence`]: { json: { evidence_viewed: true } },
    ...(o.extra ?? {}),
  });
  const entries = [
    {
      ledger_seq: 7,
      entry_id: 'e1',
      entry_hash: ENTRY_HASH,
      entry_type: 'decision',
      gate_id: 'G0',
      decision: 'approve',
      actor: 'alice',
      sod_waiver: false,
    },
    {
      ledger_seq: 8,
      entry_id: 'e2',
      entry_hash: ENTRY_HASH,
      entry_type: 'decision',
      gate_id: 'G1',
      decision: 'approve',
      actor: 'alice',
      sod_waiver: false,
    },
  ];
  const decideReady = async () => {
    await screen.findByRole('region', { name: 'Decision' });
    await waitFor(() => expect(screen.queryByText(/Getting the decision form ready/)).toBeNull());
  };

  it('renders the artefacts first; the evidence is reported only after, for every gate, and nothing is decided by itself', async () => {
    const m = mockApi(routes());
    renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', { name: /Lane and intent and Intent acceptance/ }),
    ).toBeTruthy();
    await decideReady();
    expect(screen.getByLabelText('intent_block').textContent).toContain(
      'Let admins export the audit log.',
    );
    const order = m.calls.map((c) => `${c.method} ${c.path}`).filter((x) => x.includes('/gate/'));
    expect(order).toEqual([
      `POST /api/cards/${CARD_ID}/gate/prepare`,
      `POST /api/cards/${CARD_ID}/gate/evidence`,
    ]);
    expect(sent(m, `/api/cards/${CARD_ID}/gate/evidence`)[0]?.body).toEqual({
      views: [
        { nonce: 'nonce-a', evidence_hash: SUBJECT },
        { nonce: 'nonce-b', evidence_hash: SUBJECT },
      ],
    });
    // no decision was sent, no button is a default, and it says so
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)).toHaveLength(0);
    expect(screen.getByText(/Nothing is decided until you press one of/)).toBeTruthy();
    expect(screen.getByText(/Proposed lane: L4/)).toBeTruthy();
  });

  it('approve sends one vote per gate with the csrf token and shows the ledger receipt', async () => {
    const m = mockApi(
      routes({
        extra: {
          [`POST /api/cards/${CARD_ID}/gate/decide`]: {
            json: { card_id: CARD_ID, entries, status: 'decided' },
          },
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await decideReady();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const receipt_ = await screen.findByRole('region', { name: 'Ledger receipt' });
    expect(within(receipt_).getByText('G0: approved')).toBeTruthy();
    expect(within(receipt_).getByText('G1: approved')).toBeTruthy();
    const d = sent(m, `/api/cards/${CARD_ID}/gate/decide`);
    expect(d).toHaveLength(1);
    expect(d[0]?.body).toEqual({
      decision: 'approve',
      votes: [{ nonce: 'nonce-a' }, { nonce: 'nonce-b' }],
    });
    expect(d[0]?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('reject and ask for changes need a reason: without one nothing is sent; with one it goes with the decision', async () => {
    const m = mockApi(
      routes({
        extra: {
          [`POST /api/cards/${CARD_ID}/gate/decide`]: {
            json: {
              card_id: CARD_ID,
              entries: [{ ...entries[0], decision: 'reject' }],
              status: 'rejected',
            },
          },
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await decideReady();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByTestId('decide-issues')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ask for changes' }));
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)).toHaveLength(0);
    await user.type(screen.getByLabelText(/Reason/), 'The goal is too wide');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await screen.findByRole('region', { name: 'Ledger receipt' });
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)[0]?.body).toEqual({
      decision: 'reject',
      reason: 'The goal is too wide',
      votes: [{ nonce: 'nonce-a' }, { nonce: 'nonce-b' }],
    });
  });

  it('a person who may not decide sees the evidence and no button, and nothing is prepared', async () => {
    const m = mockApi(routes({ gate: gateCard({ may_decide: false }) }));
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByTestId('not-decidable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/prepare`)).toHaveLength(0);
  });

  it('an artefact that is not intact cannot be decided: no button, nothing prepared', async () => {
    const m = mockApi(
      routes({
        art: artefactsView({
          intact: false,
          artefacts: [
            {
              step: '1.5',
              type: 'intent_block',
              sha256: 'e'.repeat(64),
              version: null,
              markdown: null,
              intact: false,
            },
          ],
        }),
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/An artefact is not intact/)).toBeTruthy();
    expect(await screen.findByTestId('not-decidable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/prepare`)).toHaveLength(0);
  });

  it('a card whose subject changed between the page and the nonce is not decided blind: the evidence is never reported', async () => {
    const m = mockApi(routes({ prep: prepared('f'.repeat(64)) }));
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/The card changed while this page was opening/)).toBeTruthy();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/evidence`)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true);
  });

  it('a gate that needs a step-up is not decided here, and a closed card says how it ended', async () => {
    mockApi(
      routes({
        gate: gateCard({
          gates: [
            {
              gate_instance_id: GATE_A,
              gate: 'G3',
              slot: 'design',
              status: 'pending',
              outcome: null,
              step_up_required: true,
            },
          ],
          may_decide: false,
        }),
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/needs you to confirm your identity again/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a decided card shows its reason and offers no button', async () => {
    mockApi(
      routes({
        gate: gateCard({
          status: 'decided',
          gates: [
            {
              gate_instance_id: GATE_A,
              gate: 'G2',
              slot: 'intent',
              status: 'decided',
              outcome: 'request_changes',
              step_up_required: false,
            },
          ],
          decision_reason: 'REQ-12 is missing a header row',
          may_decide: false,
        }),
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/REQ-12 is missing a header row/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
