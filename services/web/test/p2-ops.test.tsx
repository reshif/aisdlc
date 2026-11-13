import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, projectOf, renderAt } from './helpers';
import { ITEM_A, T, allowOnly } from './screenFixtures';

// The P2 operate and govern gaps (docs/design/portal-review.md §12): Budgets and Cost (P2-8), the project's breakers
// (P2-11), "Publish a banner" (P2-12), provider Test and Reload (P2-5) and the onboard repo picker (P2-21). The
// buttons follow the PDP's hints; every write is decided again on the server.

const GATE = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a92';

const budgets = {
  as_of: T,
  gateway: true,
  groups: [
    {
      budget_group: 'unit-spent',
      project_ids: ['testbed'],
      item_ids: [ITEM_A],
      calls: 3,
      refused: 1,
      used_tokens: 120,
      used_cost_micro_usd: 1_500_000,
      last_call_at: T,
      exhausted_at: T,
      exhausted_limit: 'tokens',
      live: {
        group_id: 'unit-spent',
        max_tokens: 120,
        max_cost_micro_usd: 5_000_000,
        used_tokens: 120,
        used_cost_micro_usd: 1_500_000,
        reserved_tokens: 0,
        reserved_cost_micro_usd: 0,
        exhausted_at: T,
      },
    },
    {
      budget_group: 'unit-quiet',
      project_ids: ['testbed'],
      item_ids: [],
      calls: 0,
      refused: 0,
      used_tokens: 0,
      used_cost_micro_usd: 0,
      last_call_at: null,
      exhausted_at: null,
      exhausted_limit: null,
      live: null,
    },
  ],
};

describe('Operate › Budgets and Govern › Cost (P2-8)', () => {
  it('budgets: used, reserved and exhausted per group; limits the gateway did not give are unknown', async () => {
    mockApi({ 'GET /api/me': { json: me(['ops.read']) }, 'GET /api/budgets': { json: budgets } });
    renderAt('/budgets');
    const table = await screen.findByRole('table', { name: 'Budget groups' });
    const spent = within(table).getByRole('row', { name: /unit-spent/ });
    expect(spent).toHaveTextContent('exhausted (tokens)');
    expect(spent).toHaveTextContent('120 of 120 (100% used)');
    expect(spent).toHaveTextContent('$1.50 of $5.00');
    expect(spent).toHaveTextContent('3 (+1 refused)');
    const quiet = within(table).getByRole('row', { name: /unit-quiet/ });
    expect(quiet).toHaveTextContent('limits unknown');
    expect(quiet).toHaveTextContent('none yet');
    expect(screen.getByRole('link', { name: 'Budgets' })).toHaveAttribute('aria-current', 'page');
  });

  it('cost: per project, per day, by outcome and per merged item, with a range', async () => {
    const user = userEvent.setup();
    const cost = (days: number) => ({
      as_of: T,
      since: '2026-11-06T00:00:00.000Z',
      days,
      by_day: [
        {
          day: '2026-11-12',
          project_id: 'testbed',
          calls: 2,
          tokens_in: 100,
          tokens_out: 20,
          cost_micro_usd: 900,
        },
      ],
      by_outcome: [{ outcome: 'ok', calls: 2, cost_micro_usd: 900 }],
      merged_items: [
        {
          item_id: ITEM_A,
          project_id: 'testbed',
          lane: 'L3',
          merged_at: T,
          calls: 2,
          tokens: 120,
          cost_micro_usd: 900,
        },
      ],
    });
    const m = mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/cost?days=30': { json: cost(30) },
      'GET /api/cost?days=7': { json: cost(7) },
    });
    renderAt('/cost');
    const merged = await screen.findByRole('table', { name: 'Cost per merged item' });
    expect(within(merged).getByRole('link', { name: ITEM_A.slice(0, 8) })).toHaveAttribute(
      'href',
      `/items/${ITEM_A}`,
    );
    expect(merged).toHaveTextContent('$0.0009');
    expect(screen.getByRole('table', { name: 'Spend per day and project' })).toHaveTextContent(
      '2026-11-12',
    );
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/cost?days=7')).toBe(true));
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the nav lists Budgets under Operate for ops.read and Cost under Govern for quality.read only', async () => {
    mockApi({ 'GET /api/me': { json: me(['ops.read']) }, 'GET /api/budgets': { json: budgets } });
    renderAt('/budgets');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Budgets' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Cost' })).toBeNull();
  });
});

