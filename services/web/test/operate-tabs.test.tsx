import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';

// Operate (screen map §2.15): one page, a tab per job, each a page of its own; a tab is listed only for those who
// may read it, and the old addresses open the same tabs.

describe('Operate: the tabs', () => {
  it('ops.read sees every tab; the old /health address opens Health', async () => {
    mockApi({
      'GET /api/me': { json: me(['ops.read']) },
      'GET /api/health': { status: 503, json: { error: { code: 'unavailable', message: 'x' } } },
      'GET /api/integrations': {
        status: 503,
        json: { error: { code: 'unavailable', message: 'x' } },
      },
    });
    renderAt('/health');
    const tabs = await screen.findByRole('navigation', { name: 'Operate tabs' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Emergency stop',
      'Pauses and notices',
      'Queue and capacity',
      'Sandboxes',
      'Health',
      'Spend',
    ]);
    expect(within(tabs).getByRole('link', { name: 'Health' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('quality.read alone sees only Spend, with the cost reports', async () => {
    mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/cost?days=30': {
        json: { days: 30, as_of: '2026-11-13T00:00:00.000Z', by_day: [], merged_items: [] },
      },
    });
    renderAt('/operate');
    const tabs = await screen.findByRole('navigation', { name: 'Operate tabs' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Spend']);
  });

  it('a tab the person may not read is the 403 with the reason', async () => {
    mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/cost?days=30': {
        json: { days: 30, as_of: '2026-11-13T00:00:00.000Z', by_day: [], merged_items: [] },
      },
    });
    renderAt('/operate/stop');
    expect(await screen.findByText(/See my access/)).toBeVisible();
  });
});
