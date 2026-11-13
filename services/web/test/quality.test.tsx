import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { evalRun } from './screenFixtures';

/** PLAN §7a: Quality is `quality.read` on the fleet. */
const AUDITOR = () => me(['quality.read']);

describe('quality: agents', () => {
  it('a direct link without quality.read (audit.read alone) is the 403 page and asks nothing of the API', async () => {
    const { calls } = mockApi({ 'GET /api/me': { json: me(['audit.read']) } });
    renderAt('/agents');
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
    expect(calls.map((c) => c.path)).not.toContain('/api/agents');
    expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull();
    expect(document.querySelector('[data-status="403"]')).toHaveTextContent('See Quality');
    for (const name of ['Evals', 'Models and routes', 'Integrations']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });
});

describe('quality: evaluations', () => {
  it('evals: the run history and the newest task results; gate results are marked not built', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/evals/runs?limit=50': { json: { runs: [evalRun({ errored: 1 })] } },
      'GET /api/evals/summary': {
        json: {
          rows: [
            {
              task_id: 't1',
              profile: 'default',
              suite: 'triage-core',
              provider: 'anthropic',
              trials: 3,
              passes: 2,
              pass_rate: 0.66,
              pass_k: 0.33,
              k: 3,
              status: 'flaky',
            },
          ],
        },
      },
    });
    renderAt('/evals');
    const runs = await screen.findByRole('table', { name: 'Eval runs' });
    expect(within(runs).getByText('92% (11/12, k=3)')).toBeInTheDocument();
    expect(within(runs).getByText('1')).toBeInTheDocument();
    const tasks = await screen.findByRole('table', { name: 'Tasks' });
    expect(within(tasks).getByText('flaky')).toBeInTheDocument();
    expect(screen.getByTestId('not-built')).toHaveTextContent('Gate results');
  });
});
