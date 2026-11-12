import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOUND_HASH,
  EVIDENCE,
  PROPOSAL_HASH,
  TEXT_HASH,
  c2View,
  decided,
  detail,
} from './cardFixtures';
import { CARD_ID, me, mockApi, renderAt } from './helpers';

// Card 2 (PLAN M16): the claims, the questions, each instruction file as the factory template read
// it, the edit, and an approval that carries the step-up proof bound to the affirmed text hashes.

const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /api/me': { json: me() },
  [`GET /api/cards/${CARD_ID}`]: { json: detail('C2', c2View()) },
  [`POST /api/cards/${CARD_ID}/prepare`]: {
    json: {
      nonce: 'nonce-2',
      expires_at: '2026-11-08T10:15:00.000Z',
      evidence_hash: EVIDENCE,
      step_up: { required: true, bound_hash: BOUND_HASH },
    },
  },
  [`POST /api/cards/${CARD_ID}/evidence`]: { json: { evidence_viewed: true } },
  ...extra,
});

const ready = async () => {
  await screen.findByRole('region', { name: 'Decision' });
  await waitFor(() => expect(screen.queryByText(/Getting the decision form ready/)).toBeNull());
};

afterEach(() => sessionStorage.clear());

async function fillAll(user: ReturnType<typeof userEvent.setup>) {
  for (const r of screen.getAllByLabelText('True')) await user.click(r);
  for (const q of [
    'What is this repository for, in one or two sentences?',
    'Who uses what it builds, and how many people depend on it?',
    'How do you review a change before you merge it?',
  ]) {
    await user.type(screen.getByLabelText(q), 'an answer');
  }
  await user.click(screen.getByLabelText(/These answers describe how this repository/));
}

describe('card 2', { timeout: 20_000 }, () => {
  it('shows each section as taken, never taken with why, or drafted, and the proposed text', async () => {
    mockApi(routes());
    renderAt(`/cards/${CARD_ID}`);
    const table = await screen.findByRole('table', { name: 'Sections of AGENTS.md' });
    expect(table).toHaveTextContent('Commands1–3accepted');
    expect(table).toHaveTextContent('grants or names tools');
    expect(table).toHaveTextContent('Boundaries5–8drafted');
    expect(screen.getByLabelText('Proposed text of AGENTS.md')).toHaveTextContent('npm test');
    expect(screen.getByText('can be affirmed')).toBeInTheDocument();
    expect(screen.getByText(/guidance, never as instructions/)).toBeInTheDocument();
  });

  it('approve stays off until every claim, question and the attestation are in; nothing is sent meanwhile', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const approve = screen.getByRole('button', { name: 'Affirm (with the step-up)' });
    expect(approve).toBeDisabled();
    expect(screen.getByText('Give every claim a verdict.')).toBeInTheDocument();
    await fillAll(user);
    expect(screen.queryByText('Give every claim a verdict.')).toBeNull();
    expect(approve).toBeDisabled(); // the step-up proof is still missing
    expect(m.calls.filter((c) => c.path.endsWith('/decide'))).toHaveLength(0);
  });

  it('back from the step-up, approving sends the content bound to the proposal and the text hash', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes({
        'GET /api/step-up/att-2': {
          json: { status: 'ready', method: 'reauth', proof: 'proof-2', bound_hash: BOUND_HASH },
        },
        [`POST /api/cards/${CARD_ID}/decide`]: { json: decided() },
      }),
    );
    renderAt(`/cards/${CARD_ID}?step_up=att-2`);
    expect(await screen.findByTestId('stepup-ready')).toBeInTheDocument();
    await ready();
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: 'Affirm (with the step-up)' }));
    await screen.findByTestId('receipt');
    const body = m.calls.find((c) => c.path === `/api/cards/${CARD_ID}/decide`)?.body as {
      content: Record<string, unknown>;
      step_up: unknown;
    };
    expect(body.step_up).toEqual({ proof: 'proof-2' });
    expect(body.content).toMatchObject({
      proposal_hash: PROPOSAL_HASH,
      claims: [
        { claim_id: 'cl-0000000000000001', verdict: 'affirm' },
        { claim_id: 'cl-0000000000000002', verdict: 'affirm' },
      ],
      practices: { attested: true },
      instructions: [{ path: 'AGENTS.md', text_sha256: TEXT_HASH }],
    });
  });

  it('an edit is sent with the text hash it replaces', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes({
        [`POST /api/cards/${CARD_ID}/instructions`]: { json: detail('C2', c2View()) },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Edit the text' }));
    const box = screen.getByLabelText('Your text for AGENTS.md');
    await user.clear(box);
    await user.type(box, '# app');
    await user.click(screen.getByRole('button', { name: 'Save this text' }));
    await waitFor(() =>
      expect(m.calls.filter((c) => c.path === `/api/cards/${CARD_ID}/instructions`)).toHaveLength(
        1,
      ),
    );
    const call = m.calls.find((c) => c.path === `/api/cards/${CARD_ID}/instructions`);
    expect(call?.body).toEqual({ path: 'AGENTS.md', text: '# app', base_text_sha256: TEXT_HASH });
  });

  it('shows LF3, LF4 and LF8 at the census head; a probe that ran nothing can be asked for again', async () => {
    const probe = {
      lf3: { state: 'unknown', reasons: ['probe_not_run'] },
      lf4: { state: 'unknown', reasons: ['isolation_test_not_run_for_worker_image'] },
      lf8: { state: 'met', reasons: [] },
      result: {
        outcome: 'not_allowed',
        detail: 'acme/app is not on the owner allow-list (DEC-18): its code does not run',
        tests: { total: null },
        recorded_at: '2026-11-12T10:00:00.000Z',
      },
    };
    const user = userEvent.setup();
    const m = mockApi(
      routes({
        [`GET /api/cards/${CARD_ID}`]: { json: detail('C2', c2View({ probe })) },
        [`POST /api/cards/${CARD_ID}/probe/retry`]: { json: { requested: true, probe_id: null } },
      }),
    );
    renderAt(`/cards/${CARD_ID}`);
    const table = await screen.findByRole('table', { name: 'Light floors' });
    expect(table).toHaveTextContent('LF3');
    expect(table).toHaveTextContent('probe_not_run');
    expect(table).toHaveTextContent('isolation_test_not_run_for_worker_image');
    expect(table).toHaveTextContent('LF8');
    expect(screen.getByText(/The probe: not_allowed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run the probe again' }));
    await screen.findByRole('button', { name: /Asked: the probe runs again/ });
    expect(m.calls.filter((c) => c.path === `/api/cards/${CARD_ID}/probe/retry`)).toHaveLength(1);
    // the approval stays blocked while LF3 is not met
    expect(screen.getByText(/LF3 is not met/)).toBeInTheDocument();
  });

  it('a probe that ran offers no retry (one run is final for its head)', async () => {
    const probe = {
      lf3: { state: 'unmet', reasons: ['probe_failed'] },
      lf4: { state: 'met', reasons: [] },
      lf8: { state: 'met', reasons: [] },
      result: {
        outcome: 'failed',
        detail: null,
        tests: { total: 3 },
        recorded_at: '2026-11-12T10:00:00.000Z',
      },
    };
    mockApi(routes({ [`GET /api/cards/${CARD_ID}`]: { json: detail('C2', c2View({ probe })) } }));
    renderAt(`/cards/${CARD_ID}`);
    await screen.findByRole('table', { name: 'Light floors' });
    expect(screen.queryByRole('button', { name: 'Run the probe again' })).toBeNull();
  });
});
