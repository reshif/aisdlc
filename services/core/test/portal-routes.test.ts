import { LedgerAuditView, ProjectDetail, ProjectPrrView, ProjectSummary } from '@aisdlc/contracts';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// The portal's two listings (PLAN M8.1): every project, and one project with all its S0 records.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;

const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

async function call(token: string | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
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

describe('GET /v1/projects and /v1/projects/:id/overview', () => {
  it('need the portal scope, and are empty before any onboarding', async () => {
    expect((await call(null, 'GET', '/v1/projects')).status).toBe(401);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects')).status).toBe(403);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/web/overview')).status).toBe(403);
    expect((await call(TOKENS.bff, 'GET', '/v1/projects')).json).toEqual([]);
    expect((await call(TOKENS.bff, 'GET', '/v1/projects/web/overview')).status).toBe(404);
    expect((await call(TOKENS.bff, 'GET', '/v1/projects/Not%20A%20Slug/overview')).status).toBe(
      400,
    );
  });

  it('serve the project, its repos and the S0 records, newest first, in the contract shapes', async () => {
    const first = await call(TOKENS.bff, 'POST', '/v1/onboard', {
      project_id: 'web',
      repo: 'acme/web',
      level: 'light',
      on_behalf_of: 'alice',
    });
    expect(first.status).toBe(201);
    const second = await call(TOKENS.bff, 'POST', '/v1/onboard', {
      project_id: 'web',
      repo: 'acme/web',
      level: 'census',
      on_behalf_of: 'alice',
    });
    expect(second.status).toBe(201);

    const list = await call(TOKENS.bff, 'GET', '/v1/projects');
    expect(list.status).toBe(200);
    const rows = list.json.map((r: unknown) => ProjectSummary.parse(r));
    expect(rows).toHaveLength(1);
    expect(rows[0].project.project_id).toBe('web');
    expect(rows[0].repos.map((r: { repo_ref: string }) => r.repo_ref)).toEqual(['acme/web']);
    expect(rows[0].latest_s0).toMatchObject({
      s0_id: second.json.s0_id,
      repo: 'acme/web',
      requested_level: 'census',
    });

    const detail = await call(TOKENS.bff, 'GET', '/v1/projects/web/overview');
    const d = ProjectDetail.parse(detail.json);
    expect(d.s0.map((o) => o.record.s0_id)).toEqual([second.json.s0_id, first.json.s0_id]);
    expect(d.s0[1]?.record.status).toBe('superseded');
    expect(d.s0[0]?.steps.map((x) => x.step)).toEqual(['0.1', '0.2', '0.3', '0.4', '0.5']);
  });
});

describe('the readiness record, the ledger and the inbox routes (PLAN M8.3, M8.4)', () => {
  it('serve the contract shapes for a project, and refuse what is not theirs to ask', async () => {
    const prr = await call(TOKENS.reader, 'GET', '/v1/projects/web/prr');
    expect(prr.status).toBe(200);
    expect(ProjectPrrView.parse(prr.json)).toMatchObject({
      project_id: 'web',
      repos: [{ repo: 'acme/web', governing: null, proposed: null }],
    });
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/nope/prr')).status).toBe(404);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/Not%20A%20Slug/prr')).status).toBe(400);
    expect((await call(null, 'GET', '/v1/projects/web/prr')).status).toBe(401);

    const ledger = await call(TOKENS.reader, 'GET', '/v1/projects/web/ledger');
    expect(ledger.status).toBe(200);
    const v = LedgerAuditView.parse(ledger.json);
    expect(v.project_id).toBe('web');
    // the bootstrap grant of the first onboarding is the project's first ledger entry
    expect(v.entries.length).toBeGreaterThan(0);
    expect(v.entries.every((e) => /bootstrap/.test(e.entry_type))).toBe(true);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/web/ledger?s0=nope')).status).toBe(400);
    expect((await call(TOKENS.reader, 'GET', '/v1/projects/nope/ledger')).status).toBe(404);
  });

  it('the inbox needs the portal scope and the cards; revisions need the kernel and the PDP', async () => {
    expect((await call(TOKENS.reader, 'GET', '/v1/inbox')).status).toBe(403);
    expect((await call(TOKENS.bff, 'GET', '/v1/inbox')).status).toBe(503); // no cards configured here
    const gate = '0199a1a1-0000-7000-8000-000000000001';
    expect((await call(TOKENS.reader, 'GET', `/v1/revisions/${gate}`)).status).toBe(404);
    expect((await call(TOKENS.reader, 'GET', '/v1/revisions/not-a-uuid')).status).toBe(400);
    const prep = await call(TOKENS.reader, 'POST', `/v1/revisions/${gate}/prepare`, {
      on_behalf_of: 'alice',
    });
    expect(prep.status).toBe(403); // the reader may not decide anything
    const unknown = await call(TOKENS.bff, 'POST', `/v1/revisions/${gate}/prepare`, {
      on_behalf_of: 'alice',
    });
    expect(unknown.status).toBe(404);
  });
});
