import { ActionId, label } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { mayOpenDesign } from '../src/shell/Shell';
import { flatNav, navFor } from '../src/shell/nav';
import { me, mockApi, renderAt } from './helpers';

// The v2 shell over every route: the screen map's nav groups with the glossary's words, the top bar (project
// switcher, ⌘K search, emergency-stop state, the person), and the /design review page.

const everything = (): Me => ({
  ...me([...ActionId.options]),
  actions: {
    fleet: [...ActionId.options],
    projects: [{ project_id: 'payments-api', actions: ['project.view', 'work.request'] }],
  },
});

describe('the v2 navigation', () => {
  it('follows the screen map: Work, Projects, Run, Govern, with the glossary labels', () => {
    const groups = navFor(everything());
    expect(groups.map((g) => g.label)).toEqual(['Work', 'Projects', 'Run', 'Govern']);
    expect(groups.map((g) => g.entries.map((e) => e.label))).toEqual([
      ['Home', 'Inbox', 'Items', 'Floor'],
      ['Projects', 'Onboard a repo'],
      ['Operate', 'Agents'],
      ['Settings', 'Integrations', 'People, teams & roles', 'Decision log & audit'],
    ]);
    for (const e of flatNav()) expect(e.label).toBe(label('screen', e.id));
  });

  it('every existing screen has one place: no path is listed twice', () => {
    const paths = flatNav().map((e) => e.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(
      expect.arrayContaining(['/kill', '/controls', '/scheduler', '/sandboxes', '/health']),
    );
  });

  it('a section links to the first page under it the person may open', () => {
    const viewer = me([]);
    const govern = navFor(viewer).find((g) => g.group === 'govern');
    expect(govern?.entries.map((e) => [e.label, e.to])).toEqual([
      ['Settings', '/catalogue'],
      ['People, teams & roles', '/roles'],
    ]);
  });

  it('signed in as the factory admin: the groups, the inbox count, Operate opens its pages', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: everything() },
      'GET /api/inbox': {
        json: { decide: [{ id: 1 }, { id: 2 }], view: [] },
      },
      'GET /api/kills': { json: { observed_head: 0, journal: [] } },
    });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(
      await within(nav).findByRole('link', { name: 'Inbox 2 waiting on you' }),
    ).toBeInTheDocument();
    for (const h of ['Work', 'Projects', 'Run', 'Govern'])
      expect(within(nav).getByRole('heading', { name: h })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Health' })).toBeNull();
    await user.click(within(nav).getByRole('link', { name: 'Operate' }));
    expect(window.location.pathname).toBe('/kill');
    expect(within(nav).getByRole('link', { name: 'Emergency stop' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Health' })).toHaveAttribute('href', '/health');
  });
});

describe('the v2 top bar', () => {
  it('the emergency stop: running, stopped (with a banner) or unknown, only for ops readers', async () => {
    const m = mockApi({
      'GET /api/me': { json: me(['ops.read']) },
      'GET /api/projects': { json: [] },
    });
    const v = renderAt('/projects');
    expect(await screen.findByRole('link', { name: 'Agents running' })).toHaveAttribute(
      'href',
      '/kill',
    );
    v.unmount();
    m.table['GET /api/kills/active'] = { json: { kills: [{ kill_id: 'k1' }] } };
    const w = renderAt('/projects');
    expect(await screen.findByRole('link', { name: 'Agents stopped: 1' })).toBeInTheDocument();
    expect(screen.getByText(/An emergency stop is on/)).toBeInTheDocument();
    w.unmount();
    m.table['GET /api/kills/active'] = {
      status: 503,
      json: { error: { code: 'unavailable', message: 'down' } },
    };
    renderAt('/projects');
    expect(
      await screen.findByRole('link', { name: 'Emergency stop: unknown' }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('no ops.read: no pill and no call for it; no kill.request: no Stop agents', async () => {
    const m = mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    await screen.findByRole('button', { name: 'Account: Alice Admin' });
    expect(screen.queryByRole('link', { name: /Agents running/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Stop agents' })).toBeNull();
    expect(m.calls.some((c) => c.path === '/api/kills/active')).toBe(false);
  });

  it('Stop agents and Ask for work show for those who may', async () => {
    mockApi({ 'GET /api/me': { json: everything() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    expect(await screen.findByRole('link', { name: 'Stop agents' })).toHaveAttribute(
      'href',
      '/kill',
    );
    expect(screen.getByRole('link', { name: 'Ask for work' })).toHaveAttribute(
      'href',
      '/ask-for-work',
    );
    expect(screen.getByRole('link', { name: 'My notifications' })).toHaveAttribute(
      'href',
      '/me/notifications',
    );
  });

  it('⌘K opens the search; it finds a screen the person may open and goes there', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: everything() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    await screen.findByRole('button', { name: 'Account: Alice Admin' });
    await user.keyboard('{Control>}k{/Control}');
    const box = screen.getByRole('combobox', { name: 'Search' });
    await user.type(box, 'decision log');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.pathname).toBe('/ledger'));
    expect(screen.queryByRole('combobox', { name: 'Search' })).toBeNull();
  });

  it('the project switcher lists the projects the person has', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: everything() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    await user.click(await screen.findByRole('button', { name: 'Choose a project' }));
    expect(screen.getByRole('link', { name: 'payments-api' })).toHaveAttribute(
      'href',
      '/projects/payments-api',
    );
    expect(screen.getByRole('link', { name: 'All projects' })).toHaveAttribute('href', '/projects');
  });
});

describe('/design', () => {
  it('a factory admin, or a dev build; nobody else', () => {
    expect(mayOpenDesign(false, ['factory.admin'])).toBe(true);
    expect(mayOpenDesign(false, ['factory.auditor'])).toBe(false);
    expect(mayOpenDesign(false, undefined)).toBe(false);
    expect(mayOpenDesign(true, [])).toBe(true);
  });

  it('shows every component in both themes, and one theme on request', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/design');
    const dark = await screen.findByRole('region', { name: 'Dark theme' });
    const light = screen.getByRole('region', { name: 'Light theme' });
    expect(dark).toHaveAttribute('data-theme', 'dark');
    expect(light).toHaveAttribute('data-theme', 'light');
    for (const h of [
      'Needs you',
      'Stage strip',
      'Evidence and the decision rail',
      'Properties panel',
      'Scorecard',
      'Stepper',
      'Secret field and delete',
      'Empty and error states',
    ])
      expect(within(light).getByRole('heading', { name: h, level: 2 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.queryByRole('region', { name: 'Dark theme' })).toBeNull();
  });
});
