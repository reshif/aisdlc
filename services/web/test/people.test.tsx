import { OVERRIDE_REASON_HEADER } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { NOW, emptyAccess, me, mockApi, renderAt } from './helpers';

// Portal v2's People, teams & roles (screen map §2.13, §3), the shared delete experience and the factory admin's
// override. Every write is decided on the server; these tests hold what the screens send and show: the person is the
// session's (never in the body), the CSRF token rides on every write, an override's reason rides in its header, a
// delete shows what goes and what stays before anything is sent, and nothing shows a raw role or level code.

const ADMIN_ACTIONS: Me['actions']['fleet'] = [
  'audit.read',
  'identity.admin',
  'access.manage',
  'access.explain',
  'person.delete',
  'team.delete',
  'binding.delete',
];
const admin = (): Me => me(ADMIN_ACTIONS);
const adminAccess = () => ({
  ...emptyAccess(),
  fleet: { view_level: 'V3', data_class: 'D2', roles: ['factory.admin'], actions: [] },
});

const NORA = {
  principal_id: 'nora',
  display_name: 'Nora Newbie',
  display_handle: 'nora',
  kind: 'human',
  status: 'active',
  upn: 'nora@example.test',
  sign_in: 'sso',
  teams: ['payments'],
  roles: 1,
};
const ROOT = {
  ...NORA,
  principal_id: 'root',
  display_name: 'Rita Root',
  display_handle: 'root',
  upn: null,
  sign_in: 'local',
  teams: [],
  roles: 3,
  status: 'disabled',
};
const PAYMENTS = {
  team_id: 'payments',
  name: 'Payments',
  classification: 'internal',
  group_id: 'team.payments',
  members: ['nora'],
  roles: 1,
};
const TEAMS = { teams: [PAYMENTS], names: { nora: 'Nora Newbie' } };
const BINDING = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6b01';
const NORA_DETAIL = {
  person: { ...NORA, logins: [], role_label: null, status_changed_at: NOW },
  groups: [{ group_id: 'person.nora', display: 'Nora Newbie', team_id: null }],
  bindings: [
    {
      binding_id: BINDING,
      role_id: 'project.viewer',
      scope: { kind: 'project', ref: 'acme' },
      expiry: null,
      origin: 'other',
      group_id: 'person.nora',
      team_id: null,
    },
  ],
};
const PREVIEW = {
  kind: 'team',
  id: 'payments',
  counts: {
    record_events_removed: 4,
    record_events_redacted: 1,
    ledger_entries_redacted: 3,
    read_model_rows: 6,
    objects: 0,
  },
  tables: ['identity.team'],
  blockers: [],
};

afterEach(() => window.history.pushState(null, '', '/'));

describe('People', () => {
  it('lists everyone with sign-in, teams and status in words, and finds by name', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/me/access': { json: adminAccess() },
      'GET /api/people': { json: { people: [NORA, ROOT] } },
      'GET /api/teams': { json: TEAMS },
    });
    renderAt('/people');
    const table = await screen.findByRole('table', { name: 'People' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Nora Newbie');
    expect(rows[0]).toHaveTextContent('Company sign-in');
    expect(rows[0]).toHaveTextContent('Payments');
    expect(rows[1]).toHaveTextContent('Local account');
    expect(rows[1]).toHaveTextContent('Suspended');
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'Nora Newbie' }),
    ).toHaveAttribute('href', '/people/nora');
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'rita');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    // the section's own navigation
    const sub = screen.getByRole('navigation', { name: 'People, teams & roles' });
    expect(within(sub).getByRole('link', { name: 'People' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('a person without a fleet role sees the 403 with the reason, and nothing is read', async () => {
    const m = mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/people');
    expect(await screen.findByRole('alert')).toHaveTextContent("You can't open this");
    expect(m.calls.some((c) => c.path === '/api/people')).toBe(false);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'People' })).toBeNull();
  });

  it('empty: says how people appear', async () => {
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/people': { json: { people: [] } },
      'GET /api/teams': { json: { teams: [], names: {} } },
    });
    renderAt('/people');
    expect(await screen.findByText('No people yet')).toBeInTheDocument();
  });

  it('add a person: the form sends the person, never who acts, with the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/people': { json: { people: [] } },
      'GET /api/teams': { json: { teams: [], names: {} } },
      'POST /api/people': { json: { changed: true } },
      'GET /api/people/nora': { json: NORA_DETAIL },
    });
    renderAt('/people');
    await user.click(await screen.findByRole('button', { name: 'Add person' }));
    const d = screen.getByRole('dialog', { name: 'Add person' });
    await user.type(within(d).getByLabelText('Name'), 'Nora Newbie');
    await user.type(within(d).getByLabelText('Company email'), 'nora@example.test');
    expect(within(d).getByLabelText('Handle')).toHaveValue('nora');
    await user.click(within(d).getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(window.location.pathname).toBe('/people/nora'));
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/people');
    expect(post?.body).toEqual({
      principal: {
        kind: 'human',
        logins: [],
        principal_id: 'nora',
        display_name: 'Nora Newbie',
        display_handle: 'nora',
        upn: 'nora@example.test',
        breakglass: false,
      },
    });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('an auditor reads people but the add button is locked with the reason', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/people': { json: { people: [NORA] } },
      'GET /api/teams': { json: TEAMS },
    });
    renderAt('/people');
    await screen.findByRole('table', { name: 'People' });
    const locked = screen.getByRole('button', { name: 'Add person' });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    await user.click(locked);
    expect(screen.getByRole('note')).toHaveTextContent(/factory admin/);
  });
});

