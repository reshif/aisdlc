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

describe('deciding a work-item approval that decides documents (portal v2 Decide)', () => {
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
        markdown: '# Intent\n\n<img src=x onerror=alert(1)> Let admins export the audit log.\n',
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
    why_not: null,
    principal_names: { alice: 'Alice Admin' },
    ...over,
  });
  const prepared = (subject = SUBJECT) => ({
    card_id: CARD_ID,
    gates: [GATE_A, GATE_B].map((g, n) => ({
      gate_instance_id: g,
      gate: n === 0 ? 'G0' : 'G1',
      nonce: n === 0 ? 'nonce-a' : 'nonce-b',
      expires_at: '2026-11-08T10:15:00.000Z',
      subject_hash: subject,
      evidence_hash: subject,
      step_up: { required: false, bound_hash: subject },
    })),
  });
  const routes = (
    o: { gate?: unknown; art?: unknown; prep?: unknown; extra?: Record<string, unknown> } = {},
  ) => ({
    'GET /api/me': { json: me() },
    [`GET /api/cards/${CARD_ID}/kind`]: { json: { card_id: CARD_ID, kind: 'work_gate' } },
    [`GET /api/cards/${CARD_ID}/artefacts`]: { json: o.art ?? artefactsView() },
    [`GET /api/cards/${CARD_ID}/gate`]: { json: o.gate ?? gateCard() },
    [`GET /api/cards/${CARD_ID}/gate/context`]: {
      status: 403,
      json: { error: { code: 'forbidden', message: 'view level' } },
    },
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
  ];
  const decideReady = async () => {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  };

  it('names the approvals in plain words, asks the card kind once, and shows a document as text', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    const { container } = renderAt(`/decide/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Accept the request and Confirm the goal',
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('decide')).not.toHaveTextContent(/\b(G0|G1|L4)\b/);
    expect(screen.getByTestId('decide')).toHaveTextContent('Track: Feature');
    await user.click(screen.getByRole('button', { name: /Agreed goal/ }));
    expect(screen.getByTestId('detail').textContent).toContain(
      '<img src=x onerror=alert(1)> Let admins export the audit log.',
    );
    expect(container.querySelector('img')).toBeNull();
    const paths = m.calls.map((c) => c.path);
    expect(paths).toContain(`/api/cards/${CARD_ID}/kind`);
    expect(paths).not.toContain(`/api/cards/${CARD_ID}`);
    // the part of the evidence a higher view level would show is said, never assumed passed
    expect(screen.getByTestId('doubts')).toHaveTextContent('needs a higher view level');
  });

  it('prepares, reports the evidence after it was shown, and decides nothing by itself', async () => {
    const m = mockApi(routes());
    renderAt(`/decide/${CARD_ID}`);
    await decideReady();
    const order = m.calls.map((c) => `${c.method} ${c.path}`).filter((x) => x.startsWith('POST'));
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
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)).toHaveLength(0);
  });

  it('approve sends one vote per gate with the csrf token and shows the decision log entry', async () => {
    const m = mockApi(
      routes({
        extra: {
          [`POST /api/cards/${CARD_ID}/gate/decide`]: {
            json: { card_id: CARD_ID, entries, status: 'decided' },
          },
        },
      }),
    );
    renderAt(`/decide/${CARD_ID}`);
    await decideReady();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByTestId('receipt')).toHaveTextContent(
      'Approve, decision log entry 7.',
    );
    const d = sent(m, `/api/cards/${CARD_ID}/gate/decide`);
    expect(d).toHaveLength(1);
    expect(d[0]?.body).toEqual({
      decision: 'approve',
      votes: [{ nonce: 'nonce-a' }, { nonce: 'nonce-b' }],
    });
    expect(d[0]?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('reject and request changes need a reason: without one nothing is sent', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes({
        extra: {
          [`POST /api/cards/${CARD_ID}/gate/decide`]: {
            json: { card_id: CARD_ID, entries: [{ ...entries[0], decision: 'reject' }] },
          },
        },
      }),
    );
    renderAt(`/decide/${CARD_ID}`);
    await decideReady();
    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /^Request changes/ }));
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)).toHaveLength(0);
    await user.type(screen.getByLabelText('Reason'), 'The goal is too wide');
    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await screen.findByTestId('receipt');
    expect(sent(m, `/api/cards/${CARD_ID}/gate/decide`)[0]?.body).toEqual({
      decision: 'reject',
      reason: 'The goal is too wide',
      votes: [{ nonce: 'nonce-a' }, { nonce: 'nonce-b' }],
    });
  });

  it('a person who may not decide reads the evidence, gets no button, and nothing is prepared', async () => {
    const m = mockApi(
      routes({
        gate: gateCard({ may_decide: false, why_not: { code: 'not_slot_holder', reasons: [] } }),
      }),
    );
    renderAt(`/decide/${CARD_ID}`);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Only the request and spec approver can decide this. Ask Alice Admin.',
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decide as factory admin' })).toBeNull();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/prepare`)).toHaveLength(0);
  });

  it('a document that is not intact cannot be decided: no button, nothing prepared', async () => {
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
    renderAt(`/decide/${CARD_ID}`);
    expect(await screen.findByText(/not intact, so it cannot be decided/)).toBeTruthy();
    expect(screen.getByTestId('doubts')).toHaveTextContent('Do not approve it');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/prepare`)).toHaveLength(0);
  });

  it('an approval whose subject changed under the page is not decided blind', async () => {
    const m = mockApi(routes({ prep: prepared('f'.repeat(64)) }));
    renderAt(`/decide/${CARD_ID}`);
    expect(
      await screen.findByText(/This approval changed while the page was opening/),
    ).toBeTruthy();
    expect(sent(m, `/api/cards/${CARD_ID}/gate/evidence`)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('a decided approval says how it ended, with its reason, and offers no button', async () => {
    mockApi(
      routes({
        gate: gateCard({
          status: 'sent_back',
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
          why_not: { code: 'not_open', reasons: [] },
        }),
      }),
    );
    renderAt(`/decide/${CARD_ID}`);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'This approval is changes requested; nothing more is decided on it. The reason given: REQ-12 is missing a header row',
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a missing approval is the one 404', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/cards/${CARD_ID}/kind`]: {
        status: 404,
        json: { error: { code: 'not_found', message: 'no' } },
      },
    });
    renderAt(`/decide/${CARD_ID}`);
    await waitFor(() => expect(document.querySelector('[data-status="404"]')).not.toBeNull());
  });
});
