import {
  FleetLedgerView,
  PeopleListView,
  PersonDetailView,
  TeamDetailView,
} from '@aisdlc/contracts';
import { grantFleetRole, startTestIdentityApi } from '@aisdlc/identity/testing';
import type { CallResult } from '@aisdlc/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCoreClient, type CoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';

// Portal v2's People, teams & roles through the bff on the real record (docs/design/screen-map.md §2.13, N19): the
// reads come from identity's read model for fleet readers only; the writes go to a real identity API (scope `admin`)
// whose PDP decides each one for the signed-in person. A person with no role reads nothing and writes nothing; an
// auditor reads and cannot write; the factory admin creates a person and a team, puts the person in it and gives the
// team a role, and the person's page shows the role and the team it comes through.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: BffStack;
let identity: { url: string; stop(): Promise<void> };
const TOKEN = 'bff-at-identity-'.padEnd(32, 'x');
/** The identity client is bound after the bff stack (its PDP decides identity's writes). */
let identityClient: CoreClient | null = null;
const lazy: CoreClient = {
  call: (m, p, b): Promise<CallResult> => {
    if (!identityClient) throw new Error('identity not started');
    return identityClient.call(m, p, b);
  },
};
const sessions: Record<string, { browser: Browser; csrf: string }> = {};

beforeAll(async () => {
  s = await startBffStack({ override: { identity: lazy } });
  identity = await startTestIdentityApi(
    s.identity,
    { bff: { token: TOKEN, scopes: ['read', 'admin'] } },
    {
      decide: async (principal, action, resource) => s.pdp.decide({ principal, action, resource }),
    },
  );
  identityClient = new HttpCoreClient({ baseUrl: identity.url, token: TOKEN });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
  await grantFleetRole(s.identity.deps, 'carol', 'factory.auditor');
  for (const who of ['alice', 'carol', 'root'] as const) {
    const { browser } = await signIn(s, who);
    const csrf = ((await (await browser.request(`${s.base}/api/me`)).json()) as Json).csrf_token;
    sessions[who] = { browser, csrf };
  }
}, 120_000);
afterAll(async () => {
  await identity?.stop();
  await s?.stop();
});

async function api(who: string, method: string, path: string, body?: unknown) {
  const x = sessions[who];
  if (!x) throw new Error(`no session for ${who}`);
  const res = await x.browser.request(`${s.base}${path}`, {
    method,
    headers: {
      'x-csrf-token': x.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const NEWBIE = {
  principal_id: 'newbie',
  kind: 'human',
  display_handle: 'newbie',
  display_name: 'Nora Newbie',
  upn: 'nora@example.test',
};

describe('who may read the people screens', () => {
  it('a person with no role reads nothing: people, teams, one person and the decision log are refused', async () => {
    for (const path of ['/api/people', '/api/teams', '/api/people/root', '/api/audit/ledger']) {
      const r = await api('alice', 'GET', path);
      expect(r.status, path).toBe(403);
    }
  });

  it('an auditor reads the list and the decision log', async () => {
    const r = await api('carol', 'GET', '/api/people');
    expect(r.status).toBe(200);
    const v = PeopleListView.parse(r.json);
    expect(v.people.map((p) => p.principal_id)).toEqual(expect.arrayContaining(['alice', 'root']));
    const l = await api('carol', 'GET', '/api/audit/ledger?filter=all&limit=5');
    expect(l.status).toBe(200);
    FleetLedgerView.parse(l.json);
    expect((await api('carol', 'GET', '/api/audit/ledger?filter=nonsense')).status).toBe(400);
  });
});

describe('no write beyond the PDP', () => {
  it('a person with no role cannot create a person, a team or a group, nor grant a role', async () => {
    expect((await api('alice', 'POST', '/api/people', { principal: NEWBIE })).status).toBe(403);
    const team = { team_id: 'rogue', name: 'Rogue', classification: 'internal', idp_group: null };
    expect((await api('alice', 'POST', '/api/teams', { team })).status).toBe(403);
    const grant = await api('alice', 'POST', '/api/bindings', {
      group_id: 'grp-factory.admin',
      role_id: 'factory.admin',
      scope: { kind: 'fleet', ref: '*' },
    });
    expect(grant.status).toBe(403);
    expect(grant.json.error.message).toMatch(/access.manage denied/);
  });

  it('an auditor reads but cannot write', async () => {
    const r = await api('carol', 'POST', '/api/people', { principal: NEWBIE });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/identity.admin denied/);
  });
});

describe('the factory admin runs people and teams from the portal', () => {
  it('creates a person and a team, adds the person, gives the team a role; the person page shows it', async () => {
    const p = await api('root', 'POST', '/api/people', { principal: NEWBIE });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const g = await api('root', 'POST', '/api/groups', {
      group: {
        group_id: 'team.payments',
        display: 'Payments',
        pim_managed: false,
        protected: false,
      },
    });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    const t = await api('root', 'POST', '/api/teams', {
      team: {
        team_id: 'payments',
        name: 'Payments',
        classification: 'internal',
        idp_group: 'team.payments',
      },
    });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const m = await api('root', 'POST', '/api/groups/team.payments/members', {
      principal_id: 'newbie',
    });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    const b = await api('root', 'POST', '/api/bindings', {
      group_id: 'team.payments',
      role_id: 'project.viewer',
      scope: { kind: 'project', ref: 'acme' },
    });
    expect(b.status, JSON.stringify(b.json)).toBe(200);

    const list = PeopleListView.parse((await api('root', 'GET', '/api/people')).json);
    expect(list.people.find((x) => x.principal_id === 'newbie')).toMatchObject({
      display_name: 'Nora Newbie',
      sign_in: 'sso',
      teams: ['payments'],
      roles: 1,
    });
    const one = PersonDetailView.parse((await api('root', 'GET', '/api/people/newbie')).json);
    expect(one.bindings).toEqual([
      expect.objectContaining({
        role_id: 'project.viewer',
        scope: { kind: 'project', ref: 'acme' },
        team_id: 'payments',
      }),
    ]);
    const team = TeamDetailView.parse((await api('root', 'GET', '/api/teams/payments')).json);
    expect(team.members.map((x) => x.principal_id)).toEqual(['newbie']);
    expect(team.bindings.map((x) => x.role_id)).toEqual(['project.viewer']);

    // suspend: the person stays listed, as suspended
    const sus = await api('root', 'POST', '/api/people/newbie/status', {
      status: 'disabled',
      reason: 'on leave',
    });
    expect(sus.status, JSON.stringify(sus.json)).toBe(200);
    const after = PersonDetailView.parse((await api('root', 'GET', '/api/people/newbie')).json);
    expect(after.person.status).toBe('disabled');

    // the access-sync loop ledgers the changes: the decision log shows them under "access"
    await s.identity.sync();
    const l = FleetLedgerView.parse(
      (await api('carol', 'GET', '/api/audit/ledger?filter=access&limit=3')).json,
    );
    expect(l.entries.length).toBe(3);
    expect(l.entries.every((e) => e.entry_type.startsWith('access.'))).toBe(true);
    expect(l.entries[0]!.ledger_seq).toBeGreaterThan(l.entries[1]!.ledger_seq);
    expect(l.next_before).toBe(l.entries[2]!.ledger_seq);
  });

  it('one answer for a missing person and team', async () => {
    expect((await api('root', 'GET', '/api/people/nobody-here')).status).toBe(404);
    expect((await api('root', 'GET', '/api/teams/nope')).status).toBe(404);
  });
});
