import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { SHA_A, SHA_B } from './screenFixtures';

describe('govern: catalogue', () => {
  it('catalogue: every release, the current one marked, its lanes with their gates', async () => {
    const user = userEvent.setup();
    const lanes = [
      {
        lane: 'L3',
        label: 'small change',
        enter_at: '2.1',
        stages: ['S2', 'S6', 'S7'],
        gates: [{ gate: 'G4', step: '7.6', presence: 'required' }],
      },
    ];
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/catalogue': {
        json: {
          versions: [
            { ref: { version: '1.2.0', hash: SHA_A }, current: false, pinned_items: 4, lanes: [] },
            { ref: { version: '1.3.0', hash: SHA_B }, current: true, pinned_items: 7, lanes },
          ],
        },
      },
    });
    renderAt('/catalogue');
    const rel = await screen.findByRole('table', { name: 'Catalogue releases' });
    const rows = within(rel).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('new items pin this');
    expect(rows[0]).toHaveTextContent('7');
    expect(screen.getByRole('table', { name: 'Lanes of catalogue 1.3.0' })).toHaveTextContent(
      'S2 → S6 → S7',
    );
    await user.click(within(rel).getByRole('button', { name: '1.2.0' }));
    expect(await screen.findByText(/did not verify against its pin/)).toBeInTheDocument();
  });
});
