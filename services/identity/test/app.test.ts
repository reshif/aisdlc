import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { SeedIdentityProvider } from '@aisdlc/ports';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityApp } from '../src/index.js';
import { pid, settingsOf, startIdentityStack, type IdentityStack } from '../src/testing.js';

let s: IdentityStack;
let app: FastifyInstance;
let url: string;
let writes = 0;
const TOKENS = {
  core: 'c'.repeat(32),
  admin: 'a'.repeat(32),
  nobody: 'n'.repeat(32),
};

beforeAll(async () => {
  s = await startIdentityStack();
  app = createIdentityApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: { core: ['read'], admin: ['read', 'write', 'reconcile', 'sync'] },
    settings: s.settings,
    idp: SeedIdentityProvider.fromFile(join(import.meta.dirname, '..', 'fixtures', 'seed.json')),
    ledger: s.ledger,
    clock: s.clock,
    onWrite: () => {
      writes += 1;
    },
  });
  url = await listen(app);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

// Responses are asserted field by field; typing every body would only repeat the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(
  token: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('auth', () => {
  it('healthz is open; /v1 needs a token; scopes are enforced', async () => {
    expect((await call(null, 'GET', '/healthz')).json).toEqual({ ok: true });
    expect((await call(null, 'GET', '/v1/principals/x')).status).toBe(401);
    expect((await call('x'.repeat(32), 'GET', '/v1/principals/x')).status).toBe(401);
    expect((await call(TOKENS.nobody, 'GET', '/v1/principals/x')).status).toBe(403);
    expect((await call(TOKENS.core, 'POST', '/v1/principals', {})).status).toBe(403);
    expect((await call(TOKENS.core, 'POST', '/v1/projects/p/reconcile', {})).status).toBe(403);
  });
});

