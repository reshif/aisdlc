import { PDP_EVENT, s0Stream } from '@aisdlc/contracts';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';

// The responses are asserted field by field; typing every body would only repeat the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let bare: FastifyInstance;
let url: string;
let bareUrl: string;

const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
  nobody: 'nobody-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'settings'],
  reader: ['read'],
  nobody: [],
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    // The manual clock the identity journal was written with: memberships start at its time.
    clock: s.clock,
  });
  const mk = (extra: object) =>
    createCoreApp({
      pool: s.record.pool,
      auth: new ServiceAuth(TOKENS),
      callers: CALLERS,
      registry: s.registry,
      clock: s.clock,
      ...extra,
    });
  app = mk({ pdp, config: s.config });
  url = await listen(app);
  // The same app with no PDP and no decision kernel: everything that needs one refuses.
  bare = mk({});
  bareUrl = await listen(bare);
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await s.stop();
});

async function call(
  token: string | null,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  base = url,
) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const onboardBody = (over: Record<string, unknown> = {}) => ({
  project_id: 'web',
  repo: 'acme/web',
  level: 'light',
  on_behalf_of: 'alice',
  ...over,
});

describe('POST /v1/onboard is guarded by the PDP (project.onboard)', () => {
  it('refuses without a token, without the scope, and for a person the PDP denies; writes nothing', async () => {
    const before = await s.record.pool.query(
      "SELECT count(*)::int AS n FROM record.record_event WHERE type LIKE 's0.%'",
    );
    expect((await call(null, 'POST', '/v1/onboard', onboardBody())).status).toBe(401);
    expect((await call(TOKENS.reader, 'POST', '/v1/onboard', onboardBody())).status).toBe(403);
    const bob = await call(TOKENS.bff, 'POST', '/v1/onboard', onboardBody({ on_behalf_of: 'bob' }));
    expect(bob.status).toBe(403);
    expect(bob.json?.['error']).toMatchObject({ code: 'forbidden' });
    expect(bob.json?.['error'].reasons.length).toBeGreaterThan(0);
    const ghost = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ on_behalf_of: 'ghost' }),
    );
    expect(ghost.status).toBe(403);
    const noPdp = await call(TOKENS.bff, 'POST', '/v1/onboard', onboardBody(), bareUrl);
    expect(noPdp.status).toBe(503);
    const after = await s.record.pool.query(
      "SELECT count(*)::int AS n FROM record.record_event WHERE type LIKE 's0.%'",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    // The denies are logged.
    const denies = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE type = $1 AND body ->> 'action' = 'project.onboard' AND body ->> 'decision' = 'deny'`,
      [PDP_EVENT.decision],
    );
    expect(denies.rows[0].n).toBe(2); // bob and ghost
  });

  it('an allowed request is recorded as the intake event and answers with s0_ref', async () => {
    const r = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ request_id: crypto.randomUUID() }),
    );
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ project_id: 'web', repo: 'acme/web', duplicate: false });
    expect(r.json?.['s0_ref']).toMatch(/^record:[0-9a-f-]{36}$/);
    const intake = await s.record.pool.query(
      `SELECT 'record:' || event_id AS ref FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [s0Stream(r.json?.['s0_id'])],
    );
    expect(intake.rows[0].ref).toBe(r.json?.['s0_ref']);

    const view = await call(TOKENS.reader, 'GET', `/v1/s0/${r.json?.['s0_id']}`);
    expect(view.status).toBe(200);
    expect(view.json?.['record']).toMatchObject({
      status: 'app',
      requested_level: 'light',
      signable_level: 'light',
      intake_ref: r.json?.['s0_ref'],
    });
    expect(
      view.json?.['steps'].map((x: { step: string; state: string }) => `${x.step}:${x.state}`),
    ).toEqual(['0.1:todo', '0.2:todo', '0.3:skip', '0.4:todo', '0.5:todo']);
    const byRepo = await call(TOKENS.reader, 'GET', '/v1/repos/Acme/WEB/s0');
    expect(byRepo.json?.[0].record.s0_id).toBe(r.json?.['s0_id']);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/web')).json).toMatchObject({
      project_id: 'web',
      classification: 'internal',
    });
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/nope')).status).toBe(404);
    expect((await call(TOKENS.reader, 'GET', '/v1/s0/not-a-uuid')).status).toBe(400);
  });

  it('a retry with the same request_id is the same record (200); an attestation that lowers risk is a 400', async () => {
    const request_id = crypto.randomUUID();
    const a = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ project_id: 'ret', repo: 'acme/ret', request_id }),
    );
    const b = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ project_id: 'ret', repo: 'acme/ret', request_id }),
    );
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.json).toMatchObject({ s0_id: a.json?.['s0_id'], duplicate: true });
    for (const attestations of [
      { tier_floor: 'T0' },
      { classification: 'internal' },
      { deploys: false },
    ]) {
      const bad = await call(
        TOKENS.bff,
        'POST',
        '/v1/onboard',
        onboardBody({ project_id: 'low', repo: 'acme/low', attestations }),
      );
      expect(bad.status).toBe(400);
    }
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/low')).status).toBe(404);
    // A repo of another project is a conflict.
    const stolen = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ project_id: 'other', repo: 'acme/ret' }),
    );
    expect(stolen.status).toBe(409);
  });
});

