import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, projectOf, renderAt, repoOf, s0, S0_ID, type Call } from './helpers';

const AREAS = [
  {
    area: '.',
    level: 'full',
    floors: [
      { id: 'LF3', state: 'met', reason: null },
      { id: 'FF1', state: 'met', reason: null },
    ],
    lanes: ['L0', 'L1', 'L4', 'L8'],
  },
  {
    area: 'packages/docs',
    level: 'census',
    floors: [
      { id: 'LF3', state: 'unmet', reason: 'no test file in the area' },
      { id: 'FF1', state: 'met', reason: null },
    ],
    lanes: ['L7', 'L8'],
  },
];
const prr = {
  project_id: 'testbed',
  repos: [
    {
      repo: 'reshif/asf-factory-testbed',
      governing: {
        version: 2,
        status: 'active',
        effective_status: 'active',
        s0_id: S0_ID,
        proposed_at: '2026-11-08T10:00:00.000Z',
        activated_at: '2026-11-08T10:00:00.000Z',
        record: {
          level: {
            requested: 'full',
            signed: 'full',
            by_area: { '.': 'full', 'packages/docs': 'census' },
            areas: AREAS,
          },
          autonomy: { lanes_eligible: ['L7', 'L8'] },
        },
      },
      proposed: null,
    },
  ],
};
const allowView = (c: Call) => ({
  json: {
    decisions: (
      (c.body as { queries?: Array<{ action: string; resource: unknown }> }).queries ?? []
    ).map((q) => ({ ...q, allow: q.action === 'project.view', reasons: [] })),
  },
});

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

  it('settings: the per-area levels (DEC-25) of the active record, read under project.view', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allowView,
      'GET /api/projects/testbed': {
        json: { project: projectOf({ level: 'full' }), repos: [repoOf()], s0: [] },
      },
      'GET /api/projects/testbed/prr': { json: prr },
    });
    renderAt('/projects/testbed');
    const card = await screen.findByTestId('area-levels');
    expect(within(card).getByText(/never by\s+M1/)).toBeInTheDocument();
    expect(within(card).getByText(/level-up after a Light onboarding/)).toBeInTheDocument();
    const table = await within(card).findByRole('table', {
      name: 'Per-area levels of reshif/asf-factory-testbed',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('packages/docs');
    expect(rows[2]).toHaveTextContent('Census');
    expect(rows[2]).toHaveTextContent('LF3 unmet');
    expect(rows[2]).toHaveTextContent('no test file in the area');
    expect(rows[2]).toHaveTextContent('L7, L8');
  });

  it('settings: without project.view the per-area levels are not fetched or shown', async () => {
    const api = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/testbed': {
        json: { project: projectOf(), repos: [repoOf()], s0: [] },
      },
    });
    renderAt('/projects/testbed');
    expect(await screen.findByRole('heading', { level: 1, name: 'testbed' })).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Settings' });
    expect(screen.queryByTestId('area-levels')).toBeNull();
    expect(api.calls.some((c) => c.path === '/api/projects/testbed/prr')).toBe(false);
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
