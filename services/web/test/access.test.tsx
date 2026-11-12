import { DECISION_BATCH_MAX, pdpResource, type DecisionQuery } from '@aisdlc/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../src/App';
import { AccessProvider, DecisionBatcher, Guarded, reasonText } from '../src/access';
import { emptyAccess, me, mockApi, renderAt, type Call } from './helpers';

// The client side of access: hints from the server, never a grant. The server side (and the test
// that a write the hint allowed is still refused) is services/bff/test/access.test.ts.

const decisionsOf = (calls: readonly Call[]) =>
  calls
    .filter((c) => c.path === '/api/me/decisions')
    .map((c) => (c.body as { queries: DecisionQuery[] }).queries);

function withAccess(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AccessProvider me={me()}>{ui}</AccessProvider>
    </QueryClientProvider>,
  );
}

describe('Guarded', () => {
  it('asks once for all the guards of a render, with the CSRF token, and shows only what is allowed', async () => {
    const m = mockApi({
      'POST /api/me/decisions': (c) => ({
        json: {
          decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
            ...q,
            allow: q.action === 'work.request',
            reasons:
              q.action === 'work.request'
                ? ['role/project.requester/work.request']
                : ['no_policy_permits'],
          })),
        },
      }),
    });
    withAccess(
      <>
        <Guarded action="work.request" resource={pdpResource.project('acme')} label="Ask">
          <button type="button">Ask for work</button>
        </Guarded>
        <Guarded action="audit.read" resource={pdpResource.project('acme')} mode="hide">
          <a href="/ledger">Ledger</a>
        </Guarded>
        <Guarded
          action="gate.decide"
          resource={pdpResource.gate('acme', 'g-1', 'G2')}
          label="Decide G2"
        >
          <button type="button">Decide G2</button>
        </Guarded>
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Ask for work' })).not.toHaveAttribute(
      'aria-disabled',
    );
    const locked = await screen.findByRole('button', { name: /Decide G2/ });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveAccessibleDescription(/None of your roles allows this here/);
    expect(screen.queryByRole('link', { name: 'Ledger' })).toBeNull();
    const batches = decisionsOf(m.calls);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((q) => q.action)).toEqual(['work.request', 'audit.read', 'gate.decide']);
    expect(m.calls.find((c) => c.path === '/api/me/decisions')?.headers['x-csrf-token']).toBe(
      'csrf-token-of-alice',
    );
  });

  it('a locked button offers "Request access" with the action named; a not_visible one does not', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /api/me/decisions': (c) => ({
        json: {
          decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
            ...q,
            allow: false,
            reasons: q.resource.id === 'secret' ? ['not_visible'] : ['no_policy_permits'],
          })),
        },
      }),
    });
    withAccess(
      <>
        <Guarded action="config.propose" resource={pdpResource.project('acme')} label="Propose">
          <button type="button">Propose</button>
        </Guarded>
        <Guarded action="config.propose" resource={pdpResource.project('secret')} label="Other">
          <button type="button">Other</button>
        </Guarded>
      </>,
    );
    const locked = async (name: RegExp) => {
      await waitFor(() =>
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true'),
      );
      return screen.getByRole('button', { name });
    };
    await user.click(await locked(/Propose/));
    expect(screen.getByRole('link', { name: 'Request access' })).toHaveAttribute(
      'href',
      '/me/access?want=config.propose&project=acme',
    );
    await user.click(await locked(/Other/));
    expect(screen.getAllByRole('link', { name: 'Request access' })).toHaveLength(1);
    expect(screen.getByText(/You cannot see this project/)).toBeInTheDocument();
  });

  it('fails closed: a failed or garbled answer locks, never unlocks', async () => {
    mockApi({
      'POST /api/me/decisions': { status: 503, json: { error: { code: 'x', message: 'down' } } },
    });
    withAccess(
      <Guarded action="work.request" resource={pdpResource.project('acme')} label="Ask">
        <button type="button">Ask for work</button>
      </Guarded>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ask/ })).toHaveAttribute('aria-disabled', 'true'),
    );
    expect(screen.queryByRole('button', { name: 'Ask for work' })).toBeNull();
  });
});

