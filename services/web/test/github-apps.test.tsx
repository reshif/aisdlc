import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';
import { T } from './screenFixtures';

// P2-4: the Integrations page's read-only GitHub Apps panel and the repos the factory App can see.

const allow =
  (...actions: string[]) =>
  (c: Call) => ({
    json: {
      decisions: (
        (c.body as { queries: Array<{ action: string; resource: unknown }> }).queries ?? []
      ).map((q) =>
        actions.includes(q.action)
          ? { ...q, allow: true, reasons: [] }
          : { ...q, allow: false, reasons: ['no_policy_permits'] },
      ),
    },
  });

const factoryPerms = { contents: 'write', metadata: 'read', pull_requests: 'write' };
const appsView = {
  sources: [
    { source: 'codehost', state: 'ok' },
    { source: 'push-broker', state: 'unreachable' },
    { source: 'gate-check', state: 'ok' },
  ],
  apps: [
    {
      kind: 'factory',
      app_id: '11',
      installation_id: 7,
      login: 'aisdlc-factory-x[bot]',
      jobs: ['read', 'push'],
      required: factoryPerms,
      installation: {
        state: 'ok',
        account_login: 'acme',
        repository_selection: 'all',
        permissions: { ...factoryPerms, workflows: 'write' },
        suspended: false,
      },
      comparison: {
        ok: false,
        missing: [],
        extra: ['workflows:write'],
        forbidden: ['workflows:write'],
      },
      key_loaded: true,
      last_ok_at: T,
      shares_with_pusher: false,
    },
    {
      kind: 'gate-check',
      app_id: '22',
      installation_id: 8,
      login: null,
      jobs: ['gate-check'],
      required: { checks: 'write', metadata: 'read', pull_requests: 'read' },
      installation: { state: 'unknown', reason: 'server_error' },
      comparison: null,
      key_loaded: false,
      last_ok_at: null,
      shares_with_pusher: false,
    },
  ],
  gate_rule: [
    { repo: 'acme/web', branch: 'main', state: 'required' },
    { repo: 'acme/api', branch: 'main', state: 'unknown' },
  ],
  setup_command: 'cd platform/compose && ./setup-github-apps',
};

const repos = {
  repos: [
    {
      full_name: 'acme/new',
      default_branch: 'main',
      private: true,
      archived: false,
      registered: false,
      onboarding: { state: 'not_onboarded' },
    },
    {
      full_name: 'acme/api',
      default_branch: 'main',
      private: true,
      archived: false,
      registered: true,
      onboarding: {
        state: 'onboarding',
        project_id: 'api',
        s0_id: 's0-1',
        status: 'card',
        waiting: 'card 4 waits for alice',
      },
    },
    {
      full_name: 'acme/web',
      default_branch: 'main',
      private: false,
      archived: false,
      registered: true,
      onboarding: {
        state: 'onboarded',
        project_id: 'web',
        s0_id: 's0-2',
        level: 'light',
        lanes: ['L1', 'L2', 'L3'],
      },
    },
    {
      full_name: 'acme/old',
      default_branch: 'main',
      private: true,
      archived: true,
      registered: false,
      onboarding: { state: 'archived' },
    },
    {
      full_name: 'acme/odd',
      default_branch: 'main',
      private: true,
      archived: false,
      registered: true,
      onboarding: { state: 'unknown' },
    },
  ],
};

const routes = (decisions: ReturnType<typeof allow>) => ({
  'GET /api/me': { json: me(['quality.read']) },
  'POST /api/me/decisions': decisions,
  'GET /api/integrations': {
    json: { health: { as_of: T, registry_revision: null, tiles: [] }, events: [] },
  },
  'GET /api/integrations/github-apps': { json: appsView },
  'GET /api/onboard/repos': { json: repos },
});

describe('Integrations: GitHub Apps', () => {
  it('each App: jobs, installation, required vs granted (forbidden, extra), key loaded, the aisdlc/gate rule', async () => {
    mockApi(routes(allow('quality.read', 'project.onboard')));
    renderAt('/integrations');
    const table = await screen.findByRole('table', { name: 'GitHub Apps' });
    const [, factory, gate] = within(table).getAllByRole('row');
    expect(factory).toHaveTextContent('App ID 11');
    expect(factory).toHaveTextContent('aisdlc-factory-x[bot]');
    expect(factory).toHaveTextContent('all repositories');
    expect(factory).toHaveTextContent('forbidden');
    expect(factory).toHaveTextContent('workflows:write');
    expect(factory).toHaveTextContent('loaded');
    expect(gate).toHaveTextContent('unknown (server_error)');
    expect(gate).toHaveTextContent('not loaded');
    expect(screen.getByText(/push-broker: did not answer/)).toBeInTheDocument();
    const rule = screen.getByRole('list', { name: 'aisdlc/gate on the default branch' });
    expect(within(rule).getAllByRole('listitem')[0]).toHaveTextContent('required from gate-check');
    expect(within(rule).getAllByRole('listitem')[1]).toHaveTextContent('unknown');
    expect(screen.getByText('cd platform/compose && ./setup-github-apps')).toBeInTheDocument();
    // nothing in the panel creates an App or handles a key
    expect(screen.queryByRole('button', { name: /create|rotate|upload/i })).toBeNull();
  });

  it('the repos: status per repo and the action it allows; Onboard only when not onboarded and allowed', async () => {
    mockApi(routes(allow('quality.read', 'project.onboard')));
    renderAt('/integrations');
    const table = await screen.findByRole('table', { name: 'Repositories' });
    const rows = within(table).getAllByRole('row').slice(1);
    const [fresh, inProgress, done, archived, odd] = rows as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(await within(fresh).findByRole('link', { name: 'Onboard' })).toHaveAttribute(
      'href',
      '/onboard?repo=acme%2Fnew',
    );
    expect(inProgress).toHaveTextContent('onboarding (card)');
    expect(inProgress).toHaveTextContent('card 4 waits for alice');
    expect(within(inProgress).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/s0/s0-1',
    );
    expect(done).toHaveTextContent('Light');
    expect(done).toHaveTextContent('L1, L2, L3');
    expect(within(done).getByRole('link', { name: 'Open project' })).toHaveAttribute(
      'href',
      '/projects/web',
    );
    expect(archived).toHaveTextContent('archived');
    expect(within(archived).queryByRole('link')).toBeNull();
    expect(odd).toHaveTextContent('unknown');
    expect(within(odd).queryByRole('link')).toBeNull();
  });

  it('without project.onboard the Onboard action is locked (the server still decides)', async () => {
    mockApi(routes(allow('quality.read')));
    renderAt('/integrations');
    const table = await screen.findByRole('table', { name: 'Repositories' });
    const fresh = within(table).getAllByRole('row')[1] as HTMLElement;
    // the LockedButton (aria-disabled, with the PDP's reason), not a link
    await waitFor(() =>
      expect(within(fresh).getByRole('button', { name: /Onboard/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(within(fresh).queryByRole('link', { name: 'Onboard' })).toBeNull();
  });

  it('a code host that cannot list the repos reads so, never an empty list', async () => {
    mockApi({
      ...routes(allow('quality.read')),
      'GET /api/onboard/repos': {
        status: 502,
        json: { error: { code: 'codehost_unavailable', message: 'the code host could not list' } },
      },
    });
    renderAt('/integrations');
    expect(await screen.findByText(/repos could not be read/)).toBeInTheDocument();
  });
});
