import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Me } from '../src/api';
import { inboxHref, inboxWhat } from '../src/work/words';
import { me, mockApi, renderAt, type Call } from './helpers';

// P1-6 in the portal: People grants and revokes behind `access.manage` (hints from the PDP, `Guarded`), the role
// map's bindings are not revoked here, a proposal is decided on its own page (prepare, evidence, vote), My access asks
// for a role, and the inbox links an access grant to that page.

const GRANT = '01900000-0000-7000-8000-0000000000a1';
const GATE = '01900000-0000-7000-8000-0000000000b1';
const SHA = 'a'.repeat(64);

/** A factory admin: the directory and access.manage on the fleet. */
const fleetAdmin = (): Me => me(['audit.read', 'access.manage']);
/** A project admin of `acme`: access.manage there, nothing on the fleet. */
const projectAdmin = (): Me => ({
  ...me([]),
  actions: {
    fleet: [],
    projects: [{ project_id: 'acme', actions: ['access.manage', 'project.view'] }],
  },
});

const allowManage = (c: Call) => ({
  json: {
    decisions: (
      (c.body as { queries: Array<{ action: string; resource: unknown }> }).queries ?? []
    ).map((q) => ({ ...q, allow: q.action === 'access.manage', reasons: [] })),
  },
});

const directory = {
  principals: [
    {
      principal_id: 'dora',
      display_handle: 'dora',
      display_name: 'Dora',
      kind: 'human',
      status: 'active',
    },
  ],
  teams: [{ team_id: 'audit', name: 'Audit', classification: 'internal', idp_group: 'idp-audit' }],
};
const bindings = {
  bindings: [
    {
      binding_id: '01900000-0000-7000-8000-0000000000c1',
      group_id: 'rm.acme.admin',
      role_id: 'project.admin',
      scope: { kind: 'fleet', ref: '*' },
      expiry: null,
      origin: 'role_map',
      members: ['alice'],
    },
    {
      binding_id: '01900000-0000-7000-8000-0000000000c2',
      group_id: 'grant.dora',
      role_id: 'factory.auditor',
      scope: { kind: 'fleet', ref: '*' },
      expiry: null,
      origin: 'access_grant',
      members: ['dora'],
    },
  ],
};
const grantView = (over: Record<string, unknown> = {}) => ({
  grant_id: GRANT,
  change: {
    op: 'grant',
    target: { kind: 'principal', principal_id: 'dora' },
    role_id: 'factory.auditor',
    scope: { kind: 'fleet', ref: '*' },
    expiry: null,
  },
  origin: 'request',
  reason: 'quarterly audit',
  proposed_by: 'dora',
  project_id: 'factory',
  gate_instance_id: GATE,
  subject_hash: SHA,
  gate_status: 'pending',
  outcome: null,
  status: 'pending',
  deciders: ['alice'],
  quorum: 1,
  proposed_at: '2026-11-08T10:00:00.000Z',
  applied: null,
  may_decide: true,
  ...over,
});

describe('People: grant and revoke', () => {
  it('a factory admin proposes a grant to a person from the directory', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/me': { json: fleetAdmin() },
      'GET /api/directory': { json: directory },
      'GET /api/access/bindings?scope=fleet%3A*': { json: bindings },
      'POST /api/me/decisions': allowManage,
      'POST /api/access/grants': {
        status: 201,
        json: { grant_id: GRANT, gate_instance_id: GATE, deciders: ['rita'] },
      },
    });
    renderAt('/people');
    const form = await screen.findByRole('form', { name: 'Grant a role' });
    // only the roles beyond a role map: no slot role is offered
    const role = within(form).getByRole('combobox', { name: 'Role' });
    const offered = within(role)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(offered).toContain('factory.admin');
    expect(offered).not.toContain('project.admin');
    await user.selectOptions(role, 'factory.auditor');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Person' }), 'dora');
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'audit');
    await user.click(await within(form).findByRole('button', { name: 'Propose the grant' }));
    expect(await within(screen.getByTestId('grant-panel')).findByRole('status')).toHaveTextContent(
      'waiting for rita',
    );
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/access/grants');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(post?.body).toEqual({
      change: {
        op: 'grant',
        target: { kind: 'principal', principal_id: 'dora' },
        role_id: 'factory.auditor',
        scope: { kind: 'fleet', ref: '*' },
        expiry: null,
      },
      reason: 'audit',
    });
  });

  it('a role-map binding is not revoked here; a granted one is a revoke proposal with a reason', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/me': { json: fleetAdmin() },
      'GET /api/directory': { json: directory },
      'GET /api/access/bindings?scope=fleet%3A*': { json: bindings },
      'POST /api/me/decisions': allowManage,
      'POST /api/access/grants': {
        status: 201,
        json: { grant_id: GRANT, gate_instance_id: GATE, deciders: ['rita'] },
      },
    });
    renderAt('/people');
    const table = await screen.findByRole('table', { name: 'Bindings on whole factory' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('change it in Project settings');
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    await user.click(await within(rows[1] as HTMLElement).findByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Propose a revoke' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'left');
    await user.click(within(dialog).getByRole('button', { name: 'Propose the revoke' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/api/access/grants')?.body,
      ).toEqual({
        change: {
          op: 'revoke',
          binding_id: '01900000-0000-7000-8000-0000000000c2',
          group_id: 'grant.dora',
          role_id: 'factory.auditor',
          scope: { kind: 'fleet', ref: '*' },
        },
        reason: 'left',
      }),
    );
  });

  it('a project admin sees People for their project only, without the directory', async () => {
    const { calls } = mockApi({
      'GET /api/me': { json: projectAdmin() },
      'GET /api/access/bindings?scope=project%3Aacme': { json: { bindings: [] } },
      'POST /api/me/decisions': allowManage,
    });
    renderAt('/people');
    const form = await screen.findByRole('form', { name: 'Grant a role' });
    const scope = within(form).getByRole('combobox', { name: 'Scope' });
    expect(
      within(scope)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['project acme']);
    expect(within(form).getByRole('textbox', { name: 'Principal id' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/directory')).toBe(false);
  });

  it('without access.manage anywhere there is no grant form and no bindings panel', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/directory': { json: directory },
    });
    renderAt('/people');
    expect(await screen.findByRole('table', { name: 'People' })).toBeInTheDocument();
    expect(screen.queryByTestId('grant-panel')).toBeNull();
    expect(screen.queryByTestId('bindings-panel')).toBeNull();
  });
});

