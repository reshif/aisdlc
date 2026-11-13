import {
  DEFAULT_GATING_PROFILE,
  EMPTY_ROLE_MAP,
  GatingProfile,
  RoleMap,
  type DecisionQuery,
} from '@aisdlc/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { projectFloorProblems } from '../src/config/ProjectEditors';
import { me, mockApi, renderAt, type Call } from './helpers';

// P1-5: Project > Settings, the project layer of the configuration console. One tab per key of the layer; the role map
// is edited slot by people, the gating profile as toggles within the T2 floor; a proposal is one POST to the project's
// route with the head it was drafted on; the M1 is decided by the project's admin slot (its revision page).

const P = 'testbed';
const BASE = `/api/projects/${P}/config/keys`;
const HEAD = 'e'.repeat(64);
const GATE = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77';
const schema = (s: z.ZodType) => {
  const j = { ...z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' }) } as Record<
    string,
    unknown
  >;
  delete j['$schema'];
  return j;
};
const summary = (key: string, json_schema: unknown) => ({
  key,
  kind: 'setting',
  description: `the ${key} key`,
  overridable: true,
  json_schema,
});
const view = (key: string, json_schema: unknown, value: unknown, over = {}) => ({
  key: summary(key, json_schema),
  default: value,
  effective: {
    value,
    source: 'revision',
    rev_hash: HEAD,
    gate_instance_id: GATE,
    ledger_entry_id: null,
    published_at: '2026-11-09T10:05:00.000Z',
  },
  head_rev_hash: HEAD,
  pending: [],
  history: [],
  may_propose: true,
  principal_names: { alice: 'Alice Admin' },
  project_id: P,
  tier: 'T1',
  deploys: false,
  ...over,
});
const GP = schema(GatingProfile);
const RM = schema(RoleMap);
const allowSettings = (c: Call) => ({
  json: {
    decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
      ...q,
      allow: q.action === 'project.settings.edit',
      reasons: [],
    })),
  },
});
const keys = {
  json: {
    keys: [summary('project.gating_profile', GP), summary('project.role_map', RM)],
    may_propose: true,
  },
};

describe('Project > Settings (P1-5)', () => {
  it('the gating profile: toggles within the T2 floor, the diff, and one proposal with the head', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${BASE}`]: keys,
      [`GET ${BASE}/project.gating_profile`]: {
        json: view('project.gating_profile', GP, DEFAULT_GATING_PROFILE, { tier: 'T2' }),
      },
      'POST /api/me/decisions': allowSettings,
      [`POST ${BASE}/project.gating_profile/proposals`]: {
        status: 201,
        json: {
          rev_hash: 'c'.repeat(64),
          parent_rev_hash: HEAD,
          gate_instance_id: GATE,
          superseded: [],
        },
      },
    });
    renderAt(`/projects/${P}/settings`);
    expect(await screen.findByRole('tab', { name: 'Approvals on or off' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const editor = await screen.findByTestId('gating-editor');
    // T2: the floor holds g2 on
    const g2 = screen.getByRole('checkbox', { name: /\(g2\) is on/ });
    expect(g2).toBeDisabled();
    expect(editor).toHaveTextContent('Held on by the T2 floor.');
    await user.click(screen.getByRole('checkbox', { name: /\(g6\) is on/ }));
    expect(await screen.findByRole('table', { name: 'Changes in the draft' })).toHaveTextContent(
      'gates.g6',
    );
    const propose = screen.getByRole('button', { name: 'Propose this change' });
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === `${BASE}/project.gating_profile/proposals`)).toBe(true),
    );
    const sent = m.calls.find((c) => c.path === `${BASE}/project.gating_profile/proposals`);
    expect(sent?.body).toMatchObject({
      parent_rev_hash: HEAD,
      value: { gates: { g6: 'off', g2: 'on' } },
    });
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('the role map is edited slot by people; a pending revision links to its project M1', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${BASE}`]: keys,
      [`GET ${BASE}/project.gating_profile`]: {
        json: view('project.gating_profile', GP, DEFAULT_GATING_PROFILE),
      },
      [`GET ${BASE}/project.role_map`]: {
        json: view('project.role_map', RM, EMPTY_ROLE_MAP, {
          pending: [
            {
              revision: {
                rev_hash: 'd'.repeat(64),
                parent_rev_hash: HEAD,
                state: 'proposed',
                gate_instance_id: GATE,
                ledger_entry_id: null,
                proposed_by: 'alice',
                proposed_at: '2026-11-10T10:00:00.000Z',
                published_at: null,
                value: EMPTY_ROLE_MAP,
                set: true,
                changes_key: true,
              },
              gate_status: 'pending',
              deciders: { slot: 'admin', holders: ['alice'] },
            },
          ],
        }),
      },
      'POST /api/me/decisions': allowSettings,
      [`POST ${BASE}/project.role_map/proposals`]: {
        status: 201,
        json: {
          rev_hash: 'c'.repeat(64),
          parent_rev_hash: HEAD,
          gate_instance_id: GATE,
          superseded: [],
        },
      },
    });
    renderAt(`/projects/${P}/settings`);
    await user.click(await screen.findByRole('tab', { name: 'Who decides' }));
    await screen.findByTestId('role-map-editor');
    expect(screen.getByRole('link', { name: 'Open the revision to decide it' })).toHaveAttribute(
      'href',
      `/revisions/${GATE}`,
    );
    expect(screen.getByTestId('cfg-pending')).toHaveTextContent('project’s admin slot');
    await user.type(screen.getByLabelText(/^design:/), 'dee, bob');
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === `${BASE}/project.role_map/proposals`)).toBe(true),
    );
    const sent = m.calls.find((c) => c.path === `${BASE}/project.role_map/proposals`);
    expect((sent?.body as { value: Record<string, unknown> }).value['design']).toEqual({
      kind: 'principals',
      principals: ['dee', 'bob'],
    });
  });

  it('someone who may not propose reads only', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${BASE}`]: { json: { ...keys.json, may_propose: false } },
      [`GET ${BASE}/project.gating_profile`]: {
        json: view('project.gating_profile', GP, DEFAULT_GATING_PROFILE, { may_propose: false }),
      },
    });
    renderAt(`/projects/${P}/settings`);
    expect(await screen.findByTestId('settings-read-only')).toBeInTheDocument();
    expect(await screen.findByTestId('cfg-effective')).toHaveTextContent(
      'a published revision of this project',
    );
  });

  it('the floor problems are the server function on the draft', () => {
    const off = {
      ...DEFAULT_GATING_PROFILE,
      gates: { ...DEFAULT_GATING_PROFILE.gates, g2: 'off' },
    };
    const gp = projectFloorProblems('project.gating_profile');
    expect(gp(off, { tier: 'T2', deploys: false })).toContain('T2 cannot turn off g2 for L4');
    expect(gp(off, { tier: 'T1', deploys: false })).toEqual([]);
    expect(gp(off, { tier: null, deploys: null })).toEqual([]);
    const tp = projectFloorProblems('project.two_person');
    expect(
      tp(
        { enabled: false, default: 'on_if_2plus', locked_on: false },
        { tier: 'T2', deploys: null },
      ),
    ).toEqual(['T2 locks two-person on']);
  });
});
