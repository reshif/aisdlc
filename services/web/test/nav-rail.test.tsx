import { ActionId } from '@aisdlc/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { me, mockApi, renderAt } from './helpers';

// The collapsible icon rail: the toggle and its remembered choice, a collapsed group's flyout (only what the
// person may open), the badge on the collapsed icon, and the group's pages as a tab bar over the content.

const KEY = 'aisdlc.nav.collapsed';

const admin = (): Me => ({
  ...me([...ActionId.options]),
  actions: { fleet: [...ActionId.options], projects: [] },
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
  it('the toggle collapses to a rail of group icons, expands again, and remembers the choice', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const toggle = await screen.findByRole('button', { name: 'Sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute(
      'aria-controls',
      screen.getByRole('navigation', { name: 'Main' }).id,
    );
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem(KEY)).toBe('1');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const g of ['Work', 'Projects', 'Run', 'Govern'])
      expect(within(nav).getByRole('button', { name: new RegExp(`^${g}`) })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull();
    await user.click(toggle);
    expect(window.localStorage.getItem(KEY)).toBe('0');
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('starts collapsed when the viewer collapsed it before', async () => {
    window.localStorage.setItem(KEY, '1');
    mockApi({ 'GET /api/me': { json: admin() }, ...routes() });
    renderAt('/');
    const toggle = await screen.findByRole('button', { name: 'Sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('a collapsed group opens a flyout of its pages, keeps the badge, and Escape closes it', async () => {
    window.localStorage.setItem(KEY, '1');
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
    ).toEqual(['Home', 'Inbox3 waiting on you', 'Items', 'Floor']);
    expect(within(fly).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Work' })).toBeNull();
    expect(work).toHaveFocus();
  });

  it('the flyout lists only what the person may open', async () => {
    window.localStorage.setItem(KEY, '1');
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
    window.localStorage.setItem(KEY, '1');
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

describe('the section tab bar', () => {
  it('shows the openable pages of the group, the current one marked', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, ...routes() });
    renderAt('/roles');
    const tabs = await screen.findByRole('navigation', { name: 'Govern pages' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Settings', 'People, teams & roles']);
    expect(within(tabs).getByRole('link', { name: 'People, teams & roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the exact page and is absent on Work', async () => {
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
});
