import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE,
  c1View,
  c4View,
  c5View,
  controls,
  decided,
  detail,
  receipt,
  secrView,
  gap,
  ENTRY_HASH,
  RECORD_HASH,
  REPORT_HASH,
} from './cardFixtures';
import { CARD_ID, me, mockApi, renderAt, S0_ID } from './helpers';

// The Decide screens of cards 1, 4, 5 and the security card (PLAN M8.3): each renders its view, the
// rules of the spec are in the controls, and a decision goes prepare -> evidence viewed -> decide.

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

describe('card 1', () => {
  it('renders census, tier floor with its evidence, posture and the gap list', async () => {
    mockApi(
      base(
        detail(
          'C1',
          c1View({
            tier: {
              ...c1View().tier,
              floor: 'T1',
              signals: [
                {
                  signal: 'deploy_workflow',
                  criterion: 'RS-TIER-1',
                  floor: 'T1',
                  raised_by: 'workflow',
                  evidence: [
                    { ref: 'fact:workflow_finding', path: '.github/workflows/deploy.yml' },
                  ],
                },
              ],
            },
            posture: { state: 'amber', reasons: [] },
            blockers: [{ id: 'B1', status: 'met', reasons: [], notes: [] }],
          }),
        ),
      ),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Card 1: confirm the census' }),
    ).toBeInTheDocument();
    const signals = screen.getByRole('table', { name: 'Signals behind the tier floor' });
    expect(within(signals).getByText('fact:workflow_finding')).toBeInTheDocument();
    expect(within(signals).getByText('.github/workflows/deploy.yml')).toBeInTheDocument();
    expect(screen.getByText(/floor is/)).toHaveTextContent('T1');
    expect(screen.getByText('amber')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Blockers' })).toHaveTextContent('B1');
    expect(screen.getByText(/3 gaps: 1 blocking/)).toBeInTheDocument();
    expect(screen.getByText('Alice Admin (alice)', { exact: false })).toBeInTheDocument();
  });

  it('enforces the gap rules in the controls: a blocking gap cannot be waived, a security gap is tracked only', async () => {
    mockApi(base(detail('C1', c1View())));
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByText('Gaps');
    const blocking = document.querySelector('[data-gap="gap:reshif.asf:RS-TH-1"]') as HTMLElement;
    const waiveBlocking = within(blocking).getByRole('radio', {
      name: /Accept the risk: waive it/,
    });
    expect(waiveBlocking).toBeDisabled();
    expect(within(blocking).getByText(/A blocking gap cannot be waived/)).toBeInTheDocument();
    // the default of a blocking public-safe gap is "file an issue"
    expect(within(blocking).getByRole('radio', { name: /Fix now/ })).toBeChecked();
    const secret = document.querySelector('[data-gap="gap:reshif.asf:RS-SEC-1"]') as HTMLElement;
    expect(within(secret).getByRole('radio', { name: /Fix later/ })).toBeChecked();
    expect(within(secret).getByRole('radio', { name: /Fix now/ })).toBeDisabled();
    expect(within(secret).getByRole('radio', { name: /Accept the risk/ })).toBeDisabled();
    expect(within(secret).getAllByText(/never filed, never waived/).length).toBeGreaterThan(0);
    // a tracked gap may be waived
    const tracked = document.querySelector('[data-gap="gap:reshif.asf:RS-AI-1"]') as HTMLElement;
    expect(within(tracked).getByRole('radio', { name: /Accept the risk/ })).toBeEnabled();
  });

  it('a waiver needs a reason and ends within 90 days; the form says so and stays off until it is right', async () => {
    const user = userEvent.setup();
    mockApi(base(detail('C1', c1View({ tier: { ...c1View().tier, blocks_m4_reasons: [] } }))));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const tracked = document.querySelector('[data-gap="gap:reshif.asf:RS-AI-1"]') as HTMLElement;
    await user.click(within(tracked).getByRole('radio', { name: /Accept the risk/ }));
    const why = within(tracked).getByLabelText('Why gap:reshif.asf:RS-AI-1 is waived');
    const date = within(tracked).getByLabelText(/waiver ends on/) as HTMLInputElement;
    expect(date).toHaveAttribute('max');
    const max = new Date(date.max).getTime();
    expect((max - Date.now()) / 86_400_000).toBeLessThanOrEqual(90);
    expect(screen.getByTestId('blocked')).toHaveTextContent('say why it is waived');
    await user.type(why, 'accepted until the next quarter');
    // too far out: refused in the form
    await user.clear(date);
    await user.type(date, '2030-01-01');
    expect(screen.getByTestId('blocked')).toHaveTextContent('a waiver lasts at most 90 days');
    expect(screen.getByRole('button', { name: 'Approve card 1' })).toBeDisabled();
  });

  it('the tier is raise-only, and T0 needs the exact sentence', async () => {
    const user = userEvent.setup();
    mockApi(
      base(
        detail('C1', c1View({ tier: { ...c1View().tier, floor: 'T1', blocks_m4_reasons: [] } })),
      ),
    );
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByText('Risk tier');
    expect(screen.getByRole('radio', { name: /T0/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'T1' })).toBeChecked();
    expect(screen.queryByLabelText('no prod, no real data, no dependants')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'T2' }));
    expect(screen.queryByLabelText('no prod, no real data, no dependants')).toBeNull();
  });

  it('T0 attestation, regulatory and criticality statements are all asked and all needed', async () => {
    const user = userEvent.setup();
    mockApi(base(detail('C1', c1View())));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const t0 = await screen.findByLabelText('no prod, no real data, no dependants');
    const approve = screen.getByRole('button', { name: 'Approve card 1' });
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('blocked')).toHaveTextContent(
      'For T0, attest: no prod, no real data, no dependants.',
    );
    await user.click(t0);
    await user.click(screen.getByLabelText(/no regulatory obligation/));
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('blocked')).toHaveTextContent('criticality');
    await user.click(screen.getByLabelText(/I attest the criticality/));
    expect(screen.queryByTestId('blocked')).toBeNull();
    expect(approve).toBeEnabled();
  });

  it('decides: prepare, evidence viewed after the page rendered, then the decision with every choice; the ledger receipt is shown', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(detail('C1', c1View()), {
        [`POST /api/cards/${CARD_ID}/decide`]: { json: decided() },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    // before the decision: exactly one prepare and the evidence report, in that order, nothing decided
    expect(m.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/api/cards/${CARD_ID}/prepare`,
      `/api/cards/${CARD_ID}/evidence`,
    ]);
    expect(sent(m, `/api/cards/${CARD_ID}/evidence`)[0]?.body).toEqual({
      nonce: 'nonce-1',
      evidence_hash: EVIDENCE,
    });
    await user.click(screen.getByLabelText('no prod, no real data, no dependants'));
    await user.click(screen.getByLabelText(/no regulatory obligation/));
    await user.click(screen.getByLabelText(/I attest the criticality/));
    const tracked = document.querySelector('[data-gap="gap:reshif.asf:RS-AI-1"]') as HTMLElement;
    await user.click(within(tracked).getByRole('radio', { name: /Fix now/ }));
    await user.click(screen.getByRole('button', { name: 'Approve card 1' }));
    const receiptBox = await screen.findByTestId('receipt');
    expect(receiptBox).toHaveTextContent('#7');
    expect(receiptBox).toHaveTextContent('approved');
    expect(receiptBox).toHaveTextContent(ENTRY_HASH);
    expect(
      within(receiptBox).getByRole('link', { name: 'Open entry #7 in the ledger' }),
    ).toHaveAttribute('href', '/projects/testbed/ledger#entry-7');
    const decide = sent(m, `/api/cards/${CARD_ID}/decide`)[0];
    expect(decide?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(decide?.body).toEqual({
      nonce: 'nonce-1',
      decision: 'approve',
      content: {
        owners: ['alice'],
        tier: 'T0',
        t0_attestation: true,
        regulatory_attested: true,
        criticality_attested: true,
        gaps: [
          { gap_id: 'gap:reshif.asf:RS-TH-1', disposition: 'file_issue' },
          { gap_id: 'gap:reshif.asf:RS-AI-1', disposition: 'file_issue' },
          { gap_id: 'gap:reshif.asf:RS-SEC-1', disposition: 'track_only' },
        ],
      },
    });
  });

  it('a person who may not decide sees the card with every control off and no decision form', async () => {
    const m = mockApi(base(detail('C1', c1View(), { may_decide: false })));
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByText('Gaps');
    expect(screen.getByTestId('not-decidable')).toHaveTextContent(
      'You may look at this card but not decide it',
    );
    expect(screen.getByRole('group', { name: 'Card' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve card 1' })).toBeNull();
    // no nonce was asked for: nothing was written
    expect(m.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a decided card is shown but cannot be decided again', async () => {
    const card = detail('C1', c1View());
    mockApi(base({ ...card, summary: { ...card.summary, status: 'decided', actionable: false } }));
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByTestId('not-decidable')).toHaveTextContent('decided');
  });
});

describe('the decide flow, and what goes wrong', () => {
  const setup = (
    decide: { status: number; json: unknown },
    card = detail('C1', c1View({ tier: { ...c1View().tier, blocks_m4_reasons: [] }, gaps: [] })),
  ) => mockApi(base(card, { [`POST /api/cards/${CARD_ID}/decide`]: decide }));

  async function fillAndApprove(user: ReturnType<typeof userEvent.setup>) {
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await user.click(await screen.findByLabelText('no prod, no real data, no dependants'));
    await user.click(screen.getByRole('button', { name: 'Approve card 1' }));
  }

  it('stale evidence: says what changed, offers a reload, decides nothing', async () => {
    const user = userEvent.setup();
    setup({
      status: 409,
      json: {
        error: {
          code: 'conflict',
          message: 'the census moved on since this card was raised; the card is stale',
        },
      },
    });
    await fillAndApprove(user);
    const p = await screen.findByTestId('decide-problem');
    expect(p).toHaveTextContent('What you were shown has changed');
    expect(p).toHaveTextContent('Nothing was decided');
    expect(within(p).getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('403: not allowed, in words', async () => {
    const user = userEvent.setup();
    setup({ status: 403, json: { error: { code: 'forbidden', message: 'card.decide denied' } } });
    await fillAndApprove(user);
    expect(await screen.findByTestId('decide-problem')).toHaveTextContent(
      'You are not allowed to decide this card',
    );
  });

  it('a server-side refusal of a rule is shown with its reason', async () => {
    const user = userEvent.setup();
    setup({
      status: 422,
      json: {
        error: {
          code: 'refused',
          message: 'refused: the tier is raise-only: the floor is T1, T0 is below it',
        },
      },
    });
    await fillAndApprove(user);
    expect(await screen.findByTestId('decide-problem')).toHaveTextContent('the tier is raise-only');
  });

  it('a spent nonce renews the form and asks again; nothing is decided', async () => {
    const user = userEvent.setup();
    const m = setup({
      status: 409,
      json: { error: { code: 'conflict', message: 'conflict: nonce_replayed: used' } },
    });
    await fillAndApprove(user);
    expect(await screen.findByTestId('decide-problem')).toHaveTextContent(
      'timed out. It has been renewed',
    );
    await waitFor(() => expect(sent(m, `/api/cards/${CARD_ID}/prepare`)).toHaveLength(2));
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('send-backs: while one is left it is offered; when used up, only rejection remains, with the consequence said', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(detail('C1', c1View({ tier: { ...c1View().tier, blocks_m4_reasons: [] }, gaps: [] })), {
        [`POST /api/cards/${CARD_ID}/decide`]: {
          json: decided([receipt({ decision: 'request_changes' })]),
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const send = screen.getByRole('button', { name: 'Send back for changes' });
    expect(send).toBeEnabled();
    expect(screen.getByTestId('sendback-note')).toHaveTextContent('Send-backs used: 0 of 1');
    await user.click(send);
    expect(await screen.findByTestId('decide-issues')).toHaveTextContent('Say why');
    await user.type(screen.getByLabelText(/Reason/), 'the owners are wrong');
    await user.click(send);
    await screen.findByTestId('receipt');
    expect(sent(m, `/api/cards/${CARD_ID}/decide`)[0]?.body).toEqual({
      nonce: 'nonce-1',
      decision: 'request_changes',
      reason: 'the owners are wrong',
    });
  });

  it('with no send-back left the button is off and the note says rejecting ends the onboarding', async () => {
    mockApi(base(detail('C1', c1View({ gaps: [] }), { send_backs: { used: 1, limit: 1 } })));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    expect(screen.getByRole('button', { name: 'Send back for changes' })).toBeDisabled();
    expect(screen.getByTestId('sendback-note')).toHaveTextContent(
      'the only way to stop is to reject',
    );
    expect(screen.getByRole('button', { name: 'Reject the onboarding' })).toBeEnabled();
  });

  it('never decides by itself: after the page is ready no decision has been sent', async () => {
    const m = mockApi(base(detail('C1', c1View())));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(m, `/api/cards/${CARD_ID}/decide`)).toHaveLength(0);
    for (const b of screen.getAllByRole('button')) {
      expect(b).not.toHaveAttribute('type', 'submit');
    }
  });

  it('a card changed under the page (the prepared evidence differs) is stale before any decision', async () => {
    const m = mockApi(
      base(detail('C1', c1View()), {
        [`POST /api/cards/${CARD_ID}/prepare`]: {
          json: {
            nonce: 'n',
            expires_at: '2026-11-08T10:15:00.000Z',
            evidence_hash: '1'.repeat(64),
            step_up: null,
          },
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByText(/The card changed while this page was opening/),
    ).toBeInTheDocument();
    expect(sent(m, `/api/cards/${CARD_ID}/evidence`)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Approve card 1' })).toBeDisabled();
  });
});

describe('card 4', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    for (const t of [
      'the bypass list has no factory App',
      /installed on selected repositories only/,
      'the default GITHUB_TOKEN is read-only',
      '“Actions may create/approve PRs” is off',
      'fork-PR approval is required',
    ]) {
      await user.click(screen.getByLabelText(t));
    }
    await user.click(
      screen.getByLabelText(/secret scanning and push protection are on where the plan allows/),
    );
    await user.click(screen.getByLabelText('Free'));
  };

  it('shows the controls report with met, not met and unknown, what to do on GitHub, and a re-check button', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(detail('C4', c4View()), {
        [`POST /api/cards/${CARD_ID}/recheck`]: { json: {} },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByText('Controls report');
    const table = screen.getByRole('table', { name: 'Controls' });
    const row = (id: string) =>
      within(table).getByText(
        (_, el) => el?.getAttribute('data-control') === id && el.tagName === 'TR',
      );
    void row;
    const b4b = table.querySelector('[data-control="B4b"]') as HTMLElement;
    expect(within(b4b).getByText('Not met')).toBeInTheDocument();
    expect(within(b4b).getByText(/Pin every required status check/)).toBeInTheDocument();
    expect(
      within(table.querySelector('[data-control="B4a"]') as HTMLElement).getByText('Met'),
    ).toBeInTheDocument();
    expect(
      within(table.querySelector('[data-control="codeowners"]') as HTMLElement).getByText(
        /Unknown \(counts as not met\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 blocking control is open/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(sent(m, `/api/cards/${CARD_ID}/recheck`)).toHaveLength(1));
    expect(sent(m, `/api/cards/${CARD_ID}/recheck`)[0]?.headers['x-csrf-token']).toBe(
      'csrf-token-of-alice',
    );
  });

  it('an open blocking control keeps the approval off, whatever else is filled in', async () => {
    const user = userEvent.setup();
    mockApi(base(detail('C4', c4View())));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await fill(user);
    expect(screen.getByTestId('blocked')).toHaveTextContent('Blocking controls are not met (B4b)');
    expect(screen.getByRole('button', { name: 'Approve card 4' })).toBeDisabled();
  });

  it('attestations use the words of §5.5; the ten slots are all there; T0 lets two-person be switched off', async () => {
    const user = userEvent.setup();
    mockApi(base(detail('C4', c4View({}, controls({ blocking_open: [], controls: [] })))));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    for (const t of [
      'the bypass list has no factory App',
      'the default GITHUB_TOKEN is read-only',
      '“Actions may create/approve PRs” is off',
      'fork-PR approval is required',
      'secret scanning and push protection are on where the plan allows',
    ]) {
      expect(screen.getByLabelText(t)).not.toBeChecked();
    }
    // The plan is asked, with the note about private repos on Free (OB §5.5, §9.1 row 2); nothing is preselected.
    expect(screen.getByText(/Which GitHub plan is the owner/)).toBeInTheDocument();
    expect(screen.getByText(/cannot enforce rulesets/)).toBeInTheDocument();
    for (const p of ['Free', 'Pro', 'Team', 'Enterprise']) {
      expect(screen.getByLabelText(p)).not.toBeChecked();
    }
    const slots = document.querySelectorAll('.role');
    expect([...slots].map((s) => s.getAttribute('data-slot'))).toEqual([
      'admin',
      'requesters',
      'intent',
      'design',
      'g4',
      'g5',
      'x',
      'sec',
      'm4',
      'kill',
    ]);
    const two = screen.getByLabelText(/Require a second person/);
    expect(two).toBeEnabled();
    expect(two).toBeChecked();
    await user.click(two);
    expect(two).not.toBeChecked();
  });

  it('T2 locks two-person on and the gating floor on', async () => {
    mockApi(
      base(
        detail(
          'C4',
          c4View(
            {
              tier: 'T2',
              two_person: { locked_on: true, current: null, default: { enabled: true } },
              gating_profile: { current: null, t2_floor_applies: true, project_deploys: true },
            },
            controls({ blocking_open: [], controls: [] }),
          ),
        ),
      ),
    );
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const two = screen.getByLabelText(/Require a second person/);
    expect(two).toBeChecked();
    expect(two).toBeDisabled();
    for (const g of [/\(g2\) is on/, /\(g3d\) is on/, /\(g3_g3s\) is on/, /\(g5\) is on/]) {
      expect(screen.getByLabelText(g)).toBeDisabled();
    }
    expect(screen.getByLabelText(/\(g0g1\) is on/)).toBeEnabled();
  });

  it('decides with the role map, two-person off and the gating profile, as the content the server validates', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(detail('C4', c4View({}, controls({ blocking_open: [], controls: [] }))), {
        [`POST /api/cards/${CARD_ID}/decide`]: { json: decided([receipt({ sod_waiver: true })]) },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await fill(user);
    await user.click(screen.getByLabelText(/Require a second person/));
    const m4 = screen.getByLabelText(/^m4:/);
    await user.clear(m4);
    await user.type(m4, 'alice, bob');
    await user.click(screen.getByRole('button', { name: 'Approve card 4' }));
    await screen.findByTestId('receipt');
    const body = sent(m, `/api/cards/${CARD_ID}/decide`)[0]?.body as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sent content is read field by field
      content: Record<string, any>;
    };
    expect(body.content['controls_report_hash']).toBe(REPORT_HASH);
    expect(body.content['two_person_enabled']).toBe(false);
    expect(body.content['role_map'].m4).toEqual({
      kind: 'principals',
      principals: ['alice', 'bob'],
    });
    expect(body.content['role_map'].admin).toEqual({ kind: 'principals', principals: ['alice'] });
    expect(body.content['role_map'].g4).toEqual({ kind: 'codeowners' });
    expect(body.content['attestations']).toMatchObject({
      secret_scanning: 'on',
      plan: 'free',
      bypass_has_no_factory_app: true,
    });
    expect(body.content['kill_delegations']).toEqual([]);
  });

  it('a slot that needs someone and a bad person id are caught in the form', async () => {
    const user = userEvent.setup();
    mockApi(base(detail('C4', c4View({}, controls({ blocking_open: [], controls: [] })))));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await fill(user);
    const m4 = screen.getByLabelText(/^m4:/);
    await user.clear(m4);
    expect(screen.getByTestId('blocked')).toHaveTextContent(
      'The m4 slot needs at least one person.',
    );
    await user.type(m4, 'not valid!');
    expect(screen.getByTestId('blocked')).toHaveTextContent('not valid');
  });

  it('a kill delegation can be added for the project or one lane', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(detail('C4', c4View({}, controls({ blocking_open: [], controls: [] }))), {
        [`POST /api/cards/${CARD_ID}/decide`]: { json: decided() },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add a kill delegation' }));
    await user.type(screen.getByLabelText('Delegation 1: person id'), 'bob');
    await user.selectOptions(screen.getByLabelText('Delegation 1: covers'), 'lane');
    await user.selectOptions(screen.getByLabelText('Delegation 1: lane'), 'L5');
    await user.click(screen.getByRole('button', { name: 'Approve card 4' }));
    await screen.findByTestId('receipt');
    const body = sent(m, `/api/cards/${CARD_ID}/decide`)[0]?.body as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sent content is read field by field
      content: Record<string, any>;
    };
    expect(body.content['kill_delegations']).toEqual([
      { delegate: 'bob', scope: { kind: 'lane', ref: 'testbed/L5' } },
    ]);
  });
});

describe('card 5', () => {
  const c5 = (over: Partial<ReturnType<typeof detail>> = {}) => detail('C5', c5View(), over);
  const prepared = {
    json: {
      nonce: 'gate-nonce',
      expires_at: '2026-11-08T10:15:00.000Z',
      evidence_hash: EVIDENCE,
      step_up: { required: true, bound_hash: RECORD_HASH },
    },
  };

  it('shows the readiness record: level, tier, caps and which binds, lanes, gaps and the record hash', async () => {
    mockApi(base(c5(), { [`POST /api/cards/${CARD_ID}/prepare`]: prepared }));
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByText('Readiness record');
    expect(screen.getByTestId('c5-level')).toHaveTextContent('census');
    expect(screen.getByTestId('c5-tier')).toHaveTextContent('T0 (floor T0');
    const caps = screen.getByRole('table', { name: 'Autonomy caps' });
    expect(caps.querySelector('[data-cap="level"]')).toHaveAttribute('data-binds', 'yes');
    expect(caps.querySelector('[data-cap="tier"]')).toHaveAttribute('data-binds', 'no');
    expect(
      within(caps.querySelector('[data-cap="posture"]') as HTMLElement).getByText(
        /none \(green posture\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('c5-lanes')).toHaveTextContent('L2, L8');
    expect(screen.getByText(/3 gaps: 0 blocking, 1 waived/)).toBeInTheDocument();
    expect(screen.getAllByText(RECORD_HASH).length).toBeGreaterThan(0);
    expect(screen.getByText(/the sign-off is decided by/i)).toBeInTheDocument();
  });

  it('needs the read confirmation and the step-up before any decision button works; nothing is sent meanwhile', async () => {
    const user = userEvent.setup();
    const m = mockApi(base(c5(), { [`POST /api/cards/${CARD_ID}/prepare`]: prepared }));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const approve = screen.getByRole('button', { name: 'Sign off and approve M4' });
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject the onboarding' })).toBeDisabled();
    expect(screen.getByText(/Confirm your identity first/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I have read this readiness record/));
    expect(approve).toBeDisabled(); // the proof is still missing
    expect(sent(m, `/api/cards/${CARD_ID}/decide`)).toHaveLength(0);
  });

  it('step-up: starts bound to the record hash and returns to this card (redirect to the identity provider)', async () => {
    const user = userEvent.setup();
    const assigned: string[] = [];
    const real = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        assign: (u: string) => assigned.push(u),
        get pathname() {
          return real.pathname;
        },
        get search() {
          return real.search;
        },
        get origin() {
          return real.origin;
        },
      },
    });
    try {
      const m = mockApi(
        base(c5(), {
          [`POST /api/cards/${CARD_ID}/prepare`]: prepared,
          'POST /api/step-up': {
            json: {
              status: 'redirect',
              attempt_id: 'att-1',
              authorize_url: 'http://dev-oidc.localhost:8390/authorize?x=1',
            },
          },
        }),
      );
      renderAt(`/cards/${CARD_ID}`);
      await ready();
      await user.click(screen.getByRole('button', { name: 'Confirm my identity' }));
      await waitFor(() =>
        expect(assigned).toEqual(['http://dev-oidc.localhost:8390/authorize?x=1']),
      );
      const start = sent(m, '/api/step-up')[0];
      expect(start?.body).toEqual({ subject_hash: RECORD_HASH, return_to: `/cards/${CARD_ID}` });
      expect(start?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real });
    }
  });

  it('back from the identity provider: the proof is collected once, then approving sends it with the nonce', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      base(c5(), {
        [`POST /api/cards/${CARD_ID}/prepare`]: prepared,
        'GET /api/step-up/att-1': {
          json: { status: 'ready', method: 'reauth', proof: 'the-proof', bound_hash: RECORD_HASH },
        },
        [`POST /api/cards/${CARD_ID}/decide`]: {
          json: decided([
            receipt({ ledger_seq: 8, entry_type: 'card.step_decision', decision: 'approve' }),
            receipt({
              ledger_seq: 9,
              entry_hash: 'c3'.repeat(32),
              entry_type: 'decision',
              gate_id: 'M4',
              decision: 'approve',
            }),
          ]),
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}?step_up=att-1`);
    expect(await screen.findByTestId('stepup-ready')).toBeInTheDocument();
    expect(window.location.search).toBe(''); // the attempt id is not left in the address bar
    await ready();
    await user.click(screen.getByLabelText(/I have read this readiness record/));
    await user.click(screen.getByRole('button', { name: 'Sign off and approve M4' }));
    const box = await screen.findByTestId('receipt');
    expect(box).toHaveTextContent('#8');
    expect(box).toHaveTextContent('#9');
    expect(box).toHaveTextContent('M4: approved');
    expect(sent(m, '/api/step-up/att-1')).toHaveLength(1);
    expect(sent(m, `/api/cards/${CARD_ID}/decide`)[0]?.body).toEqual({
      nonce: 'gate-nonce',
      decision: 'approve',
      content: {},
      step_up: { proof: 'the-proof' },
    });
  });

  it('a proof that is refused asks for a new confirmation and drops the old proof', async () => {
    const user = userEvent.setup();
    mockApi(
      base(c5(), {
        [`POST /api/cards/${CARD_ID}/prepare`]: prepared,
        'GET /api/step-up/att-1': {
          json: { status: 'ready', method: 'reauth', proof: 'old', bound_hash: RECORD_HASH },
        },
        [`POST /api/cards/${CARD_ID}/decide`]: {
          status: 422,
          json: { error: { code: 'refused', message: 'refused: step_up_invalid: wrong binding' } },
        },
      }),
    );
    renderAt(`/cards/${CARD_ID}?step_up=att-1`);
    await screen.findByTestId('stepup-ready');
    await ready();
    await user.click(screen.getByLabelText(/I have read this readiness record/));
    await user.click(screen.getByRole('button', { name: 'Sign off and approve M4' }));
    expect(await screen.findByTestId('decide-problem')).toHaveTextContent('identity confirmation');
    expect(screen.getByRole('button', { name: 'Confirm my identity' })).toBeInTheDocument();
  });

  it('a T2 project with one M4 holder says nobody can sign yet', async () => {
    mockApi(
      base(
        c5({
          m4_deciders: {
            slot: 'm4',
            holders: ['alice'],
            single_operator: true,
            sod_waiver: false,
            tier: 'T2',
            t2: true,
            can_decide: false,
            error: null,
          } as never,
        }),
        { [`POST /api/cards/${CARD_ID}/prepare`]: prepared },
      ),
    );
    renderAt(`/cards/${CARD_ID}`);
    expect(await screen.findByText(/A T2 project needs two people here/)).toBeInTheDocument();
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
void S0_ID;

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
              gate: 'G5',
              slot: 'g5',
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