describe('Project › Breakers (P2-11)', () => {
  const project = {
    project: projectOf({ level: 'light' }),
    repos: [],
    s0: [],
  };
  const breaker = (o: Record<string, unknown> = {}) => ({
    project_id: 'testbed',
    lane: 'L3',
    counts: { Q1: 2, rework_budget: 1 },
    total: 3,
    threshold: 3,
    tripped: true,
    tripped_at: T,
    pending_reset: null,
    resets: 0,
    ...o,
  });

  it('shows each lane against its threshold, and asks for a reset (an M5 gate) with the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allowOnly('project.view', 'config.propose'),
      'GET /api/projects/testbed': { json: project },
      'GET /api/projects/testbed/breakers': {
        json: { breakers: [breaker(), breaker({ lane: 'L1', tripped: false, total: 1 })] },
      },
      'POST /api/projects/testbed/breakers/L3/reset': {
        status: 201,
        json: { gate_instance_id: GATE },
      },
    });
    renderAt('/projects/testbed');
    const table = await screen.findByRole('table', { name: 'Circuit breakers of testbed' });
    const l3 = within(table).getByRole('row', { name: /L3/ });
    expect(l3).toHaveTextContent('3 of 3');
    expect(l3).toHaveTextContent('Q1 2, rework_budget 1');
    expect(within(table).getByRole('row', { name: /L1/ })).toHaveTextContent('not tripped');
    await user.click(await within(l3).findByRole('button', { name: 'Ask to reset L3' }));
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === '/api/projects/testbed/breakers/L3/reset')).toBe(true),
    );
    const post = m.calls.find((c) => c.path === '/api/projects/testbed/breakers/L3/reset');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('a reset already asked for links to the inbox; without config.propose the button is locked', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allowOnly('project.view'),
      'GET /api/projects/testbed': { json: project },
      'GET /api/projects/testbed/breakers': {
        json: { breakers: [breaker(), breaker({ lane: 'L4', pending_reset: GATE })] },
      },
    });
    renderAt('/projects/testbed');
    const table = await screen.findByRole('table', { name: 'Circuit breakers of testbed' });
    expect(within(table).getByRole('link', { name: 'M5 reset waiting' })).toHaveAttribute(
      'href',
      '/inbox',
    );
    await waitFor(() =>
      expect(within(table).getByRole('button', { name: /Ask to reset L3/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });
});

describe('Controls › Publish a banner (P2-12)', () => {
  it('publishes on a project with banner.publish, the person never named by the browser', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['ops.read']) },
      'POST /api/me/decisions': allowOnly('banner.publish'),
      'GET /api/controls': { json: { controls: [], banners: [] } },
      'POST /api/banners': { status: 201, json: { banner_id: GATE } },
    });
    renderAt('/controls');
    await user.type(await screen.findByRole('textbox', { name: 'Banner project' }), 'testbed');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Banner severity' }), 'warning');
    await user.type(screen.getByRole('textbox', { name: 'Banner text' }), 'Maintenance at 22:00');
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/banners')).toBe(true));
    const post = m.calls.find((c) => c.path === '/api/banners');
    expect(post?.body).toMatchObject({
      scope: { kind: 'project', ref: 'testbed' },
      severity: 'warning',
      text: 'Maintenance at 22:00',
    });
    expect(post?.body).not.toHaveProperty('on_behalf_of');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('without banner.publish the button is locked', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['ops.read']) },
      'GET /api/controls': { json: { controls: [], banners: [] } },
    });
    renderAt('/controls');
    await user.type(await screen.findByRole('textbox', { name: 'Banner project' }), 'testbed');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Publish/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });
});