describe('the owner moves on a record', () => {
  it('withdraw and resume are guarded too; illegal moves are 409; the signable level can only go down', async () => {
    const r = await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ project_id: 'mv', repo: 'acme/mv', level: 'light' }),
    );
    const id = r.json?.['s0_id'];
    expect(
      (await call(TOKENS.bff, 'POST', `/v1/s0/${id}/resume`, { on_behalf_of: 'alice' })).status,
    ).toBe(409);
    expect(
      (await call(TOKENS.bff, 'POST', `/v1/s0/${id}/withdraw`, { on_behalf_of: 'bob' })).status,
    ).toBe(403);
    const low = await call(TOKENS.bff, 'POST', `/v1/s0/${id}/signable-level`, {
      level: 'census',
      on_behalf_of: 'alice',
    });
    expect(low.status).toBe(200);
    expect(low.json?.['record']).toMatchObject({
      requested_level: 'light',
      signable_level: 'census',
    });
    const w = await call(TOKENS.bff, 'POST', `/v1/s0/${id}/withdraw`, {
      on_behalf_of: 'alice',
      reason: 'wrong repo',
    });
    expect(w.status).toBe(200);
    expect(w.json?.['record'].status).toBe('withdrawn');
    expect(
      (
        await call(TOKENS.bff, 'POST', `/v1/s0/${id}/signable-level`, {
          level: 'census',
          on_behalf_of: 'alice',
        })
      ).status,
    ).toBe(409);
  });
});

describe('settings over HTTP', () => {
  it('PUT proposes a config revision (202, an M1 gate) for a person the PDP allows; GET is 404 until it is published', async () => {
    await call(
      TOKENS.bff,
      'POST',
      '/v1/onboard',
      onboardBody({ project_id: 'cfg', repo: 'acme/cfg' }),
    );
    setAdmins(s, 'cfg', ['alice']);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/cfg/settings')).status).toBe(404);
    const role_map = {
      admin: { kind: 'principals', principals: ['alice'] },
      requesters: { kind: 'principals', principals: ['bob'] },
      intent: { kind: 'principals', principals: [] },
      design: { kind: 'principals', principals: [] },
      g4: { kind: 'codeowners' },
      g5: { kind: 'principals', principals: [] },
      x: { kind: 'principals', principals: [] },
      sec: { kind: 'principals', principals: [] },
      m4: { kind: 'principals', principals: [] },
      kill: { kind: 'principals', principals: [] },
    };
    expect(
      (
        await call(TOKENS.bff, 'PUT', '/v1/projects/cfg/settings', {
          role_map,
          on_behalf_of: 'bob',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(TOKENS.reader, 'PUT', '/v1/projects/cfg/settings', {
          role_map,
          on_behalf_of: 'alice',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          TOKENS.bff,
          'PUT',
          '/v1/projects/cfg/settings',
          { role_map, on_behalf_of: 'alice' },
          bareUrl,
        )
      ).status,
    ).toBe(503);
    const ok = await call(TOKENS.bff, 'PUT', '/v1/projects/cfg/settings', {
      role_map,
      on_behalf_of: 'alice',
    });
    expect(ok.status).toBe(202);
    expect(ok.json?.['gate_instance_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.json?.['rev_hash']).toMatch(/^[0-9a-f]{64}$/);
    // Proposed is not in force.
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/cfg/settings')).status).toBe(404);
    // An invalid document is a 400, an unchanged one a 409.
    expect(
      (
        await call(TOKENS.bff, 'PUT', '/v1/projects/cfg/settings', {
          role_map: { admin: 1 },
          on_behalf_of: 'alice',
        })
      ).status,
    ).toBe(400);
  });
});

describe('registered repos', () => {
  it('needs the registry scope', async () => {
    expect((await call(TOKENS.reader, 'GET', '/v1/registered-repos')).status).toBe(403);
    expect((await call(null, 'GET', '/v1/registered-repos')).status).toBe(401);
  });
});