describe('one person', () => {
  it('shows the roles in words, gives a role through the person’s own group, and suspends with a reason', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/me/access': { json: adminAccess() },
      'GET /api/people/nora': { json: NORA_DETAIL },
      'GET /api/teams': { json: TEAMS },
      'GET /api/projects': { json: [{ project: { project_id: 'acme' } }] },
      'POST /api/groups': {
        status: 409,
        json: { error: { code: 'already_exists', message: 'x' } },
      },
      'POST /api/groups/person.nora/members': { json: { changed: false } },
      'POST /api/bindings': { json: { changed: true } },
      'POST /api/people/nora/status': { json: { changed: true } },
    });
    renderAt('/people/nora');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Nora Newbie' }),
    ).toBeInTheDocument();
    const roles = screen.getByRole('table', { name: 'Roles of Nora Newbie' });
    expect(roles).toHaveTextContent('Viewer');
    expect(roles).toHaveTextContent('Project acme');
    expect(roles).toHaveTextContent('Given directly');
    expect(roles).not.toHaveTextContent('project.viewer');
    const form = screen.getByRole('form', { name: 'Give Nora Newbie a role' });
    await user.selectOptions(within(form).getByLabelText('Role'), 'Auditor');
    await user.click(within(form).getByRole('button', { name: 'Give role' }));
    await waitFor(() => expect(m.calls.some((c) => c.path === '/api/bindings')).toBe(true));
    expect(m.calls.find((c) => c.path === '/api/bindings')?.body).toEqual({
      group_id: 'person.nora',
      role_id: 'factory.auditor',
      scope: { kind: 'fleet', ref: '*' },
      expiry: null,
    });
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    const d = screen.getByRole('dialog', { name: 'Suspend Nora Newbie?' });
    const go = within(d).getByRole('button', { name: 'Suspend' });
    expect(go).toBeDisabled();
    await user.type(within(d).getByLabelText('Why'), 'on leave');
    await user.click(go);
    await waitFor(() =>
      expect(m.calls.find((c) => c.path === '/api/people/nora/status')?.body).toEqual({
        status: 'disabled',
        reason: 'on leave',
      }),
    );
  });

  it('one 404 for a missing or invisible person', async () => {
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/people/ghost': {
        status: 404,
        json: { error: { code: 'not_found', message: 'x' } },
      },
      'GET /api/teams': { json: TEAMS },
    });
    renderAt('/people/ghost');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
  });
});

