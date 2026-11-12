import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LevelValues } from '@aisdlc/contracts';
import { me, mockApi, renderAt, S0_ID, s0 } from './helpers';

const base = () => ({
  'GET /api/me': { json: me() },
  'GET /api/projects': { json: [] },
  [`GET /api/s0/${S0_ID}`]: {
    json: s0({ status: 'app', waiting: '0.1 waiting: App not installed' }),
  },
  [`GET /api/s0/${S0_ID}/cards`]: { json: [] },
  'GET /api/projects/testbed': { json: { project: { project_id: 'testbed' }, repos: [], s0: [] } },
});

describe('Onboard a repo', () => {
  it('explains each level in plain words, from the contracts level list, Census first', async () => {
    mockApi(base());
    renderAt('/onboard');
    const group = await screen.findByRole('group', { name: 'Level to ask for' });
    const radios = Array.from(group.querySelectorAll('input[type=radio]')).map(
      (r) => (r as HTMLInputElement).value,
    );
    expect(radios).toEqual([...LevelValues]);
    expect(screen.getByLabelText('Census')).toBeChecked();
    expect(
      screen.getByText('The factory understands the repo; people do the work.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Agents may do small work (L1 to L3).')).toBeInTheDocument();
    expect(screen.getByText('Agents may do features (L4 to L6).')).toBeInTheDocument();
    expect(screen.getByLabelText('Light')).toHaveAccessibleDescription(
      'Agents may do small work (L1 to L3).',
    );
    // user decision 2026-11-12: Full is only a level-up of a Light repo, never asked for here
    expect(screen.getByLabelText('Full')).toBeDisabled();
    expect(screen.getByTestId('full-only-level-up')).toHaveTextContent(/only as a level-up/);
  });

  it('posts repo, level, slug and the raise-only attestations (no principal), then opens the S0 page', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      ...base(),
      'POST /api/onboard': { status: 201, json: { s0_id: S0_ID, duplicate: false } },
    });
    renderAt('/onboard');
    await user.type(await screen.findByLabelText('Repository owner'), 'reshif');
    await user.type(screen.getByLabelText('Repository name'), 'Asf-Factory-Testbed');
    // The slug follows the repo name until the person edits it.
    expect(screen.getByLabelText('Project slug')).toHaveValue('asf-factory-testbed');
    await user.clear(screen.getByLabelText('Project slug'));
    await user.type(screen.getByLabelText('Project slug'), 'testbed');
    await user.click(screen.getByLabelText('Light'));
    await user.click(screen.getByLabelText('The project deploys'));
    await user.selectOptions(screen.getByLabelText('Lowest tier to start from'), 'T2');
    await user.click(screen.getByRole('button', { name: 'Request onboarding' }));

    await screen.findByRole('heading', { level: 1, name: /Onboarding of/ });
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/onboard');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(post?.body).toEqual({
      project_id: 'testbed',
      repo: 'reshif/Asf-Factory-Testbed',
      level: 'light',
      attestations: { deploys: true, tier_floor: 'T2' },
    });
    expect(window.location.pathname).toBe(`/s0/${S0_ID}`);
  });

  it('offers no way to lower risk: no T0, no "internal", no "does not deploy"', async () => {
    mockApi(base());
    renderAt('/onboard');
    const tier = await screen.findByLabelText('Lowest tier to start from');
    expect(Array.from(tier.querySelectorAll('option')).map((o) => o.value)).toEqual([
      '',
      'T1',
      'T2',
    ]);
    expect(screen.queryByText(/internal/i)).toBeNull();
  });

  it('checks the fields before it asks, and says what is wrong in an alert', async () => {
    const user = userEvent.setup();
    const m = mockApi(base());
    renderAt('/onboard');
    await user.click(await screen.findByRole('button', { name: 'Request onboarding' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Repository owner');
    expect(alert).toHaveTextContent('Repository name');
    expect(alert).toHaveTextContent('Project slug');
    expect(m.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the factory refusal and stays on the form', async () => {
    const user = userEvent.setup();
    mockApi({
      ...base(),
      'POST /api/onboard': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'project.onboard denied' } },
      },
    });
    renderAt('/onboard');
    await user.type(await screen.findByLabelText('Repository owner'), 'reshif');
    await user.type(screen.getByLabelText('Repository name'), 'testbed');
    await user.click(screen.getByRole('button', { name: 'Request onboarding' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not allowed/));
    expect(window.location.pathname).toBe('/onboard');
    expect(screen.getByRole('button', { name: 'Request onboarding' })).toBeEnabled();
  });

  it('tells a person without the onboard right, and still lets the server decide', async () => {
    mockApi({ ...base(), 'GET /api/me': { json: me([]) } });
    renderAt('/onboard');
    expect(await screen.findByRole('note')).toHaveTextContent(/does not currently hold the right/);
    expect(screen.getByRole('button', { name: 'Request onboarding' })).toBeEnabled();
  });
});
