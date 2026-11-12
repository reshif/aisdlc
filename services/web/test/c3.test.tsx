import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_HASH, EVIDENCE, c3View, decided, detail } from './cardFixtures';
import { CARD_ID, me, mockApi, renderAt } from './helpers';

// Card 3 (PLAN M17): the code map, the seeds to affirm, correct or keep observed, the exam to grade (measured,
// never a gate), the golden-task candidates after the exclusion manifest, the oracle-lock proposal and the
// interview; approving sends exactly what the person chose, bound to the baseline hash.

const routes = (extra: Record<string, unknown> = {}, view = c3View()) => ({
  'GET /api/me': { json: me() },
  [`GET /api/cards/${CARD_ID}`]: { json: detail('C3', view) },
  [`POST /api/cards/${CARD_ID}/prepare`]: {
    json: {
      nonce: 'nonce-3',
      expires_at: '2026-11-08T10:15:00.000Z',
      evidence_hash: EVIDENCE,
      step_up: null,
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
  const seedRoot = screen.getByRole('region', { name: 'Seed for . (repository root)' });
  await user.click(within(seedRoot).getByLabelText('Keep it as observed'));
  const seedMoney = screen.getByRole('region', { name: 'Seed for packages/money' });
  await user.click(within(seedMoney).getByLabelText('Wrong: I correct it'));
  await user.type(
    screen.getByLabelText('What packages/money is meant to do'),
    'It keeps the ledger balanced.',
  );
  for (const r of screen.getAllByLabelText('Incorrect')) await user.click(r);
  await user.click(screen.getByLabelText('Use as a golden task'));
  for (const q of [
    'For each part of the repository, what is it for, in a sentence?',
    'Which behaviours are contractual: callers outside this repository rely on them?',
    'Which invariants must every change keep (data, ordering, idempotence, security)?',
  ]) {
    await user.type(screen.getByLabelText(q), 'an answer');
  }
}

describe('card 3', { timeout: 20_000 }, () => {
  it('shows the areas, FF1, the seeds, the exam, the golden candidates and the oracle-lock proposal', async () => {
    mockApi(routes());
    renderAt(`/cards/${CARD_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Card 3: the Full baseline, seeds and exam' }),
    ).toBeInTheDocument();
    const areas = screen.getByRole('table', { name: 'Areas of the repository' });
    expect(areas).toHaveTextContent('packages/money');
    expect(areas).toHaveTextContent('. (repository root)');
    expect(screen.getByRole('list', { name: 'The code map' })).toHaveTextContent('FF1met');
    expect(screen.getByText(/the score is measured, never a gate/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Golden-task candidates' })).toHaveTextContent(
      'packages/money/test/ledger.test.ts',
    );
    expect(
      screen.getByText(/reaches the repository only through an X2 decision/),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Excluded from the harvest' })).toHaveTextContent(
      '.github/workflows/ci.yml: protected path',
    );
  });

  it('approve stays off until every seed, grade, candidate and answer is in; FF1 unmet says why', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    const approve = screen.getByRole('button', { name: 'Affirm the Full baseline' });
    expect(approve).toBeDisabled();
    expect(screen.getByText('Grade every exam answer.')).toBeInTheDocument();
    expect(screen.getByText('Decide every seed.')).toBeInTheDocument();
    await fillAll(user);
    expect(screen.queryByText('Decide every seed.')).toBeNull();
    expect(approve).toBeEnabled();
    expect(m.calls.filter((c) => c.path.endsWith('/decide'))).toHaveLength(0);
  });

  it('a baseline that misses FF1 cannot be affirmed', async () => {
    mockApi(routes({}, c3View({ ff1: { state: 'unmet', reasons: ['code_graph_truncated'] } })));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    expect(screen.getByText(/FF1 is not met \(code_graph_truncated\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Affirm the Full baseline' })).toBeDisabled();
  });

  it('approving sends the choices bound to the baseline hash, with no step-up', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes({ [`POST /api/cards/${CARD_ID}/decide`]: { json: decided() } }));
    renderAt(`/cards/${CARD_ID}`);
    await ready();
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: 'Affirm the Full baseline' }));
    await screen.findByTestId('receipt');
    const body = m.calls.find((c) => c.path === `/api/cards/${CARD_ID}/decide`)?.body as {
      content: Record<string, unknown>;
      step_up?: unknown;
    };
    expect(body.step_up).toBeUndefined();
    expect(body.content).toEqual({
      baseline_hash: BASELINE_HASH,
      intent_answers: [
        { question_id: 'full-01', answer: 'an answer' },
        { question_id: 'full-02', answer: 'an answer' },
        { question_id: 'full-03', answer: 'an answer' },
      ],
      exam: [
        { question_id: 'exam-01', grade: 'incorrect' },
        { question_id: 'exam-02', grade: 'incorrect' },
      ],
      seeds: [
        { seed_id: 'seed-0000000000000001', verdict: 'keep_observed' },
        {
          seed_id: 'seed-0000000000000002',
          verdict: 'correct',
          correction: 'It keeps the ledger balanced.',
        },
      ],
      golden: [{ candidate_id: 'gt-0000000000000001', verdict: 'accept' }],
    });
  });
});