describe('teams and the shared delete', () => {
  it('a team page lists its members and deletes it after the preview, the name typed and a reason', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/me/access': { json: adminAccess() },
      'GET /api/teams/payments': {
        json: {
          team: PAYMENTS,
          members: [{ principal_id: 'nora', display_name: 'Nora Newbie', status: 'active' }],
          bindings: [],
        },
      },
      'GET /api/people': { json: { people: [NORA, ROOT] } },
      'GET /api/projects': { json: [] },
      'GET /api/teams': { json: TEAMS },
      'POST /api/deletions/preview': { json: PREVIEW },
      'DELETE /api/teams/payments': {
        json: {
          deletion_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6b09',
          kind: 'team',
          counts: PREVIEW.counts,
          objects_purged: true,
          ledger_entry_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6b0a',
        },
      },
    });
    renderAt('/teams/payments');
    const members = await screen.findByRole('table', { name: 'Members of Payments' });
    expect(members).toHaveTextContent('Nora Newbie');
    await user.click(screen.getByRole('button', { name: 'Delete team Payments' }));
    const d = await screen.findByRole('dialog', { name: 'Delete team Payments?' });
    // what goes and what stays, before anything is sent
    expect(await within(d).findByRole('list', { name: 'What goes' })).toHaveTextContent(
      '5 history events',
    );
    expect(d).toHaveTextContent('The decision log keeps 3 hashes so the chain still verifies');
    const del = within(d).getByRole('button', { name: 'Delete team Payments' });
    await user.type(within(d).getByLabelText(/to confirm/), 'Payments');
    expect(del).toBeDisabled(); // a reason too
    await user.type(within(d).getByLabelText('Why'), 'the team was merged');
    expect(m.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(del);
    expect(await screen.findByRole('dialog', { name: 'Deleted' })).toHaveTextContent(
      '3 decision log entries now show as hashes only',
    );
    const sent = m.calls.find((c) => c.method === 'DELETE');
    expect(sent?.body).toEqual({ reason: 'the team was merged', confirm: 'payments' });
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(sent?.headers[OVERRIDE_REASON_HEADER]).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(window.location.pathname).toBe('/teams'));
  });

  it('a legal hold is shown first and the delete cannot be confirmed', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/teams/payments': {
        json: { team: PAYMENTS, members: [], bindings: [] },
      },
      'GET /api/people': { json: { people: [] } },
      'GET /api/projects': { json: [] },
      'POST /api/deletions/preview': {
        json: { ...PREVIEW, blockers: [{ kind: 'legal_hold', message: 'matter LA-3' }] },
      },
    });
    renderAt('/teams/payments');
    await user.click(await screen.findByRole('button', { name: 'Delete team Payments' }));
    const d = await screen.findByRole('dialog', { name: 'Delete team Payments?' });
    expect(await within(d).findByRole('alert')).toHaveTextContent('A legal hold covers this');
    await user.type(within(d).getByLabelText(/to confirm/), 'Payments');
    await user.type(within(d).getByLabelText('Why'), 'merged');
    expect(within(d).getByRole('button', { name: 'Delete team Payments' })).toBeDisabled();
  });

  it('when only the override permits it, the reason is asked and sent in its header', async () => {
    const user = userEvent.setup();
    let n = 0;
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/teams/payments': { json: { team: PAYMENTS, members: [], bindings: [] } },
      'GET /api/people': { json: { people: [] } },
      'GET /api/projects': { json: [] },
      'POST /api/deletions/preview': { json: PREVIEW },
      'DELETE /api/teams/payments': () =>
        ++n === 1
          ? {
              status: 403,
              json: { error: { code: 'override_reason_required', message: 'give a reason' } },
            }
          : {
              json: {
                deletion_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6b09',
                kind: 'team',
                counts: PREVIEW.counts,
                objects_purged: true,
                ledger_entry_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6b0a',
              },
            },
    });
    renderAt('/teams/payments');
    await user.click(await screen.findByRole('button', { name: 'Delete team Payments' }));
    const d = await screen.findByRole('dialog', { name: 'Delete team Payments?' });
    await within(d).findByRole('list', { name: 'What goes' });
    await user.type(within(d).getByLabelText(/to confirm/), 'Payments');
    await user.type(within(d).getByLabelText('Why'), 'merged');
    await user.click(within(d).getByRole('button', { name: 'Delete team Payments' }));
    const ask = await screen.findByRole('dialog', { name: /as factory admin/ });
    const confirm = within(ask).getAllByRole('button').at(-1) as HTMLElement;
    expect(confirm).toBeDisabled(); // never blank
    await user.type(within(ask).getByLabelText('Reason for the override'), 'owner asked');
    await user.click(confirm);
    expect(await screen.findByRole('dialog', { name: 'Deleted' })).toBeInTheDocument();
    const dels = m.calls.filter((c) => c.method === 'DELETE');
    expect(dels).toHaveLength(2);
    expect(dels[0]?.headers[OVERRIDE_REASON_HEADER]).toBeUndefined();
    expect(decodeURIComponent(dels[1]?.headers[OVERRIDE_REASON_HEADER] ?? '')).toBe('owner asked');
  });

  it('add a team creates its member group and the team', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/teams': { json: { teams: [], names: {} } },
      'POST /api/groups': { json: { changed: true } },
      'POST /api/teams': { json: { changed: true } },
      'GET /api/teams/data-platform': {
        json: {
          team: { ...PAYMENTS, team_id: 'data-platform', name: 'Data platform', members: [] },
          members: [],
          bindings: [],
        },
      },
      'GET /api/people': { json: { people: [] } },
      'GET /api/projects': { json: [] },
    });
    renderAt('/teams');
    expect(await screen.findByText('No teams yet.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Add team' })[0] as HTMLElement);
    const d = screen.getByRole('dialog', { name: 'Add team' });
    await user.type(within(d).getByLabelText('Name'), 'Data platform');
    await user.click(within(d).getByRole('button', { name: 'Add team' }));
    await waitFor(() => expect(window.location.pathname).toBe('/teams/data-platform'));
    const posts = m.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]);
    expect(posts).toEqual([
      [
        '/api/groups',
        {
          group: {
            group_id: 'team.data-platform',
            display: 'Data platform',
            pim_managed: false,
            protected: false,
          },
        },
      ],
      [
        '/api/teams',
        {
          team: {
            team_id: 'data-platform',
            name: 'Data platform',
            classification: 'internal',
            idp_group: 'team.data-platform',
          },
        },
      ],
    ]);
  });
});

