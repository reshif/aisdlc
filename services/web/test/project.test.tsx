import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, projectOf, renderAt, repoOf, s0, S0_ID } from './helpers';

describe('project detail', () => {
  it('shows repos, level, tier and the onboarding records with links to them', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed': {
        json: {
          project: projectOf({ level: 'census', tier: 'T1' }),
          repos: [{ ...repoOf(), onboarding_level: 'census' }],
          s0: [s0({ status: 'card', states: { '0.1': 'card' } })],
        },
      },
    });
    renderAt('/projects/testbed');
    expect(await screen.findByRole('heading', { level: 1, name: 'testbed' })).toBeInTheDocument();
    const repos = screen.getByRole('list', { name: 'Repos' });
    expect(within(repos).getByText('reshif/asf-factory-testbed')).toBeInTheDocument();
    expect(within(repos).getByText(/signed level: Census/)).toBeInTheDocument();
    expect(screen.getByText('T1')).toBeInTheDocument();
    const records = screen.getByRole('list', { name: 'Onboarding records' });
    expect(within(records).getByRole('link', { name: /Census onboarding/ })).toHaveAttribute(
      'href',
      `/s0/${S0_ID}`,
    );
    expect(within(records).getByText('Waiting for a decision')).toBeInTheDocument();
  });

  it('a project the person may not view is a plain refusal', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/secret': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'project.view denied' } },
      },
    });
    renderAt('/projects/secret');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/);
  });
});