describe('DecisionBatcher', () => {
  it('splits a large render into batches of DECISION_BATCH_MAX and treats a mismatched answer as a deny', async () => {
    const sent: number[] = [];
    const b = new DecisionBatcher(async (qs) => {
      sent.push(qs.length);
      // answers rotated by one: each one is about another question than its slot
      return [...qs.slice(1), ...qs.slice(0, 1)].map((q) => ({ ...q, allow: true, reasons: [] }));
    });
    const qs = Array.from({ length: DECISION_BATCH_MAX + 3 }, (_, i) => ({
      action: 'project.view' as const,
      resource: pdpResource.project(`p${i}`),
    }));
    const out = await Promise.all(qs.map((q) => b.load(q)));
    expect(sent).toEqual([DECISION_BATCH_MAX, 3]);
    expect(out.filter((a) => a.allow)).toHaveLength(0);
  });
});

describe('reasonText', () => {
  it('says the PDP code in words, and fail-closed codes read as "could not be checked"', () => {
    expect(reasonText('audit.read', ['no_policy_permits'])).toMatch(/None of your roles/);
    expect(reasonText('audit.read', ['no_bundle'])).toMatch(/could not be checked/);
    expect(reasonText('audit.read', ['something_new'])).toMatch(/something_new/);
    expect(reasonText('audit.read', ['not_visible'])).toBe('You cannot see this project.');
  });
});

describe('the shell and My access', () => {
  it('navigation is grouped, and an entry the person cannot open is not listed', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/projects': { json: [] } });
    renderAt('/projects');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('heading', { name: 'Decide' })).toBeInTheDocument();
    expect(within(nav).getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    // a group with nothing the person may open is not shown: Operate and Quality need audit.read on the fleet
    expect(within(nav).queryByRole('heading', { name: 'Operate' })).toBeNull();
    expect(within(nav).queryByRole('heading', { name: 'Quality' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Onboard a repo' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'People' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('My access shows the bindings and per project the levels and the PDP matrix', async () => {
    const access = {
      ...emptyAccess(),
      bindings: [
        {
          binding_id: 'b1',
          role_id: 'project.admin',
          scope: { kind: 'project', ref: 'acme' },
          project_id: 'acme',
          group_id: 'g1',
          group_display: 'acme admins',
          source: 'manual',
          expiry: null,
          blockers: [],
        },
        {
          binding_id: 'b2',
          role_id: 'project.viewer',
          scope: { kind: 'project', ref: 'old' },
          project_id: 'old',
          group_id: 'g2',
          group_display: 'old viewers',
          source: 'manual',
          expiry: '2026-01-01T00:00:00.000Z',
          blockers: ['binding_expired'],
        },
      ],
      projects: [
        {
          project_id: 'acme',
          view_level: 'V3',
          data_class: 'D1',
          roles: ['project.admin'],
          actions: ['project.view'],
        },
      ],
    };
    const m = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/me/access': { json: access },
      'POST /api/me/decisions': (c) => ({
        json: {
          decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
            ...q,
            allow: q.action === 'project.view',
            reasons: [
              q.action === 'project.view' ? 'role/project.admin/project.view' : 'no_policy_permits',
            ],
          })),
        },
      }),
    });
    renderAt('/me/access');
    expect(await screen.findByRole('heading', { level: 1, name: 'My access' })).toBeInTheDocument();
    const bindings = await screen.findByRole('table', { name: 'Role bindings' });
    expect(within(bindings).getByRole('rowheader', { name: /project\.admin/ })).toBeInTheDocument();
    expect(within(bindings).getByText('not in force: binding_expired')).toBeInTheDocument();
    const per = screen.getByRole('table', { name: /per project/ });
    const row = within(per).getByRole('row', { name: /acme/ });
    expect(row).toHaveTextContent('V3');
    await waitFor(() => expect(within(row).getAllByText('allowed')).toHaveLength(1));
    expect(within(row).getAllByText(/not allowed/).length).toBeGreaterThan(0);
    expect(decisionsOf(m.calls)).toHaveLength(1);
  });

  it('"Request access" lands on My access with the roles that would grant the action', async () => {
    mockApi({ 'GET /api/me': { json: me() } });
    renderAt('/me/access?want=gate.decide&project=acme&gate=G2');
    const panel = await screen.findByTestId('request-access');
    const roles = within(panel).getByRole('list', { name: 'Roles that grant it' });
    expect(roles).toHaveTextContent('project.intent_approver');
    expect(roles).not.toHaveTextContent('factory.admin');
  });

  it('an unknown path is the same 404 as an invisible thing', async () => {
    mockApi({ 'GET /api/me': { json: me() } });
    renderAt('/nowhere/at/all');
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing here');
  });
});
