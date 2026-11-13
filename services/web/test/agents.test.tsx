import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { agentRow, evalRun } from './screenFixtures';
import { GATE, decide, keyView, preview, proposed } from './settingsFixtures';

// Agents (screen map §2.14): every agent on or off with its model and latest evaluation; turning one off or changing
// its model is a settings change of `agents.config` (preview, propose, or apply now as the factory admin).

const REGISTRY = {
  lock_format: 'aisdlc-prompts-lock/v1',
  agents: [
    agentRow({ agent_id: 'A1', name: 'triage' }),
    agentRow({ agent_id: 'coder', name: 'coder', steps: ['6.2'], models: ['claude-opus-5-5'] }),
    // no step: never runs, not listed
    agentRow({ agent_id: 'A7', name: null, steps: [] }),
  ],
};

const ADMIN = () => me(['quality.read', 'config.propose', 'config.decide']);

const base = (cfg: unknown, over: Record<string, unknown> = {}) => ({
  'GET /api/me': { json: ADMIN() },
  'GET /api/agents': { json: REGISTRY },
  'GET /api/evals/runs?limit=50': { json: { runs: [evalRun({ agent_id: 'A1', pass_rate: 0.9 })] } },
  'GET /api/config/keys/agents.config': {
    json: keyView('agents.config', {}, cfg, { may_apply_now: true, ...over }),
  },
  'GET /api/config/keys/gateway.models': {
    json: keyView('gateway.models', {}, [
      {
        model_id: 'claude-haiku',
        provider_id: 'anthropic',
        provider_model: 'claude-haiku-5',
        tools_capable: true,
        max_tokens_cap: 4096,
        usd_in_per_mtok: 1,
        usd_out_per_mtok: 5,
      },
    ]),
  },
  'POST /api/me/decisions': decide((q) => q.action === 'config.propose'),
  'POST /api/config/keys/agents.config/preview': {
    json: preview('agents.config', {
      changes: [{ path: 'A1.enabled', before: null, after: false }],
      effects: ['Triage agent is turned off: it runs nothing until it is turned on.'],
    }),
  },
  'POST /api/config/keys/agents.config/proposals': { status: 201, json: proposed },
});

describe('Agents: the list', () => {
  it('each agent in plain words, on or off, its model and its latest evaluation', async () => {
    mockApi(base({ coder: { enabled: false, models: ['claude-haiku'] } }));
    renderAt('/agents');
    const table = await screen.findByRole('table', { name: 'Agents' });
    const triage = within(table).getByRole('row', { name: /Triage agent/ });
    expect(triage).toHaveTextContent('On');
    expect(await within(triage).findByText('90%')).toBeVisible();
    const coder = within(table).getByRole('row', { name: /Coding agent/ });
    expect(await within(coder).findByText('Off')).toBeVisible();
    expect(coder).toHaveTextContent('claude-haiku');
    expect(table).not.toHaveTextContent('A7');
    expect(within(table).queryByText('A1')).toBeNull();
  });

  it('turning an agent off is a previewed settings change', async () => {
    const user = userEvent.setup();
    const m = mockApi(base({}));
    renderAt('/agents');
    await user.click(await screen.findByRole('button', { name: 'Turn off Triage agent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off Triage agent?' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview the change' }));
    expect(await within(dialog).findByTestId('st-preview')).toHaveTextContent('turned off');
    await user.click(within(dialog).getByRole('button', { name: 'Propose this change' }));
    await waitFor(() => expect(m.calls.some((c) => c.path.endsWith('/proposals'))).toBe(true));
    expect(m.calls.find((c) => c.path.endsWith('/proposals'))?.body).toEqual({
      value: { A1: { enabled: false } },
      parent_rev_hash: null,
    });
  });

  it('someone who may read quality but not settings sees on or off as unknown and no switch', async () => {
    mockApi({
      ...base({}),
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/config/keys/agents.config': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'denied' } },
      },
    });
    renderAt('/agents');
    const table = await screen.findByRole('table', { name: 'Agents' });
    expect(await within(table).findAllByText('Unknown')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Turn off/ })).toBeNull();
  });
});

describe('Agents: one agent', () => {
  const detail = {
    agent: agentRow({
      agent_id: 'coder',
      name: 'coder',
      steps: ['6.2'],
      models: ['claude-opus-5-5'],
    }),
    input_schema_id: 'coder_input.v1',
    input_schema: {},
    output_schema: {},
    lock_format: 'aisdlc-prompts-lock/v1',
  };

  it('changes the model and the turns, and the factory admin applies it now with a reason', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      ...base({}),
      'GET /api/agents/coder': { json: detail },
      [`POST /api/config/revisions/${GATE}/prepare`]: {
        json: {
          nonce: 'n1',
          expires_at: '2026-11-13T10:00:00.000Z',
          evidence_hash: 'e'.repeat(64),
        },
      },
      [`POST /api/config/revisions/${GATE}/evidence`]: { json: { evidence_viewed: true } },
      [`POST /api/config/revisions/${GATE}/decide`]: {
        json: { outcome: 'approve', published: true, publish_error: null },
      },
    });
    renderAt('/agents/coder');
    expect(await screen.findByRole('heading', { level: 1, name: 'Coding agent' })).toBeVisible();
    const form = await screen.findByRole('form', { name: 'Settings of Coding agent' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'claude-haiku' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText('Model'), 'claude-haiku');
    await user.type(within(form).getByLabelText('Most turns in one session'), '60');
    await user.click(screen.getByRole('button', { name: 'Preview the change' }));
    await screen.findByTestId('st-preview');
    expect(m.calls.find((c) => c.path.endsWith('/preview'))?.body).toEqual({
      value: { coder: { models: ['claude-haiku'], max_turns: 60 } },
    });
    await user.click(screen.getByRole('button', { name: 'Apply now as factory admin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply now as factory admin' });
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'cheaper model for now');
    await user.click(within(dialog).getByRole('button', { name: 'Apply now' }));
    await screen.findByText(/Applied\. The change is in force/);
    expect(m.calls.find((c) => c.path.endsWith('/proposals'))?.body).toEqual({
      value: { coder: { models: ['claude-haiku'], max_turns: 60 } },
      parent_rev_hash: null,
    });
  });

  it('a turn limit out of range is said in words and cannot be sent', async () => {
    const user = userEvent.setup();
    mockApi({ ...base({}), 'GET /api/agents/coder': { json: detail } });
    renderAt('/agents/coder');
    const form = await screen.findByRole('form', { name: 'Settings of Coding agent' });
    await user.type(within(form).getByLabelText('Most turns in one session'), '9999');
    expect(screen.getByRole('alert', { name: 'Problems with the draft' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview the change' })).toBeDisabled();
  });
});
