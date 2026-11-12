import { randomUUID } from 'node:crypto';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBinding,
  createGroup,
  addMember,
  createIdentityApp,
  createTeam,
  freshReadModel,
  queryGrants,
} from '../src/index.js';
import { seedPrincipals, startIdentityStack, type IdentityStack } from '../src/testing.js';

// P1-6: identity's decided grant path. Only a caller with scope `grant` (core) writes a grant, always with the M1
// decision's ledger entry; the `write` scope (the seed) cannot touch a grant group or a grant binding, and only a
// decided revoke ends one.

let s: IdentityStack;
let app: FastifyInstance;
let url: string;
const TOKENS = { core: 'c'.repeat(32), seed: 's'.repeat(32) };
const M_GATE = '01900000-0000-7000-8000-0000000000aa';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

beforeAll(async () => {
  s = await startIdentityStack();
  app = createIdentityApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: { core: ['read', 'grant'], seed: ['read', 'write'] },
    settings: s.settings,
    clock: s.clock,
  });
  url = await listen(app);
  await seedPrincipals(s.deps, ['ada', 'ben', 'cyd']);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

async function call(
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const grant = (over: Record<string, unknown> = {}) => ({
  grant_id: randomUUID(),
  target: { kind: 'principal', principal_id: 'ben' },
  role_id: 'project.viewer',
  scope: { kind: 'project', ref: 'acme' },
  expiry: null,
  m_gate_ref: M_GATE,
  on_behalf_of: 'ada',
  ...over,
});

async function rolesOf(principal: string): Promise<string[]> {
  const f = await freshReadModel(s.record.pool);
  if (!f.ok) throw new Error('read model');
  const g = await queryGrants(s.record.pool, { principal }, null, s.clock.now());
  return g
    .filter((x) => x.blockers.length === 0)
    .map((x) => `${x.role_id}@${x.scope.kind}:${x.scope.ref}`);
}

describe('the grant scope', () => {
  it('only a grant caller writes a grant; the binding is in force, carries the decision, and a repeat is unchanged', async () => {
    const g = grant();
    expect((await call(TOKENS.seed, '/v1/grants', g)).status).toBe(403);
    const r = await call(TOKENS.core, '/v1/grants', g);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ group_id: 'grant.ben', changed: true });
    expect(await rolesOf('ben')).toContain('project.viewer@project:acme');
    const again = await call(TOKENS.core, '/v1/grants', g);
    expect(again.json).toMatchObject({ binding_id: r.json.binding_id, changed: false });
    const f = await freshReadModel(s.record.pool);
    expect(f.ok).toBe(true);
    const row = await s.record.pool.query<{ m_gate_ref: string; constraints: Json }>(
      'SELECT m_gate_ref, constraints FROM identity.binding WHERE binding_id = $1',
      [r.json.binding_id],
    );
    expect(row.rows[0]).toMatchObject({
      m_gate_ref: M_GATE,
      constraints: { origin: 'access_grant', grant_id: g.grant_id },
    });
  });

  it('refuses a slot role, a role at a scope it cannot have, no decision, and an unknown person', async () => {
    expect(
      (await call(TOKENS.core, '/v1/grants', grant({ role_id: 'project.admin' }))).status,
    ).toBe(400);
    expect(
      (await call(TOKENS.core, '/v1/grants', grant({ role_id: 'factory.admin' }))).status,
    ).toBe(400);
    const { m_gate_ref: _drop, ...noGate } = grant();
    expect((await call(TOKENS.core, '/v1/grants', noGate)).status).toBe(400);
    expect(
      (
        await call(
          TOKENS.core,
          '/v1/grants',
          grant({ target: { kind: 'principal', principal_id: 'zed' } }),
        )
      ).status,
    ).toBe(422);
  });

  it('a team grant binds the team IdP group; a team without one is refused', async () => {
    const grp = await createGroup(
      s.deps,
      { group_id: 'idp-auditors', display: 'Auditors', pim_managed: false, protected: false },
      'system.test',
    );
    expect(grp.ok).toBe(true);
    expect(
      (await addMember(s.deps, { group_id: 'idp-auditors', principal_id: 'cyd' }, 'system.test'))
        .ok,
    ).toBe(true);
    for (const team of [
      { team_id: 'audit', name: 'Audit', classification: 'internal', idp_group: 'idp-auditors' },
      { team_id: 'loose', name: 'Loose', classification: 'internal', idp_group: null },
    ]) {
      const t = await createTeam(s.deps, team as never, 'system.test');
      expect(t.ok, JSON.stringify(t)).toBe(true);
    }
    const r = await call(
      TOKENS.core,
      '/v1/grants',
      grant({
        target: { kind: 'team', team_id: 'audit' },
        role_id: 'factory.auditor',
        scope: { kind: 'fleet', ref: '*' },
      }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.group_id).toBe('idp-auditors');
    expect(await rolesOf('cyd')).toContain('factory.auditor@fleet:*');
    const loose = await call(
      TOKENS.core,
      '/v1/grants',
      grant({
        target: { kind: 'team', team_id: 'loose' },
        role_id: 'factory.auditor',
        scope: { kind: 'fleet', ref: '*' },
      }),
    );
    expect(loose.status).toBe(422);
  });

  it('the write scope cannot touch a grant group or a grant binding; only a decided revoke ends it', async () => {
    const g = grant({ target: { kind: 'principal', principal_id: 'cyd' } });
    const r = await call(TOKENS.core, '/v1/grants', g);
    expect(r.status).toBe(200);
    // the seed's write scope: no member, no binding, no revoke on what a grant wrote
    expect(
      (await call(TOKENS.seed, '/v1/groups/grant.cyd/members', { principal_id: 'ada' })).status,
    ).toBe(409);
    expect(
      (
        await call(TOKENS.seed, '/v1/bindings', {
          group_id: 'grant.cyd',
          role_id: 'factory.auditor',
          scope: { kind: 'fleet', ref: '*' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(TOKENS.seed, `/v1/bindings/${r.json.binding_id}/revoke`, { reason: 'x' })).status,
    ).toBe(409);
    const own = await createBinding(
      s.deps,
      {
        group_id: 'grant.cyd',
        role_id: 'project.viewer',
        scope: { kind: 'project', ref: 'other' },
      },
      'system.test',
    );
    expect(own.ok).toBe(false);
    // the decided revoke
    const rv = {
      grant_id: randomUUID(),
      binding_id: r.json.binding_id,
      m_gate_ref: M_GATE,
      reason: 'left',
      on_behalf_of: 'ada',
    };
    expect((await call(TOKENS.seed, '/v1/grants/revoke', rv)).status).toBe(403);
    const done = await call(TOKENS.core, '/v1/grants/revoke', rv);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ changed: true, group_id: 'grant.cyd' });
    expect(await rolesOf('cyd')).not.toContain('project.viewer@project:acme');
    expect((await call(TOKENS.core, '/v1/grants/revoke', rv)).json.changed).toBe(false);
  });
});
