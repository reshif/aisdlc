import { SECRET_REF_PATTERN, type DecisionQuery } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { diffValues } from '../src/config/SchemaForm';
import { me, mockApi, renderAt, type Call } from './helpers';

// The configuration console on the two keys core's test proves end to end (sandbox.caps,
// sandbox.exec_allowed_repos). The JSON Schemas here are what core sends for them (core's test
// checks that shape against `z.toJSONSchema` of the contracts' schemas).

const CAPS_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'integer', minimum: 1, maximum: 32 },
    coding: { type: 'integer', minimum: 0, maximum: 8 },
    hosts: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
  },
  required: ['total', 'coding'],
  additionalProperties: false,
};
const REPOS_SCHEMA = {
  type: 'array',
  maxItems: 200,
  items: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
};
const GATE = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77';
const REV = 'b'.repeat(64);

const view = (
  key: string,
  schema: unknown,
  value: unknown,
  over: Record<string, unknown> = {},
) => ({
  key: {
    key,
    kind: 'setting',
    description: `the ${key} key`,
    overridable: false,
    json_schema: schema,
  },
  default: value,
  effective: {
    value,
    source: 'default',
    rev_hash: null,
    gate_instance_id: null,
    ledger_entry_id: null,
    published_at: null,
  },
  head_rev_hash: null,
  pending: [],
  history: [],
  may_propose: true,
  principal_names: { alice: 'Alice Admin', carol: 'Carol Approver' },
  ...over,
});

const decide = (allow: (q: DecisionQuery) => boolean) => (c: Call) => ({
  json: {
    decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
      ...q,
      allow: allow(q),
      reasons: allow(q) ? ['role/factory.admin/config.propose'] : ['no_policy_permits'],
    })),
  },
});