describe('deciding a proposal', () => {
  it('read the change, then approve: prepare, evidence, decide', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/me': { json: fleetAdmin() },
      [`GET /api/access/grants/${GRANT}`]: { json: grantView() },
      [`POST /api/access/grants/${GRANT}/prepare`]: {
        json: { nonce: 'n1', expires_at: '2026-11-08T11:00:00.000Z', evidence_hash: SHA },
      },
      [`POST /api/access/grants/${GRANT}/evidence`]: { json: { evidence_viewed: true } },
      [`POST /api/access/grants/${GRANT}/decide`]: {
        json: { outcome: 'approve', status: 'applied', applied: true, apply_error: null },
      },
    });
    renderAt(`/access/grants/${GRANT}`);
    expect(
      await screen.findByText(/grant factory.auditor to dora on whole factory/),
    ).toBeInTheDocument();
    const box = screen.getByTestId('grant-decide');
    await user.click(within(box).getByRole('button', { name: 'I have read the change' }));
    await user.click(await within(box).findByRole('button', { name: 'Approve' }));
    expect(await within(box).findByRole('status')).toHaveTextContent('the binding is changed');
    expect(calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({
      nonce: 'n1',
      decision: 'approve',
    });
  });

  it('a two-person vote asks for a step-up first and sends the proof with the vote', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/me': { json: fleetAdmin() },
      [`GET /api/access/grants/${GRANT}`]: { json: grantView({ quorum: 2 }) },
      [`POST /api/access/grants/${GRANT}/prepare`]: {
        json: {
          nonce: 'n1',
          expires_at: '2026-11-08T11:00:00.000Z',
          evidence_hash: SHA,
          step_up: { required: true, bound_hash: SHA },
        },
      },
      [`POST /api/access/grants/${GRANT}/evidence`]: { json: { evidence_viewed: true } },
      'POST /api/step-up': { json: { status: 'ready', method: 'dev', proof: 'p-1' } },
      [`POST /api/access/grants/${GRANT}/decide`]: {
        json: { outcome: null, status: 'pending', applied: false, apply_error: null },
      },
    });
    renderAt(`/access/grants/${GRANT}`);
    const box = await screen.findByTestId('grant-decide');
    await user.click(within(box).getByRole('button', { name: 'I have read the change' }));
    const approve = await within(box).findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(within(box).getByTestId('stepup')).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Confirm my identity' }));
    await waitFor(() => expect(approve).toBeEnabled());
    await user.click(approve);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({
        nonce: 'n1',
        decision: 'approve',
        step_up: { proof: 'p-1' },
      }),
    );
  });

  it('a proposal someone else decides shows no decision buttons', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/access/grants/${GRANT}`]: { json: grantView({ may_decide: false }) },
    });
    renderAt(`/access/grants/${GRANT}`);
    expect(await screen.findByText('You do not decide this one.')).toBeInTheDocument();
    expect(screen.queryByTestId('grant-decide')).toBeNull();
  });
});

describe('access requests', () => {
  it('My access asks for a role for the person; the request is listed', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/access/grants': {
        json: { grants: [grantView({ proposed_by: 'alice', may_decide: false })] },
      },
      'POST /api/access/requests': {
        status: 201,
        json: { grant_id: GRANT, gate_instance_id: GATE, deciders: ['rita', 'root'] },
      },
    });
    renderAt('/me/access');
    const box = await screen.findByTestId('ask-role');
    const form = within(box).getByRole('form', { name: 'Ask for a role' });
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Role' }),
      'factory.auditor',
    );
    await user.type(within(form).getByRole('textbox', { name: 'Why' }), 'audit');
    await user.click(within(form).getByRole('button', { name: 'Ask for it' }));
    expect(await within(box).findByRole('status')).toHaveTextContent('rita, root may decide it');
    expect(calls.find((c) => c.path === '/api/access/requests')?.body).toEqual({
      role_id: 'factory.auditor',
      scope: { kind: 'fleet', ref: '*' },
      expiry: null,
      reason: 'audit',
    });
    expect(
      await screen.findByRole('table', { name: 'Grants, revokes and access requests' }),
    ).toHaveTextContent('grant factory.auditor to dora');
  });

  it('the inbox names an access grant and links to its page', () => {
    const item = {
      kind: 'access_grant',
      id: GRANT,
      project_id: 'factory',
    } as Parameters<typeof inboxWhat>[0];
    expect(inboxWhat(item)).toBe('Role assignment');
    expect(inboxHref(item)).toBe(`/access/grants/${GRANT}`);
  });
});
