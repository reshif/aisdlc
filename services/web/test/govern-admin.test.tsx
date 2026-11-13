import { ROLE_CATALOGUE } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { NOW, me, mockApi, renderAt } from './helpers';
import { SHA_A, SHA_B, T, ledgerEntry } from './screenFixtures';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H5 = '5'.repeat(64);

/** A project admin of `testbed` (audit.read and access.explain there, nothing on the fleet). */
const projectAdmin = (): Me => ({
  ...me([]),
  actions: {
    fleet: [],
    projects: [
      { project_id: 'testbed', actions: ['audit.read', 'access.explain', 'project.view'] },
    ],
  },
});

describe('govern: ledger', () => {
  it('a project reader picks among their projects; each entry says how it links to the one before', async () => {
    mockApi({
      'GET /api/me': { json: projectAdmin() },
      'GET /api/projects/testbed/ledger': {
        json: {
          project_id: 'testbed',
          s0_id: null,
          entries: [
            ledgerEntry(1, null, H1),
            ledgerEntry(2, H1, H2),
            ledgerEntry(5, '4'.repeat(64), H5),
          ],
          head: { ledger_seq: 9, entry_hash: SHA_B },
        },
      },
    });
    renderAt('/ledger');
    const table = await screen.findByRole('table', { name: 'Ledger entries of testbed' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('genesis');
    expect(rows[1]).toHaveTextContent('links to #1');
    expect(rows[2]).toHaveTextContent('another project');
    expect(screen.getByRole('list', { name: "This project's ledger" })).toHaveTextContent(
      'consistent',
    );
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('testbed');
    // the nav lists the ledger for a project reader, and not the fleet's audit log
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Decision log' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Access decisions' })).toBeNull();
  });

  it('a broken link on screen is said, never hidden', async () => {
    mockApi({
      'GET /api/me': { json: projectAdmin() },
      'GET /api/projects/testbed/ledger': {
        json: {
          project_id: 'testbed',
          s0_id: null,
          entries: [ledgerEntry(1, null, H1), ledgerEntry(2, SHA_A, H2)],
          head: null,
        },
      },
    });
    renderAt('/ledger');
    expect(await screen.findByText('1 broken')).toBeInTheDocument();
  });
});

describe('govern: audit and catalogue', () => {
  it('audit: the decision log, filtered by action', async () => {
    const user = userEvent.setup();
    const row = (over: Record<string, unknown>) => ({
      decision_id: 'd1',
      principal: 'eve',
      action: 'audit.read',
      resource: {
        type: 'Fleet',
        id: 'fleet',
        project: null,
        lane: null,
        item: null,
        gate_id: null,
      },
      decision: 'deny',
      reasons: ['no_policy_permits'],
      bundle_version: '1.3.0',
      at: T,
      logged_because: 'deny',
      ...over,
    });
    const m = mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/audit/exports': { json: { exports: [] } },
      'GET /api/audit/decisions?limit=200': { json: { decisions: [row({})] } },
      'GET /api/audit/decisions?limit=200&action=kill.request': {
        json: {
          decisions: [
            row({
              decision_id: 'd2',
              action: 'kill.request',
              decision: 'allow',
              logged_because: 'action',
            }),
          ],
        },
      },
    });
    renderAt('/audit');
    await user.click(await screen.findByRole('tab', { name: 'Decision log' }));
    const t = await screen.findByRole('table', { name: 'Policy decisions' });
    expect(within(t).getAllByText('deny')).toHaveLength(2);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'kill.request');
    expect(await screen.findByText('action')).toBeInTheDocument();
    expect(m.calls.map((c) => c.path)).toContain(
      '/api/audit/decisions?limit=200&action=kill.request',
    );
  });

  it('catalogue: every release, the current one marked, its lanes with their gates', async () => {
    const user = userEvent.setup();
    const lanes = [
      {
        lane: 'L3',
        label: 'small change',
        enter_at: '2.1',
        stages: ['S2', 'S6', 'S7'],
        gates: [{ gate: 'G4', step: '7.6', presence: 'required' }],
      },
    ];
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/catalogue': {
        json: {
          versions: [
            { ref: { version: '1.2.0', hash: SHA_A }, current: false, pinned_items: 4, lanes: [] },
            { ref: { version: '1.3.0', hash: SHA_B }, current: true, pinned_items: 7, lanes },
          ],
        },
      },
    });
    renderAt('/catalogue');
    const rel = await screen.findByRole('table', { name: 'Catalogue releases' });
    const rows = within(rel).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('new items pin this');
    expect(rows[0]).toHaveTextContent('7');
    expect(screen.getByRole('table', { name: 'Lanes of catalogue 1.3.0' })).toHaveTextContent(
      'S2 → S6 → S7',
    );
    await user.click(within(rel).getByRole('button', { name: '1.2.0' }));
    expect(await screen.findByText(/did not verify against its pin/)).toBeInTheDocument();
  });
});

describe('admin', () => {
  it('people and teams from the directory', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/directory': {
        json: {
          principals: [
            {
              principal_id: 'alice',
              display_handle: 'alice',
              display_name: 'Alice Admin',
              kind: 'human',
              status: 'active',
            },
          ],
          teams: [
            { team_id: 'team-a', name: 'Payments', classification: 'internal', idp_group: null },
          ],
        },
      },
    });
    const v = renderAt('/people');
    expect(await screen.findByRole('table', { name: 'People' })).toHaveTextContent('Alice Admin');
    v.unmount();
    renderAt('/teams');
    expect(await screen.findByRole('table', { name: 'Teams' })).toHaveTextContent('Payments');
  });

  it('roles are the catalogue itself, read without a call; access requests list the proposals', async () => {
    const { calls } = mockApi({ 'GET /api/me': { json: me([]) } });
    const v = renderAt('/roles');
    const t = await screen.findByRole('table', { name: 'Roles' });
    expect(within(t).getAllByRole('row')).toHaveLength(ROLE_CATALOGUE.length + 1);
    expect(t).toHaveTextContent('project.admin');
    // the shell's inbox count aside, the screen reads nothing
    expect(calls.map((c) => c.path).filter((p) => p !== '/api/inbox')).toEqual(['/api/me']);
    // a person with no fleet role: the nav keeps what everyone may read and nothing else of Admin
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Settings shows for the one page under it everyone may read (Tracks and limits), and links there
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/catalogue',
    );
    expect(within(nav).queryByRole('link', { name: 'People' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Who can do what' })).toBeNull();
    v.unmount();
    renderAt('/access-requests');
    expect(await screen.findByText('No grant, revoke or request.')).toBeInTheDocument();
  });

  it("who can do what: the holders of a project with the PDP's actions; without access.explain a 403", async () => {
    mockApi({
      'GET /api/me': { json: projectAdmin() },
      'GET /api/projects/testbed/explain': {
        json: {
          project_id: 'testbed',
          as_of: NOW,
          holders: [
            {
              principal_id: 'bob',
              display_name: 'Bob Builder',
              roles: ['project.intent_approver'],
              scopes: [{ kind: 'project', ref: 'testbed' }],
              view_level: 'V2',
              data_class: 'D1',
              actions: ['project.view', 'gate.view'],
            },
          ],
        },
      },
    });
    const v = renderAt('/access-explain');
    const t = await screen.findByRole('table', { name: 'Who can do what on testbed' });
    expect(t).toHaveTextContent('Bob Builder');
    expect(t).toHaveTextContent('V2 · D1');
    expect(t).toHaveTextContent('gate.view');
    v.unmount();
    mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/access-explain');
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
  });
});