describe('the configuration console', () => {
  it('shows the effective value and its source, and proposes a draft made from the schema form', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      'GET /api/config/keys/sandbox.caps': {
        json: view('sandbox.caps', CAPS_SCHEMA, { total: 4, coding: 1 }),
      },
      'POST /api/me/decisions': decide((q) => q.action === 'config.propose'),
      'POST /api/config/keys/sandbox.caps/proposals': {
        status: 201,
        json: { rev_hash: REV, parent_rev_hash: null, gate_instance_id: GATE, superseded: [] },
      },
    });
    renderAt('/config/sandbox.caps');
    const eff = await screen.findByTestId('cfg-effective');
    expect(within(eff).getByLabelText('Effective value')).toHaveTextContent('"total": 4');
    expect(eff).toHaveTextContent('the registered default');

    const form = screen.getByRole('form', { name: 'Draft of sandbox.caps' });
    const total = within(form).getByRole('spinbutton', { name: 'total' });
    expect(total).toHaveValue(4);
    expect(screen.getByTestId('cfg-nochange')).toBeInTheDocument();
    const propose = await screen.findByRole('button', { name: 'Propose this change' });
    expect(propose).toBeDisabled(); // nothing to propose yet

    await user.clear(total);
    await user.type(total, '6');
    const diff = screen.getByRole('table', { name: 'Changes in the draft' });
    expect(within(diff).getByRole('row', { name: /total/ })).toHaveTextContent('46');
    await user.click(propose);
    await screen.findByText(/Proposed\. The M1 gate .* decides it; nothing changed yet\./);
    const post = m.calls.find((c) => c.path === '/api/config/keys/sandbox.caps/proposals');
    expect(post?.body).toEqual({ value: { total: 6, coding: 1 }, parent_rev_hash: null });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('a draft the schema refuses is said in words and cannot be proposed', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      'GET /api/config/keys/sandbox.caps': {
        json: view('sandbox.caps', CAPS_SCHEMA, { total: 4, coding: 1 }),
      },
      'POST /api/me/decisions': decide(() => true),
    });
    renderAt('/config/sandbox.caps');
    const total = await screen.findByRole('spinbutton', { name: 'total' });
    await user.clear(total);
    await user.type(total, '0');
    expect(screen.getByRole('alert', { name: 'Problems with the draft' })).toHaveTextContent(
      'total must be at least 1',
    );
    expect(await screen.findByRole('button', { name: 'Propose this change' })).toBeDisabled();
  });

  it('an array key: entries are added and removed, and the diff names the index', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      'GET /api/config/keys/sandbox.exec_allowed_repos': {
        json: view('sandbox.exec_allowed_repos', REPOS_SCHEMA, []),
      },
      'POST /api/me/decisions': decide(() => true),
    });
    renderAt('/config/sandbox.exec_allowed_repos');
    await user.click(
      await screen.findByRole('button', { name: 'Add to sandbox.exec_allowed_repos' }),
    );
    await user.type(
      screen.getByRole('textbox', { name: 'sandbox.exec_allowed_repos 1' }),
      'acme/web',
    );
    const diff = screen.getByRole('table', { name: 'Changes in the draft' });
    expect(within(diff).getByRole('rowheader')).toHaveTextContent('[0]');
    expect(diff).toHaveTextContent('"acme/web"');
    await user.click(screen.getByRole('button', { name: 'Remove sandbox.exec_allowed_repos 1' }));
    expect(screen.getByTestId('cfg-nochange')).toBeInTheDocument();
  });

  it('pending proposals say who must decide the M1 gate; the history lists every revision', async () => {
    const rev = {
      rev_hash: REV,
      parent_rev_hash: null,
      state: 'proposed',
      gate_instance_id: GATE,
      ledger_entry_id: null,
      proposed_by: 'alice',
      proposed_at: '2026-11-09T10:00:00.000Z',
      published_at: null,
      value: { total: 6, coding: 2 },
      set: true,
      changes_key: true,
    };
    mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      'GET /api/config/keys/sandbox.caps': {
        json: view(
          'sandbox.caps',
          CAPS_SCHEMA,
          { total: 4, coding: 1 },
          {
            pending: [
              {
                revision: rev,
                gate_status: 'pending',
                deciders: {
                  slot: 'admin',
                  holders: ['carol'],
                  single_operator: true,
                  sod_waiver: true,
                  tier: 'T1',
                  t2: false,
                  can_decide: true,
                  error: null,
                },
              },
            ],
            history: [rev],
          },
        ),
      },
    });
    renderAt('/config/sandbox.caps');
    const pending = await screen.findByTestId('cfg-pending');
    expect(pending).toHaveTextContent('by Alice Admin');
    expect(pending).toHaveTextContent('slot: Carol Approver');
    expect(within(pending).getByLabelText(`Proposed value ${REV}`)).toHaveTextContent('"total": 6');
    const history = screen.getByRole('table', { name: /Revisions of the factory configuration/ });
    expect(within(history).getByText('proposed')).toBeInTheDocument();
  });

  it('someone who may only read sees the propose button locked, with the reason', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/config/keys/sandbox.caps': {
        json: view('sandbox.caps', CAPS_SCHEMA, { total: 4, coding: 1 }, { may_propose: false }),
      },
    });
    renderAt('/config/sandbox.caps');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Propose this change/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(screen.getByRole('button', { name: /Propose this change/ })).toHaveAccessibleDescription(
      /None of your roles allows this here/,
    );
  });

  it('a secret-reference field is edited as a reference, and a value shows as a reference', async () => {
    const schema = {
      type: 'object',
      properties: { secret_ref: { type: 'string', pattern: SECRET_REF_PATTERN.source } },
      required: ['secret_ref'],
    };
    mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      'GET /api/config/keys/x.creds': {
        json: view('x.creds', schema, { secret_ref: 'file:/run/secrets/key' }),
      },
      'POST /api/me/decisions': decide(() => true),
    });
    renderAt('/config/x.creds');
    const field = await screen.findByLabelText(/secret_ref/);
    expect(field.closest('.field')).toHaveTextContent('(a secret reference)');
    expect(field).toHaveValue('file:/run/secrets/key');
    expect(screen.getByText(/never the\s+secret itself/)).toBeInTheDocument();
    expect(screen.getByTestId('cfg-secret-refs')).toHaveTextContent('secret_ref');
  });

  it('the Configuration entry is listed only for an auditor or a proposer', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/projects': { json: [] } });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Configuration' })).toBeNull();
  });

  it('the key list links each registered key to its console', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/config/keys': {
        json: {
          keys: [
            {
              key: 'sandbox.caps',
              kind: 'setting',
              description: 'caps',
              overridable: false,
              json_schema: CAPS_SCHEMA,
            },
          ],
          may_propose: false,
        },
      },
    });
    renderAt('/config');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('link', { name: 'sandbox.caps' })).toHaveAttribute(
      'href',
      '/config/sandbox.caps',
    );
  });
});

describe('diffValues', () => {
  it('names changed leaves by path, with added and removed ones', () => {
    expect(diffValues({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3, 4] }, d: true })).toEqual([
      { path: 'b.c[1]', before: 2, after: 3 },
      { path: 'b.c[2]', before: undefined, after: 4 },
      { path: 'd', before: undefined, after: true },
    ]);
    expect(diffValues(4, 5)).toEqual([{ path: '(value)', before: 4, after: 5 }]);
  });
});
