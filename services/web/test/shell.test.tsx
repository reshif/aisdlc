import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, projectOf, renderAt, summaryOf } from './helpers';

const unauth = { status: 401, json: { error: { code: 'unauthenticated', message: 'no session' } } };

describe('the shell', () => {
  it('signed out: a sign-in link to the bff, and no API call but /api/me', async () => {
    const { calls } = mockApi({ 'GET /api/me': unauth });
    renderAt('/');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/auth/login');
    expect(calls.map((c) => c.path)).toEqual(['/api/me']);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('P2-18: signed out on a deep link, sign-in carries the asked path back', async () => {
    mockApi({ 'GET /api/me': unauth });
    renderAt('/config/gateway.models?x=1');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute(
      'href',
      `/auth/login?return_to=${encodeURIComponent('/config/gateway.models?x=1')}`,
    );
  });

  it('signed in: the principal name, the project list, and sign-out as a POST with the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects': { json: [summaryOf()] },
      'POST /api/logout': { json: { ok: true } },
    });
    renderAt('/projects');
    const list = await screen.findByRole('list', { name: 'Projects' });
    const row = within(list).getByRole('link', { name: 'testbed' });
    expect(row).toHaveAttribute('href', '/projects/testbed');
    // the person is the avatar menu: their name, My access, My notifications, sign-out
    const account = screen.getByRole('button', { name: 'Account: Alice Admin' });
    expect(account).toHaveAttribute('aria-expanded', 'false');
    await user.click(account);
    expect(account).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My access' })).toHaveAttribute('href', '/me/access');
    await user.keyboard('{Escape}');
    expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(account).toHaveFocus();

    // Once the session is gone the bff answers 401 to /api/me, and the shell goes back to sign-in.
    m.table['GET /api/me'] = unauth;
    await user.click(account);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('link', { name: 'Sign in' });
    const logout = m.calls.find((c) => c.path === '/api/logout');
    expect(logout?.method).toBe('POST');
    expect(logout?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('the project list shows repos, level, tier and the latest S0 status; an unsigned level reads "Not signed yet"', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects': {
        json: [
          summaryOf(),
          summaryOf({
            project: projectOf({
              project_id: 'signed',
              name: 'Signed one',
              level: 'light',
              tier: 'T1',
            }),
            latest_s0: null,
          }),
        ],
      },
    });
    renderAt('/projects');
    const list = await screen.findByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('listitem');
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('reshif/asf-factory-testbed')).toBeInTheDocument();
    expect(first.getByText('Waiting for a decision')).toBeInTheDocument();
    expect(first.getAllByText('Not signed yet')).toHaveLength(2);
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Light')).toBeInTheDocument();
    expect(second.getByText('T1')).toBeInTheDocument();
    expect(second.getByText('No onboarding')).toBeInTheDocument();
  });

  it('the onboard link is shown only to those the PDP lets onboard (cosmetic: the route decides)', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    await screen.findByText(/No projects yet/);
    expect(screen.queryByRole('link', { name: 'Onboard a repo' })).toBeNull();
  });

  it('an empty list invites the first onboarding for an admin', async () => {
    mockApi({ 'GET /api/me': { json: me() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    expect(await screen.findByRole('link', { name: 'Onboard the first repo.' })).toHaveAttribute(
      'href',
      '/onboard',
    );
  });

  it('a failed list is an alert with a retry, not a blank page', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'project.view denied' } },
      },
    });
    renderAt('/projects');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not allowed/);
    m.table['GET /api/projects'] = { json: [] };
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('is keyboard reachable: a skip link first, main landmark focusable, buttons and links in the tab order', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me() }, 'GET /api/projects': { json: [summaryOf()] } });
    renderAt('/projects');
    await screen.findByRole('list', { name: 'Projects' });
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'AISDLC home' })).toHaveFocus();
  });
});