describe('writes then reads', () => {
  it('syncs the seed, reconciles a project, and answers the core queries', async () => {
    const sync = await call(TOKENS.admin, 'POST', '/v1/idp/sync');
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ principals_created: 5, groups_created: 3 });
    const create = await call(TOKENS.admin, 'POST', '/v1/principals', {
      principal: {
        principal_id: 'erin',
        kind: 'human',
        display_handle: 'erin',
        display_name: 'Erin',
      },
    });
    expect(create.status).toBe(200);
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/principals', {
          principal: {
            principal_id: 'erin',
            kind: 'human',
            display_handle: 'erin',
            display_name: 'Other',
          },
        })
      ).status,
    ).toBe(409);

    s.settings.set(
      settingsOf('acme', {
        admin: ['alice'],
        intent: ['bob'],
        requesters: ['bob', 'erin'],
        kill: ['alice'],
      }),
      'T1',
    );
    const rec = await call(TOKENS.admin, 'POST', '/v1/projects/acme/reconcile', {
      config_rev: 'rev-9',
    });
    expect(rec.status).toBe(200);
    expect(rec.json).toMatchObject({ project_id: 'acme', bindings_created: 10 });
    expect((await call(TOKENS.admin, 'POST', '/v1/projects/ghost/reconcile', {})).status).toBe(503);
    expect(writes).toBeGreaterThan(0);

    const p = await call(TOKENS.core, 'GET', '/v1/principals/alice');
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({
      principal_id: 'alice',
      kind: 'human',
      status: 'active',
      display_name: 'Alice Example',
    });
    expect((await call(TOKENS.core, 'GET', '/v1/principals/zed')).status).toBe(404);

    const groups = await call(TOKENS.core, 'GET', '/v1/principals/alice/groups');
    expect(groups.json.groups.map((g: { group_id: string }) => g.group_id)).toEqual([
      'grp-engineering',
      'grp-release-managers',
      'rm.acme.admin',
      'rm.acme.kill',
    ]);

    const b = await call(
      TOKENS.core,
      'GET',
      `/v1/principals/alice/bindings?scope=${encodeURIComponent('project:acme')}`,
    );
    expect(b.json.bindings.map((x: { role_id: string }) => x.role_id)).toEqual([
      'project.admin',
      'project.kill_holder',
    ]);
    const lane = await call(
      TOKENS.core,
      'GET',
      `/v1/principals/alice/bindings?scope=${encodeURIComponent('lane:acme/L4')}`,
    );
    expect(lane.json.bindings).toHaveLength(2); // a project binding covers its lanes
    const other = await call(
      TOKENS.core,
      'GET',
      `/v1/principals/alice/bindings?scope=${encodeURIComponent('project:beta')}`,
    );
    expect(other.json.bindings).toEqual([]);
    expect((await call(TOKENS.core, 'GET', '/v1/principals/alice/bindings')).status).toBe(400);
    expect(
      (await call(TOKENS.core, 'GET', '/v1/principals/alice/bindings?scope=nonsense')).status,
    ).toBe(400);
    expect((await call(TOKENS.core, 'GET', '/v1/principals/alice/groups?at=never')).status).toBe(
      400,
    );

    const r = await call(
      TOKENS.core,
      'GET',
      '/v1/resolve?kind=idp_subject&issuer=local-dev&value=00000000-0000-4000-8000-000000000002',
    );
    expect(r.json).toMatchObject({ principal_id: 'bob' });
    expect(
      (await call(TOKENS.core, 'GET', '/v1/resolve?kind=idp_subject&issuer=local-dev&value=nope'))
        .status,
    ).toBe(404);
  });

  it('explain, for a gate and for the whole project', async () => {
    const g = await call(TOKENS.core, 'GET', '/v1/projects/acme/explain?gate=G1');
    expect(g.status).toBe(200);
    expect(g.json.deciders.map((d: { principal_id: string }) => d.principal_id)).toEqual(['bob']);
    expect(g.json.quorum).toMatchObject({ feasible: true, basis: 'single', sod_waiver: false });
    const all = await call(TOKENS.core, 'GET', '/v1/projects/acme/explain');
    expect(all.json.length).toBe(29);
    expect((await call(TOKENS.core, 'GET', '/v1/projects/acme/explain?gate=Z9')).status).toBe(400);
    expect((await call(TOKENS.core, 'GET', '/v1/projects/unknown/explain?gate=G1')).status).toBe(
      503,
    );
  });

  it('groups, members, bindings and teams over HTTP, with the same rules', async () => {
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/groups', {
          group: { group_id: 'viewers', display: 'Viewers', pim_managed: false, protected: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(TOKENS.admin, 'POST', '/v1/groups/viewers/members', { principal_id: 'erin' }))
        .json,
    ).toEqual({ changed: true });
    const bind = await call(TOKENS.admin, 'POST', '/v1/bindings', {
      group_id: 'viewers',
      role_id: 'project.viewer',
      scope: { kind: 'project', ref: 'acme' },
    });
    expect(bind.status).toBe(200);
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/bindings', {
          group_id: 'viewers',
          role_id: 'project.admin',
          scope: { kind: 'project', ref: 'acme' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/groups/rm.acme.admin/members', {
          principal_id: 'erin',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(TOKENS.admin, 'POST', `/v1/bindings/${bind.json.binding_id}/revoke`, {
          reason: 'test',
        })
      ).json,
    ).toEqual({ changed: true });
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/principals/erin/status', {
          status: 'disabled',
          reason: 'test',
        })
      ).json,
    ).toEqual({ changed: true });
    expect(
      (
        await call(TOKENS.admin, 'POST', '/v1/teams', {
          team: {
            team_id: 'platform',
            name: 'Platform',
            classification: 'internal',
            idp_group: 'grp-engineering',
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(TOKENS.admin, 'POST', '/v1/principals/erin/update', { changes: {} })).status,
    ).toBe(400);
  });

  it('exposes the access-sync lag, runs the loop on demand, and a metric', async () => {
    const before = await call(TOKENS.core, 'GET', '/v1/access-sync');
    expect(before.json).toMatchObject({ slo_seconds: 60, breached: false });
    s.clock.advance(90_000);
    const late = await call(TOKENS.core, 'GET', '/v1/access-sync');
    expect(late.json.breached).toBe(true);
    expect((await call(TOKENS.core, 'POST', '/v1/access-sync/run')).status).toBe(403);
    const run = await call(TOKENS.admin, 'POST', '/v1/access-sync/run');
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ caught_up: true, lag_seconds: 0 });
    expect(run.json.written).toBeGreaterThan(10);
    const metrics = await fetch(new URL('/metrics', url));
    const text = await metrics.text();
    expect(text).toContain('identity_access_sync_lag_seconds 0');
    expect(text).toContain('identity_access_sync_slo_breached 0');
    expect(pid('acme')).toBe('acme');
  });
});
