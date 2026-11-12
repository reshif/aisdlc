import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { SHA_A, SHA_B, T, agentRow, evalRun, tile } from './screenFixtures';

const AUDITOR = () => me(['audit.read']);

const configKey = (key: string, value: unknown) => ({
  key: { key, kind: 'factory', description: key, m1_gated: true },
  default: [],
  effective: {
    value,
    source: 'revision',
    rev_hash: SHA_A,
    gate_instance_id: null,
    ledger_entry_id: null,
    published_at: T,
  },
  head_rev_hash: SHA_A,
  pending: [],
  history: [],
  may_propose: false,
  principal_names: {},
});

describe('quality: agents', () => {
  it('the registry with steps, contract, prompt hash, tools, data class and the newest eval score; no on/off switch', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/agents': {
        json: {
          lock_format: 'aisdlc-prompts-lock/v1',
          agents: [
            agentRow(),
            agentRow({
              agent_id: 'A5',
              name: 'review',
              steps: ['3.5'],
              specialist_steps: ['6.3'],
              tools: ['Read', 'Grep'],
              data_class_max: 'D2',
              prompt: { ref: 'a5_review@1.0.0', sha256: SHA_B },
            }),
            agentRow({
              agent_id: 'A7',
              name: null,
              steps: [],
              prompt: { ref: 'unspecified@1.0.0', sha256: SHA_A },
            }),
          ],
        },
      },
      'GET /api/evals/runs?limit=50': {
        json: {
          runs: [
            evalRun(),
            evalRun({ eval_run_id: 'r2', agent_id: 'A5', prompt_sha256: SHA_A, pass_rate: 0.5 }),
          ],
        },
      },
    });
    renderAt('/agents');
    const table = await screen.findByRole('table', { name: 'Agents' });
    const rows = within(table).getAllByRole('row').slice(1);
    const a1 = within(rows[0] as HTMLElement);
    expect(a1.getByText('A1')).toBeInTheDocument();
    expect(a1.getByLabelText(`hash ${SHA_A}`)).toHaveTextContent(SHA_A.slice(0, 12));
    expect(a1.getByText('none')).toBeInTheDocument();
    expect(await a1.findByText('92%')).toBeInTheDocument();
    // A5's newest run scored another prompt than the pinned one
    const a5 = within(rows[1] as HTMLElement);
    expect(await a5.findByText('other prompt')).toBeInTheDocument();
    expect(a5.getByText('specialist')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText(/no step: never run/)).toBeInTheDocument();
    // the registry is code: nothing here switches an agent
    expect(screen.queryByRole('button', { name: /off|disable|enable/i })).toBeNull();
    expect(screen.getByTestId('not-built')).toHaveTextContent('Switching an agent off');
  });

  it('a direct link without audit.read is the 403 page and asks nothing of the API', async () => {
    const { calls } = mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/agents');
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
    expect(calls.map((c) => c.path)).not.toContain('/api/agents');
    expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull();
  });
});

describe('quality: evals, models, integrations', () => {
  it('evals: the run history and the newest task results; gate results are marked not built', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/evals/runs?limit=50': { json: { runs: [evalRun({ errored: 1 })] } },
      'GET /api/evals/summary': {
        json: {
          rows: [
            {
              task_id: 't1',
              profile: 'default',
              suite: 'triage-core',
              provider: 'anthropic',
              trials: 3,
              passes: 2,
              pass_rate: 0.66,
              pass_k: 0.33,
              k: 3,
              status: 'flaky',
            },
          ],
        },
      },
    });
    renderAt('/evals');
    const runs = await screen.findByRole('table', { name: 'Eval runs' });
    expect(within(runs).getByText('92% (11/12, k=3)')).toBeInTheDocument();
    expect(within(runs).getByText('1')).toBeInTheDocument();
    const tasks = await screen.findByRole('table', { name: 'Tasks' });
    expect(within(tasks).getByText('flaky')).toBeInTheDocument();
    expect(screen.getByTestId('not-built')).toHaveTextContent('Gate results');
  });

  it('models and routes: the value in force with its revision, and a link to change it in Configuration', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/config/keys/gateway.models': {
        json: configKey('gateway.models', [
          {
            model_id: 'sonnet',
            provider_id: 'anthropic',
            provider_model: 'claude-sonnet-5-5',
            tools_capable: true,
            max_tokens_cap: 8000,
            usd_in_per_mtok: 3,
            usd_out_per_mtok: 15,
          },
        ]),
      },
      'GET /api/config/keys/gateway.routes': {
        status: 404,
        json: { error: { code: 'not_found', message: 'unknown key' } },
      },
    });
    renderAt('/models');
    const models = await screen.findByRole('table', { name: 'Models' });
    expect(within(models).getByText('claude-sonnet-5-5')).toBeInTheDocument();
    expect(
      await screen.findByText('This deployment does not register gateway.routes.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open in Configuration' })[0]).toHaveAttribute(
      'href',
      '/config/gateway.models',
    );
  });

  it('integrations: one health shape per integration; a stale report reads unknown', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/integrations': {
        json: {
          health: {
            as_of: T,
            registry_revision: null,
            tiles: [
              tile(),
              tile({
                integration_id: 'anthropic',
                display_name: 'Anthropic',
                state: 'unknown',
                stale: true,
              }),
            ],
          },
          events: [],
        },
      },
    });
    renderAt('/integrations');
    const tiles = await screen.findByRole('list', { name: 'Integrations' });
    const [gh, an] = within(tiles).getAllByRole('listitem');
    expect(gh).toHaveTextContent('ok');
    expect(an).toHaveTextContent('unknown');
    expect(an).toHaveTextContent('report older than two minutes');
    expect(screen.getByText('No registry change has been published yet.')).toBeInTheDocument();
  });
});
