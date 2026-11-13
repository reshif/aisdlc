import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, currentTheme, initTheme } from '../src/theme';
import { me, mockApi, renderAt } from './helpers';

// P3-1: the light theme. `data-theme` on <html> is the stored choice, else the system's preference; the toggle in the
// top bar sets it and remembers it in this browser; storage that throws never breaks the page.

function prefers(light: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: light && q.includes('light'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the theme', () => {
  it('defaults to what the system prefers, and to dark when it says nothing', () => {
    prefers(true);
    initTheme();
    expect(document.documentElement.dataset['theme']).toBe('light');
    prefers(false);
    expect(currentTheme()).toBe('dark');
  });

  it('a stored choice wins over the system', () => {
    prefers(true);
    window.localStorage.setItem(THEME_KEY, 'dark');
    initTheme();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('the toggle in the top bar switches the theme and remembers it', async () => {
    prefers(false);
    initTheme();
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    const toggle = await screen.findByRole('button', { name: 'Light theme' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    expect(screen.getByRole('button', { name: 'Light theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('storage that throws: the system default, and a choice still applies to the page', async () => {
    prefers(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    initTheme();
    expect(document.documentElement.dataset['theme']).toBe('light');
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me() }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    await user.click(await screen.findByRole('button', { name: 'Light theme' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});
