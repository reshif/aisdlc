import { INTEGRATION_FORBIDDEN } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { T, tile } from './screenFixtures';
import { decide, keyView, preview, proposed } from './settingsFixtures';

// Integrations (screen map §2.12): health tiles; providers and channels added, changed and deleted as settings
// changes; secrets are write-only: the value typed is sent once and is never in the page, the query cache or any
// answer afterwards.

const SECRET = 'sk-ant-THIS-MUST-NEVER-COME-BACK-0123456789';
const ADMIN = () => me(['quality.read', 'config.propose']);

const anthropic = {
  integration_id: 'anthropic',
  kind: 'model_provider',
  adapter: 'anthropic',
  display_name: 'Anthropic',
  config: {},
  status: 'enabled',
  version: 1,
  credentials: [
    {
      credential_id: 'api-key',
      secret_ref: 'vault:gateway/anthropic-api-key#value',
      kind: 'api_key',
    },
  ],
  scopes: [{ scope: 'chat_complete', data_class_max: 'D1', forbidden: [...INTEGRATION_FORBIDDEN] }],
  provider: { tools_capable: true, streams: true, aws_only: false },
};

const secretList = (set: boolean) => ({
  store_reachable: true,
  secrets: [
    {
      name: 'anthropic-api-key',
      owner: 'gateway',
      label: 'Anthropic API key',
      format: 'token',
      ref: 'vault:gateway/anthropic-api-key#value',
      set,
      version: set ? 2 : null,
      updated_at: set ? T : null,
      updated_by: set ? 'alice' : null,
    },
    {
      name: 'slack-webhook-url',
      owner: 'notifier',
      label: 'Slack webhook URL',
      format: 'url',
      ref: 'vault:notifier/slack-webhook-url#value',
      set: false,
      version: null,
      updated_at: null,
      updated_by: null,
    },
  ],
});

const routes = (over: Record<string, unknown> = {}) => ({
  'GET /api/me': { json: ADMIN() },
  'GET /api/config/keys/integrations.registry': {
    json: keyView('integrations.registry', {}, [anthropic]),
  },
  'GET /api/config/keys/gateway.models': { json: keyView('gateway.models', {}, []) },
  'GET /api/models/providers': {
    json: {
      revision: null,
      integrations: [
        { integration_id: 'anthropic', adapter: 'anthropic', state: 'built', detail: 'ok' },
      ],
      bounds: { secret_refs: [], egress_hosts: [] },
    },
  },
  'GET /api/secrets': { json: secretList(false) },
  'POST /api/me/decisions': decide((q) => q.action === 'config.propose'),
  'POST /api/config/keys/integrations.registry/preview': { json: preview('integrations.registry') },
  'POST /api/config/keys/integrations.registry/proposals': { status: 201, json: proposed },
  ...over,
});

