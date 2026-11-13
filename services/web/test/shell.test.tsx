import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leave } from '../src/leave';
import { me, mockApi, projectOf, renderAt, summaryOf } from './helpers';

// jsdom does not navigate: the portal's one way out of the document is watched instead
vi.mock('../src/leave', () => ({ leave: vi.fn() }));
const left = vi.mocked(leave);

const unauth = { status: 401, json: { error: { code: 'unauthenticated', message: 'no session' } } };

describe('the shell', () => {
  beforeEach(() => left.mockClear());

  it('signed out: straight to the bff sign-in (no page of its own), and no API call but /api/me', async () => {
    const { calls } = mockApi({ 'GET /api/me': unauth });
    renderAt('/');
    await waitFor(() => expect(left).toHaveBeenCalledWith('/auth/login', 'replace'));
    // the fallback while the browser leaves
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login');
    expect(screen.queryByText(/governed lifecycle/)).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/api/me']);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('P2-18: signed out on a deep link, sign-in carries the asked path back', async () => {
    mockApi({ 'GET /api/me': unauth });
    renderAt('/config/gateway.models?x=1');
    const want = `/auth/login?return_to=${encodeURIComponent('/config/gateway.models?x=1')}`;
    await waitFor(() => expect(left).toHaveBeenCalledWith(want, 'replace'));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', want);
  });

  it("sign-out goes to the identity provider's logout when the bff names one", async () => {
    const user = userEvent.setup();
    const idpLogout = 'http://idp.test/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%2F';
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects': { json: [summaryOf()] },
      'POST /api/logout': { json: { ok: true, redirect: idpLogout } },
    });
    renderAt('/projects');
    await user.click(await screen.findByRole('button', { name: 'Account: Alice Admin' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(left).toHaveBeenCalledWith(idpLogout));
    // not also to the sign-in: the IdP sends the browser back to the portal, which goes there itself
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('signed in: the principal name, the project list, and sign-out as a POST with the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects': { json: [summaryOf()] },
      'POST /api/logout': { json: { ok: true, redirect: null } },
    });
    renderAt('/projects');
    const list = await screen.findByRole('table', { name: 'Projects' });
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

    // Once the session is gone the bff answers 401 to /api/me; with no IdP logout the shell goes to sign-in itself.
    m.table['GET /api/me'] = unauth;
    await user.click(account);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    // (back to the page it was on once signed in again)
    await waitFor(() =>
      expect(left).toHaveBeenCalledWith(
        `/auth/login?return_to=${encodeURIComponent('/projects')}`,
        'replace',
      ),
    );
    const logout = m.calls.find((c) => c.path === '/api/logout');
    expect(logout?.method).toBe('POST');
    expect(logout?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('the project list shows repo, level and risk in plain words; an unsigned risk reads "Not signed yet"', async () => {
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
    const list = await screen.findByRole('table', { name: 'Projects' });
    const rows = within(list).getAllByRole('row').slice(1);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('reshif/asf-factory-testbed')).toBeInTheDocument();
    expect(first.getByText('Not signed yet')).toBeInTheDocument();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Small changes')).toBeInTheDocument();
    expect(second.getByText('Standard risk')).toBeInTheDocument();
    expect(second.getByText('None')).toBeInTheDocument();
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
    await screen.findByText('No projects yet');
    for (const l of screen.getAllByRole('link', { name: 'Onboard a repo' })) {
      expect(l).toHaveAttribute('href', '/onboard');
    }
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
    await screen.findByRole('table', { name: 'Projects' });
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