describe('Models › providers at the gateway (P2-5)', () => {
  const providers = {
    revision: 'r'.repeat(64),
    integrations: [
      { integration_id: 'anthropic', adapter: 'anthropic', state: 'built', detail: 'ok' },
      {
        integration_id: 'deepseek',
        adapter: 'openai_compat',
        state: 'refused',
        detail: 'key_ref_not_allowed',
      },
    ],
    bounds: {
      secret_refs: ['file:/run/secrets/anthropic-api-key'],
      egress_hosts: ['api.anthropic.com'],
    },
  };

  it('lists the adapters and the bounds, tests one, and reloads all after a rotation', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'POST /api/me/decisions': allowOnly('config.propose'),
      'GET /api/config/keys/gateway.models': {
        status: 404,
        json: { error: { code: 'x', message: 'x' } },
      },
      'GET /api/config/keys/gateway.routes': {
        status: 404,
        json: { error: { code: 'x', message: 'x' } },
      },
      'GET /api/models/providers': { json: providers },
      'POST /api/models/providers/anthropic/test': {
        json: {
          integration_id: 'anthropic',
          model_id: 'claude-haiku',
          outcome: 'ok',
          code: null,
          tokens_in: 3,
          tokens_out: 1,
          cost_micro_usd: 8,
          latency_ms: 120,
          at: T,
        },
      },
      'POST /api/models/reload': { json: { revision: 'r'.repeat(64), integrations: [] } },
    });
    renderAt('/models');
    const table = await screen.findByRole('table', {
      name: 'Model providers as the gateway built them',
    });
    expect(within(table).getByRole('row', { name: /deepseek/ })).toHaveTextContent(
      'refused: key_ref_not_allowed',
    );
    expect(screen.getByText('api.anthropic.com')).toBeInTheDocument();
    await user.click(await within(table).findByRole('button', { name: 'Test anthropic' }));
    expect(await within(table).findByText(/ok · 120 ms · 4 tokens/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload all (after a key rotation)' }));
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/models/reload')).toBe(true));
    expect(m.calls.find((c) => c.path === '/api/models/reload')?.body).toEqual({ force: true });
  });
});

describe('Onboard › the repo picker (P2-21)', () => {
  it('picks a repo the App installation sees; one a project holds cannot be chosen', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['project.onboard']) },
      'GET /api/onboard/repos': {
        json: {
          repos: [
            {
              full_name: 'reshif/held',
              default_branch: 'main',
              private: false,
              archived: false,
              registered: true,
            },
            {
              full_name: 'reshif/new-one',
              default_branch: 'main',
              private: true,
              archived: false,
              registered: false,
            },
          ],
        },
      },
    });
    renderAt('/onboard');
    const pick = await screen.findByRole('combobox', { name: 'From the App installation' });
    expect(
      within(pick).getByRole('option', { name: /reshif\/held, already a project’s/ }),
    ).toBeDisabled();
    await user.selectOptions(pick, 'reshif/new-one');
    expect(screen.getByRole('textbox', { name: 'Repository owner' })).toHaveValue('reshif');
    expect(screen.getByRole('textbox', { name: 'Repository name' })).toHaveValue('new-one');
  });

  it('a list that cannot be read leaves the typed fields', async () => {
    mockApi({
      'GET /api/me': { json: me(['project.onboard']) },
      'GET /api/onboard/repos': {
        status: 502,
        json: { error: { code: 'codehost_unavailable', message: 'down' } },
      },
    });
    renderAt('/onboard');
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Repository owner' })).toBeEnabled();
  });
});