describe('Integrations: overview', () => {
  it('a tile per integration with its health in plain words; a stale one reads unknown', async () => {
    mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/integrations': {
        json: {
          health: {
            as_of: T,
            registry_revision: null,
            tiles: [
              tile({ display_name: 'GitHub', state: 'ok' }),
              tile({
                integration_id: 'anthropic',
                kind: 'model_provider',
                adapter: 'anthropic',
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
    const tiles = await screen.findByRole('list', { name: 'Integrations and their health' });
    const gh = within(tiles).getByRole('link', { name: 'GitHub' }).closest('li') as HTMLElement;
    expect(gh).toHaveTextContent('Healthy');
    const an = within(tiles).getByRole('link', { name: 'Anthropic' }).closest('li') as HTMLElement;
    expect(an).toHaveTextContent('Unknown');
    expect(an).toHaveTextContent('too old');
    expect(an).toHaveTextContent('Model provider');
    expect(tiles).not.toHaveTextContent('model_provider');
  });

  it('no integration yet says what to do', async () => {
    mockApi({
      'GET /api/me': { json: me(['quality.read']) },
      'GET /api/integrations': {
        json: { health: { as_of: T, registry_revision: null, tiles: [] }, events: [] },
      },
    });
    renderAt('/integrations');
    expect(await screen.findByText('No integration yet')).toBeVisible();
  });
});

describe('Integrations: model providers and their keys', () => {
  it('a key is pasted once: sent in the body, gone from the page, and only metadata comes back', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes({
        'PUT /api/secrets/anthropic-api-key': {
          json: { name: 'anthropic-api-key', version: 2, updated_at: T },
        },
      }),
    );
    renderAt('/integrations/models');
    const add = await screen.findByTestId('add-provider');
    const field = await within(add).findByLabelText(/Paste secret: Anthropic API key/);
    await user.type(field, SECRET);
    m.table['GET /api/secrets'] = { json: secretList(true) };
    await user.click(within(add).getByRole('button', { name: 'Save secret' }));
    await screen.findByText('Secret saved. It is never shown again.');
    const put = m.calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ value: SECRET });
    expect(put?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    await waitFor(() => expect(within(add).getByText(/Set · last changed/)).toBeVisible());
    // nowhere in the page, nor in any input, after the save
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const i of Array.from(document.querySelectorAll('input'))) {
      expect(i.value).not.toContain(SECRET);
    }
    // and only the PUT carried it
    expect(m.calls.filter((c) => JSON.stringify(c.body ?? '').includes(SECRET))).toHaveLength(1);
  });

  it('adding a provider proposes the registry with one more row, its key by reference only', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    renderAt('/integrations/models');
    const add = await screen.findByTestId('add-provider');
    await user.selectOptions(within(add).getByLabelText('Kind of provider'), 'openai_compat');
    const id = within(add).getByLabelText(/Short id/);
    await user.clear(id);
    await user.type(id, 'deepseek');
    await user.type(within(add).getByLabelText(/Address of its API/), 'https://api.deepseek.com');
    await user.selectOptions(within(add).getByLabelText('Which key it uses'), 'deepseek-api-key');
    await user.click(within(add).getByRole('button', { name: 'Preview the change' }));
    await within(add).findByTestId('st-preview');
    await user.click(within(add).getByRole('button', { name: 'Propose this change' }));
    await waitFor(() => expect(m.calls.some((c) => c.path.endsWith('/proposals'))).toBe(true));
    const sent = m.calls.find((c) => c.path.endsWith('/proposals'))?.body as {
      value: Array<Record<string, unknown>>;
    };
    expect(sent.value).toHaveLength(2);
    expect(sent.value[1]).toMatchObject({
      integration_id: 'deepseek',
      adapter: 'openai_compat',
      config: { base_url: 'https://api.deepseek.com' },
      credentials: [{ secret_ref: 'vault:gateway/deepseek-api-key#value' }],
    });
  });
});

describe('Integrations: one integration', () => {
  it('turn it off as a settings change; deleting asks for its name first', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    renderAt('/integrations/anthropic');
    expect(await screen.findByRole('heading', { level: 1, name: 'Anthropic' })).toBeVisible();
    const edit = screen.getByTestId('edit-integration');
    await user.selectOptions(within(edit).getByLabelText('On or off'), 'disabled');
    await user.click(within(edit).getByRole('button', { name: 'Preview the change' }));
    await within(edit).findByTestId('st-preview');
    expect(
      (m.calls.find((c) => c.path.endsWith('/preview'))?.body as { value: unknown[] }).value[0],
    ).toMatchObject({ status: 'disabled', version: 2 });

    await user.click(screen.getByRole('button', { name: 'Delete integration' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete integration anthropic?' });
    const go = within(dialog).getByRole('button', { name: 'Delete integration anthropic' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'anthropic');
    await user.click(go);
    const remove = await screen.findByTestId('remove-integration');
    await user.click(within(remove).getByRole('button', { name: 'Preview the change' }));
    await waitFor(() =>
      expect(
        (m.calls.filter((c) => c.path.endsWith('/preview')).at(-1)?.body as { value: unknown[] })
          .value,
      ).toEqual([]),
    );
  });

  it('an integration that does not exist is the one 404', async () => {
    mockApi(routes());
    renderAt('/integrations/nope');
    expect(await screen.findByText('Not found')).toBeVisible();
  });
});

describe('Integrations: secrets', () => {
  it('lists every secret with its state, never a value; the vault down reads unknown', async () => {
    const m = mockApi(routes({ 'GET /api/secrets': { json: secretList(true) } }));
    renderAt('/integrations/secrets');
    const list = await screen.findByRole('list', { name: 'Secrets' });
    expect(within(list).getByText(/Set · last changed/)).toBeVisible();
    expect(
      within(list).getByRole('button', { name: 'Delete secret Anthropic API key' }),
    ).toBeVisible();
    m.table['GET /api/secrets'] = {
      json: { ...secretList(true), store_reachable: false },
    };
  });

  it('someone who may not propose a change cannot open the secrets', async () => {
    mockApi(
      routes({
        'GET /api/me': { json: me(['quality.read']) },
        'GET /api/secrets': {
          status: 403,
          json: { error: { code: 'forbidden', message: 'config.propose denied' } },
        },
      }),
    );
    renderAt('/integrations/secrets');
    expect(await screen.findByText(/config.propose denied/)).toBeVisible();
  });
});
