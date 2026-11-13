import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityPdpEntities, createIdentityApp } from '../src/index.js';
import {
  bindProject,
  grantFleetRole,
  seedPrincipals,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

// Portal v2 gap G6: people, groups, teams and bindings are written from the portal for a signed-in person (scope
// `admin`, the bff), and the PDP decides each write: `identity.admin` on the fleet, `access.manage` on a binding's
// project. The factory admin always; a project admin for its own project's bindings; nobody else. Each write is
// recorded with the person as its actor, and its PDP decision is logged.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: IdentityStack;
let app: FastifyInstance;
let url: string;
const TOKENS = { bff: 'b'.repeat(32), seed: 's'.repeat(32) };

beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, ['ada', 'pat', 'ria']);
  await grantFleetRole(s.deps, 'ada', 'factory.admin');
  await bindProject(s, 'pa', { admin: ['pat'] });
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createIdentityApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: { bff: ['read', 'admin'], seed: ['read', 'write'] },
    settings: s.settings,
    clock: s.clock,
    decide: (principal, action, resource) => pdp.decide({ principal, action, resource }),
  });
  url = await listen(app);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

async function post(token: string, path: string, body: unknown) {
  const res = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const person = (id: string) => ({
  principal: {
    principal_id: id,
    kind: 'human',
    display_handle: id,
    display_name: id.toUpperCase(),
  },
});

describe('a person writes identity through the PDP', () => {
  it('the factory admin creates a person, recorded with the admin as actor and the decision logged', async () => {
    const r = await post(TOKENS.bff, '/v1/principals', {
      ...person('newbie'),
      on_behalf_of: 'ada',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const ev = await s.record.pool.query<{ actor: string }>(
      `SELECT actor FROM record.record_event WHERE stream = 'principal:newbie' ORDER BY seq LIMIT 1`,
    );
    expect(ev.rows[0]?.actor).toBe('ada');
    const log = await s.record.pool.query(
      `SELECT 1 FROM record.record_event WHERE type = 'pdp.decision'
          AND body ->> 'principal' = 'ada' AND body ->> 'action' = 'identity.admin' AND body ->> 'decision' = 'allow'`,
    );
    expect(log.rowCount).toBeGreaterThan(0);
  });

  it('a person without identity.admin is refused, and nothing is written', async () => {
    const r = await post(TOKENS.bff, '/v1/principals', {
      ...person('sneaky'),
      on_behalf_of: 'pat',
    });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/identity.admin denied/);
    const ev = await s.record.pool.query(
      `SELECT 1 FROM record.record_event WHERE stream = 'principal:sneaky'`,
    );
    expect(ev.rowCount).toBe(0);
    // a team and a status change are identity.admin too
    expect(
      (
        await post(TOKENS.bff, '/v1/teams', {
          team: { team_id: 't9', name: 'T9', classification: 'internal', idp_group: null },
          on_behalf_of: 'ria',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(TOKENS.bff, '/v1/principals/ria/status', {
          status: 'disabled',
          reason: 'x',
          on_behalf_of: 'pat',
        })
      ).status,
    ).toBe(403);
  });

  it('a write for a person must name the person', async () => {
    const r = await post(TOKENS.bff, '/v1/principals', person('nameless'));
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/on_behalf_of/);
  });

  it('a binding is access.manage on its project: the project admin there, not elsewhere; the factory admin anywhere', async () => {
    const binding = (project: string, who: string) => ({
      group_id: 'viewers',
      role_id: 'project.viewer',
      scope: { kind: 'project', ref: project },
      on_behalf_of: who,
    });
    const g = await post(TOKENS.bff, '/v1/groups', {
      group: { group_id: 'viewers', display: 'Viewers', pim_managed: false, protected: false },
      on_behalf_of: 'ada',
    });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    const mine = await post(TOKENS.bff, '/v1/bindings', binding('pa', 'pat'));
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    const other = await post(TOKENS.bff, '/v1/bindings', binding('pb', 'pat'));
    expect(other.status).toBe(403);
    expect(other.json.error.message).toMatch(/access.manage denied/);
    const byAdmin = await post(TOKENS.bff, '/v1/bindings', binding('pb', 'ada'));
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
    // revoking is asked on the binding's own scope
    const id = byAdmin.json.binding_id ?? byAdmin.json.binding?.binding_id;
    expect(typeof id).toBe('string');
    expect(
      (await post(TOKENS.bff, `/v1/bindings/${id}/revoke`, { reason: 'no', on_behalf_of: 'pat' }))
        .status,
    ).toBe(403);
    expect(
      (await post(TOKENS.bff, `/v1/bindings/${id}/revoke`, { reason: 'done', on_behalf_of: 'ada' }))
        .status,
    ).toBe(200);
  });

  it('the machine path (scope write, the seed) is unchanged; a caller with neither scope is refused', async () => {
    expect((await post(TOKENS.seed, '/v1/principals', person('seeded'))).status).toBe(200);
    const pdpless = createIdentityApp({
      pool: s.record.pool,
      auth: new ServiceAuth(TOKENS),
      callers: { bff: ['admin'] },
      settings: s.settings,
      clock: s.clock,
    });
    const u = await listen(pdpless);
    try {
      const r = await fetch(new URL('/v1/principals', u), {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKENS.bff}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...person('nopdp'), on_behalf_of: 'ada' }),
      });
      expect(r.status).toBe(503);
    } finally {
      await pdpless.close();
    }
  });
});