const GRANT = {
  grant_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6c01',
  change: {
    op: 'grant',
    target: { kind: 'principal', principal_id: 'alice' },
    role_id: 'project.viewer',
    scope: { kind: 'project', ref: 'acme' },
    expiry: null,
  },
  origin: 'request',
  reason: 'joining acme',
  proposed_by: 'alice',
  project_id: 'acme',
  gate_instance_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6c02',
  subject_hash: 'a'.repeat(64),
  gate_status: 'pending',
  outcome: null,
  status: 'pending',
  deciders: ['amy'],
  quorum: 1,
  proposed_at: NOW,
  applied: null,
  may_decide: false,
};

describe('access requests', () => {
  it('lists what waits; the factory admin answers their own request with a reason, sent on every step', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/me/access': { json: adminAccess() },
      'GET /api/access/grants': { json: { grants: [GRANT] } },
      [`GET /api/access/grants/${GRANT.grant_id}`]: { json: GRANT },
      'GET /api/people': {
        json: { people: [{ ...NORA, principal_id: 'alice', display_name: 'Alice Admin' }] },
      },
      [`POST /api/access/grants/${GRANT.grant_id}/prepare`]: {
        json: {
          nonce: 'n'.repeat(32),
          expires_at: NOW,
          evidence_hash: 'b'.repeat(64),
          step_up: { required: false, bound_hash: 'c'.repeat(64) },
        },
      },
      [`POST /api/access/grants/${GRANT.grant_id}/evidence`]: { json: { evidence_viewed: true } },
      [`POST /api/access/grants/${GRANT.grant_id}/decide`]: {
        json: { outcome: 'approve', status: 'applied', applied: true, apply_error: null },
      },
    });
    renderAt('/access-requests');
    const t = await screen.findByRole('table', { name: 'Access requests' });
    expect(within(t).getAllByRole('row')[1]).toHaveTextContent('Viewer');
    expect(t).not.toHaveTextContent('project.viewer');
    await user.click(within(t).getByRole('link', { name: 'Alice Admin' }));
    await user.click(await screen.findByRole('button', { name: 'Answer as factory admin' }));
    const ask = screen.getByRole('dialog', { name: 'Answer as factory admin' });
    await user.type(within(ask).getByLabelText('Reason for the override'), 'acme admins away');
    await user.click(within(ask).getByRole('button', { name: 'Answer as factory admin' }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/the role is changed/)).toBeInTheDocument();
    const steps = m.calls.filter((c) => c.path.startsWith(`/api/access/grants/${GRANT.grant_id}/`));
    expect(steps.map((c) => c.path.split('/').at(-1))).toEqual(['prepare', 'evidence', 'decide']);
    for (const c of steps) {
      expect(decodeURIComponent(c.headers[OVERRIDE_REASON_HEADER] ?? '')).toBe('acme admins away');
    }
    expect(steps[2]?.body).toEqual({ nonce: 'n'.repeat(32), decision: 'approve' });
  });

  it('someone who does not answer it sees who does, and no buttons', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/access/grants/${GRANT.grant_id}`]: { json: GRANT },
    });
    renderAt(`/access/grants/${GRANT.grant_id}`);
    expect(await screen.findByText(/You do not answer this one/)).toHaveTextContent('amy can.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('roles and who can do what', () => {
  it('roles read the setting: a custom role is shown by its words, what each may do in plain words', async () => {
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/config/keys/access.roles': {
        json: {
          key: {},
          default: null,
          effective: {
            value: {
              roles: [
                {
                  role_id: 'factory.auditor',
                  description: 'Reads the whole factory record; decides nothing',
                  scope_kinds: ['fleet'],
                  slot: null,
                  approval_capable: false,
                  privileged: false,
                  service_only: false,
                  implicit_grant: false,
                  requires_qualification: null,
                  view_level: 'V3',
                  data_class_default: 'D2',
                },
                {
                  role_id: 'project.reporter',
                  description: 'Reporter: reads a project for weekly reports',
                  scope_kinds: ['project'],
                  slot: null,
                  approval_capable: false,
                  privileged: false,
                  service_only: false,
                  implicit_grant: false,
                  requires_qualification: null,
                  view_level: 'V1',
                  data_class_default: 'D0',
                },
              ],
              grants: {},
            },
            source: 'revision',
            rev_hash: null,
            gate_instance_id: null,
            ledger_entry_id: null,
            published_at: null,
          },
          head_rev_hash: null,
          pending: [],
          history: [],
          may_propose: true,
          principal_names: {},
        },
      },
    });
    renderAt('/roles');
    const t = await screen.findByRole('table', { name: 'Roles' });
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Auditor');
    expect(rows[0]).toHaveTextContent('Read the audit trail');
    expect(rows[0]).toHaveTextContent('Everything');
    expect(rows[1]).toHaveTextContent('Reporter');
    expect(rows[1]).toHaveTextContent('Custom');
    expect(t).not.toHaveTextContent('V3');
    expect(t).not.toHaveTextContent('factory.auditor');
    expect(screen.getByRole('link', { name: 'Change roles' })).toHaveAttribute(
      'href',
      '/config/access.roles',
    );
  });

  it('who can: the people the policy allows the chosen action on the project, and why', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/projects': { json: [{ project: { project_id: 'acme' } }] },
      'GET /api/projects/acme/explain': {
        json: {
          project_id: 'acme',
          as_of: NOW,
          holders: [
            {
              principal_id: 'amy',
              display_name: 'Amy Approver',
              roles: ['project.intent_approver'],
              scopes: [{ kind: 'project', ref: 'acme' }],
              view_level: 'V2',
              data_class: 'D1',
              actions: ['gate.decide', 'project.view'],
            },
            {
              principal_id: 'vic',
              display_name: 'Vic Viewer',
              roles: ['project.viewer'],
              scopes: [{ kind: 'project', ref: 'acme' }],
              view_level: 'V1',
              data_class: 'D0',
              actions: ['project.view'],
            },
          ],
        },
      },
    });
    renderAt('/who-can');
    const card = await screen.findByRole('table', { name: /Who can Decide approvals on acme/ });
    expect(card).toHaveTextContent('Amy Approver');
    expect(card).toHaveTextContent('Request and spec approver');
    expect(card).not.toHaveTextContent('Vic Viewer');
    await user.selectOptions(screen.getByLabelText('Who can…'), 'See the project');
    expect(await screen.findByRole('table', { name: /See the project on acme/ })).toHaveTextContent(
      'Vic Viewer',
    );
  });
});

describe('decision log', () => {
  it('shows overrides with their reason and deletions as hash-only entries, and pages back', async () => {
    const user = userEvent.setup();
    const entry = (seq: number, over: object) => ({
      ledger_seq: seq,
      entry_id: `0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6d${String(seq).padStart(2, '0')}`,
      entry_type: 'decision',
      gate_id: null,
      gate_instance_id: null,
      step: null,
      card_id: null,
      subject_kind: null,
      subject_id: null,
      decision: null,
      actor: 'root',
      sod_waiver: false,
      created_at: NOW,
      entry_hash: String(seq % 10).repeat(64),
      prev_hash: null,
      override_reason: null,
      deletion: null,
      ...over,
    });
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/people': { json: { people: [{ ...ROOT, display_name: 'Rita Root' }] } },
      'GET /api/audit/ledger?filter=all': {
        json: {
          entries: [
            entry(9, { entry_type: 'admin.override', override_reason: 'owner asked' }),
            entry(8, {
              entry_type: 'deletion.performed',
              deletion: { kind: 'team', redacted: 3, override: false },
            }),
            entry(7, { entry_type: 'redacted', actor: null }),
          ],
          head: { ledger_seq: 9, entry_hash: '9'.repeat(64) },
          next_before: 7,
        },
      },
      'GET /api/audit/ledger?filter=all&before=7': {
        json: {
          entries: [
            entry(6, { gate_id: 'G3', decision: 'approve', actor: 'deleted.0123456789abcdef' }),
          ],
          head: null,
          next_before: null,
        },
      },
    });
    renderAt('/audit');
    const t = await screen.findByRole('table', { name: 'Decision log' });
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Factory admin override');
    expect(rows[0]).toHaveTextContent('“owner asked”');
    expect(rows[0]).toHaveTextContent('Rita Root');
    expect(rows[1]).toHaveTextContent('Team deleted; 3 entries now hash only');
    expect(rows[2]).toHaveTextContent('Hash only');
    await user.click(screen.getByRole('button', { name: 'Show older entries' }));
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(5));
    expect(within(t).getAllByRole('row')[4]).toHaveTextContent('Deleted person');
  });

  it('a person with no audit role gets the 403', async () => {
    mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/audit');
    expect(await screen.findByRole('alert')).toHaveTextContent("You can't open this");
  });
});

describe('my profile', () => {
  it('shows who I am, my roles in words and my teams', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/me/access': {
        json: {
          ...emptyAccess(),
          bindings: [
            {
              binding_id: 'b1',
              role_id: 'project.viewer',
              scope: { kind: 'project', ref: 'acme' },
              project_id: 'acme',
              group_id: 'team.payments',
              group_display: 'Payments',
              source: 'manual',
              expiry: null,
              blockers: [],
            },
          ],
        },
      },
    });
    renderAt('/me');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Alice Admin' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Roles in force' })).toHaveTextContent(
      'Viewer · Project acme',
    );
    expect(screen.getByRole('list', { name: 'Teams' })).toHaveTextContent('Payments');
  });
});

describe('phone width (390px)', () => {
  it('the People screens collapse every grid to one column and the tables scroll in their own box', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'admin', 'admin.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 860px)'));
    expect(phone).toMatch(/\.adm-form-row\s*{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.adm-tools > label\s*{[^}]*width: 100%/);
    // no fixed widths that could push the page sideways
    expect(css).not.toMatch(/(?<![-\w])width:\s*[4-9]\d\dpx/);
  });

  it('renders the people list at 390px without a table wider than its box', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET /api/me': { json: admin() },
      'GET /api/people': { json: { people: [NORA] } },
      'GET /api/teams': { json: TEAMS },
    });
    renderAt('/people');
    const t = await screen.findByRole('table', { name: 'People' });
    expect(t.closest('.ui-tbl-wrap')).not.toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });
});
