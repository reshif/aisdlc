import { ActionId } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { me, mockApi, renderAt } from './helpers';

// The shell's navigation: a rail of group icons that is collapsed until the person expands it (the toggle at the
// top, the choice remembered), a collapsed group's flyout (only what the person may open), the count on the
// collapsed icon, the section's pages and sub-pages as tabs in the page header with the breadcrumb, and the
// command palette over the same pages.

const KEY = 'aisdlc.nav.collapsed';

const admin = (): Me => ({
  ...me([...ActionId.options]),
  actions: {
    fleet: [...ActionId.options],
    projects: [{ project_id: 'payments-api', actions: ['floor.read'] }],
  },
});

const routes = () => ({
  'GET /api/inbox': { json: { decide: [{ id: 1 }, { id: 2 }, { id: 3 }], view: [] } },
  'GET /api/kills': { json: { observed_head: 0, journal: [] } },
});

beforeEach(() => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* none */
  }
});

describe('the collapsible navigation', () => {
  it('is collapsed by default; the toggle expands it, collapses it again, and remembers the choice', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const toggle = within(nav).getByRole('button', { name: 'Sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', nav.id);
    // the toggle is the first control of the rail, above the groups
    expect(nav.firstElementChild).toBe(toggle);
    for (const g of ['Work', 'Projects', 'Run', 'Govern'])
      expect(within(nav).getByRole('button', { name: new RegExp(`^${g}`) })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(window.localStorage.getItem(KEY)).toBe('0');
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    // expanded it is two levels: a heading per group, the pages under it, no sub-pages
    for (const g of ['Work', 'Projects', 'Run', 'Govern'])
      expect(within(nav).getByRole('heading', { name: g })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Evaluations' })).toBeNull();
    await user.click(toggle);
    expect(window.localStorage.getItem(KEY)).toBe('1');
    expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull();
  });

  it('starts expanded when the viewer expanded it before', async () => {
    window.localStorage.setItem(KEY, '0');
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const toggle = await screen.findByRole('button', { name: 'Sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('a collapsed group opens a flyout of its pages, keeps the count, and Escape closes it', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const work = await screen.findByRole('button', { name: /^Work/ });
    expect(await screen.findByRole('button', { name: 'Work, 3 waiting on you' })).toBe(work);
    expect(work).toHaveAttribute('aria-expanded', 'false');
    await user.click(work);
    expect(work).toHaveAttribute('aria-expanded', 'true');
    const fly = screen.getByRole('list', { name: 'Work' });
    expect(
      within(fly)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Inbox 3 waiting on you', 'Items', 'Floor']);
    expect(within(fly).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Work' })).toBeNull();
    expect(work).toHaveFocus();
  });

  it('the flyout lists only what the person may open', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me([]) }, ...routes() });
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: /^Govern/ }));
    const fly = screen.getByRole('list', { name: 'Govern' });
    expect(
      within(fly)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Settings', 'People, teams & roles']);
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull();
  });

  it('opens a flyout with the arrow key from the icon and moves with the arrows', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const run = await screen.findByRole('button', { name: /^Run/ });
    run.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Operate' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveFocus();
  });
});

describe('the page header: breadcrumb and section tabs', () => {
  it('shows the openable pages of the group as tabs, the current one marked, with the trail above', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, ...routes() });
    renderAt('/roles');
    const tabs = await screen.findByRole('navigation', { name: 'Govern pages' });
    // Settings is not theirs, so the section points at its first page they may open (Tracks and limits);
    // then the sub-pages of People, teams & roles they may open
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Tracks and limits', 'Roles', 'Access requests']);
    expect(within(tabs).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const trail = screen.getByRole('navigation', { name: 'Location' });
    expect(trail).toHaveTextContent('Govern');
    expect(within(trail).getByText('Roles')).toHaveAttribute('aria-current', 'page');
  });

  it('puts a sub-page in the tabs after its page, never in the sidebar: Run is Operate, Agents, Evaluations', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEY, '0');
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/evals');
    const tabs = await screen.findByRole('navigation', { name: 'Run pages' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Operate', 'Agents', 'Evaluations']);
    expect(within(tabs).getByRole('link', { name: 'Evaluations' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Evaluations' })).toBeNull();
    // Agents, the page Evaluations belongs to, is "here" in the sidebar
    expect(within(nav).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(tabs).getByRole('link', { name: 'Agents' }));
    expect(window.location.pathname).toBe('/agents');
  });

  it('marks the exact page', async () => {
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/integrations');
    const tabs = await screen.findByRole('navigation', { name: 'Govern pages' });
    expect(within(tabs).getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Settings' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('a page of the person’s own has the trail and no tabs', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, ...routes() });
    renderAt('/me/access');
    const trail = await screen.findByRole('navigation', { name: 'Location' });
    expect(trail).toHaveTextContent('My access');
    expect(screen.queryByRole('navigation', { name: /pages$/ })).toBeNull();
  });
});

describe('the command palette over the navigation', () => {
  it('Ctrl-K opens it with the pages and projects the person may open, under their headings', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me([]) }, ...routes() });
    renderAt('/');
    await screen.findByRole('button', { name: 'Search pages and projects' });
    await user.keyboard('{Control>}k{/Control}');
    const box = screen.getByRole('combobox', { name: 'Search' });
    expect(box).toHaveFocus();
    const pages = screen.getByRole('group', { name: 'Pages' });
    const names = within(pages)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    // a person with no actions: no Operate, no Integrations, no Decision log; Home is theirs
    expect(names.some((n) => n.startsWith('Home'))).toBe(true);
    expect(names.some((n) => n.startsWith('Operate'))).toBe(false);
    expect(names.some((n) => n.startsWith('Integrations'))).toBe(false);
    expect(names.some((n) => n.startsWith('Decision log'))).toBe(false);
    // each page names its section
    expect(names.find((n) => n.startsWith('Home'))).toBe('HomeWork');
  });

  it('opens the page with the arrows and Enter; Escape closes it and gives the focus back', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const button = await screen.findByRole('button', { name: 'Search pages and projects' });
    await user.click(button);
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'evalu');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.pathname).toBe('/evals'));
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: 'Search' })).toBeNull();
    expect(button).toHaveFocus();
  });
});
