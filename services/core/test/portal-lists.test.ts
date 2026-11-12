import {
  AdmissionView,
  AgentRegistryView,
  AuditDecisionsView,
  CatalogueView,
  ControlsView,
  ItemListView,
  KillsView,
} from '@aisdlc/contracts';
import { AGENT_DEFINITIONS } from '@aisdlc/agents';
import { CATALOGUE_SNAPSHOTS, CATALOGUE_VERSION } from '@aisdlc/catalogue';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import {
  Pdp,
  RecordDecisionLog,
  StaticBundleSource,
  buildBundle,
  bundleWithoutPolicies,
} from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { loadReports, seedActivePrr, type Seeded } from './work-fixtures.js';

// The portal's list reads (2026-11-12): items, the agent registry, the catalogue, admission, controls,
// the kill journal and the decision log. Real Postgres, the real PDP over the real identity read model.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by their contracts
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let seeded: Seeded;
const source = new StaticBundleSource(buildBundle());
let other: Seeded;
const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal', 'work'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'aud', 'ria', 'vic', 'eve']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'aud', 'factory.auditor');
  seeded = await seedActivePrr(s, { level: 'light' });
  other = await seedActivePrr(s, { level: 'light' });
  await bindProject(s.id, seeded.project, { requesters: ['ria'] });
  await bindProject(s.id, other.project, { requesters: ['vic'] });
  const pdp = new Pdp({
    source,
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

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}
const get = (path: string, token = TOKENS.bff) => call(token, 'GET', path);

const ask = (who: string, p: Seeded, text: string) =>
  call(TOKENS.bff, 'POST', '/v1/requests', {
    project_id: p.project,
    repo: p.repo,
    lane: 'L3',
    channel: 'N1',
    text,
    on_behalf_of: who,
  });

describe('GET /v1/items', () => {
  it('lists only the items the person may see, marks their own requests, and carries no request text', async () => {
    const a = await ask('ria', seeded, 'List the orders by date, please.');
    const b = await ask('vic', other, 'Add a CSV export of invoices.');
    expect([a.status, b.status]).toEqual([201, 201]);

    const ria = ItemListView.parse((await get('/v1/items?on_behalf_of=ria')).json);
    expect(ria.items.map((i) => i.item_id)).toEqual([a.json.item_id]);
    expect(ria.items[0]).toMatchObject({ mine: true, project_id: seeded.project, phase: 'S1' });
    expect(JSON.stringify(ria)).not.toContain('List the orders');

    // the auditor sees both, neither is theirs
    const aud = ItemListView.parse((await get('/v1/items?on_behalf_of=aud')).json);
    expect(aud.items.map((i) => i.item_id).sort()).toEqual([a.json.item_id, b.json.item_id].sort());
    expect(aud.items.every((i) => !i.mine)).toBe(true);
    // a project filter
    const one = ItemListView.parse(
      (await get(`/v1/items?on_behalf_of=aud&project=${other.project}`)).json,
    );
    expect(one.items.map((i) => i.item_id)).toEqual([b.json.item_id]);

    // nobody: nothing; a bad request: 400; the wrong scope: 403
    expect(ItemListView.parse((await get('/v1/items?on_behalf_of=eve')).json).items).toEqual([]);
    expect((await get('/v1/items')).status).toBe(400);
    expect((await get('/v1/items?on_behalf_of=aud&project=Bad Id')).status).toBe(400);
    expect((await get('/v1/items?on_behalf_of=aud', TOKENS.reader)).status).toBe(403);
  });
});

describe('fleet reads: quality.read, ops.read and audit.read on the fleet (PLAN §7a)', () => {
  const paths = ['/v1/agents', '/v1/admission', '/v1/controls', '/v1/kills', '/v1/audit/decisions'];

  it('an auditor and a factory admin may; a project role or nobody may not', async () => {
    for (const p of paths) {
      expect((await get(`${p}?on_behalf_of=aud`)).status, p).toBe(200);
      expect((await get(`${p}?on_behalf_of=ada`)).status, p).toBe(200);
      expect((await get(`${p}?on_behalf_of=ria`)).status, p).toBe(403);
      expect((await get(`${p}?on_behalf_of=eve`)).status, p).toBe(403);
      expect((await get(p)).status, p).toBe(400);
      expect((await get(`${p}?on_behalf_of=aud`, TOKENS.reader)).status, p).toBe(403);
    }
  });

  it('the agent registry is the code registry with each prompt pinned by its hash', async () => {
    const v = AgentRegistryView.parse((await get('/v1/agents?on_behalf_of=aud')).json);
    expect(v.lock_format).toBe('aisdlc-prompts-lock/v1');
    expect(v.agents.map((a) => a.agent_id)).toEqual(AGENT_DEFINITIONS.map((a) => a.agent_id));
    const a1 = v.agents.find((a) => a.agent_id === 'A1');
    expect(a1?.tools).toEqual([]);
    expect(a1?.prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('admission, controls, kills and the decision log answer their contracts', async () => {
    const adm = AdmissionView.parse((await get('/v1/admission?on_behalf_of=aud')).json);
    expect(adm.coding_session_cap).toBe(1);
    expect(adm.active).toEqual([]);
    ControlsView.parse((await get('/v1/controls?on_behalf_of=aud')).json);
    const kills = KillsView.parse((await get('/v1/kills?on_behalf_of=aud')).json);
    expect(kills.observed_head).toBe(0);
    // the denies above are in the log, newest first; a filter by action works
    const log = AuditDecisionsView.parse(
      (await get('/v1/audit/decisions?on_behalf_of=aud&action=audit.read&limit=50')).json,
    );
    expect(log.decisions.length).toBeGreaterThan(0);
    expect(log.decisions.every((d) => d.action === 'audit.read')).toBe(true);
    expect(log.decisions.some((d) => d.decision === 'deny' && d.principal === 'eve')).toBe(true);
    expect((await get('/v1/audit/decisions?on_behalf_of=aud&limit=0')).status).toBe(400);
    expect((await get('/v1/audit/decisions?on_behalf_of=aud&action=DROP')).status).toBe(400);
  });
});

describe('the switched reads ask the new action (PLAN §7a)', () => {
  it('an auditor who keeps audit.read but not ops.read or quality.read is refused Operate and Quality', async () => {
    source.set(
      bundleWithoutPolicies(buildBundle(), [
        'role/factory.auditor/ops.read',
        'role/factory.auditor/quality.read',
      ]),
    );
    try {
      const want: ReadonlyArray<[string, string]> = [
        ['/v1/admission', 'ops.read'],
        ['/v1/controls', 'ops.read'],
        ['/v1/kills', 'ops.read'],
        ['/v1/agents', 'quality.read'],
        ['/v1/agents/A1/stats', 'quality.read'],
        ['/v1/evals/summary', 'quality.read'],
        ['/v1/evals/runs', 'quality.read'],
        ['/v1/agents/A1/scores', 'quality.read'],
      ];
      for (const [path, action] of want) {
        const r = await get(`${path}?on_behalf_of=aud`);
        expect(r.status, path).toBe(403);
        expect(r.json.error.message, path).toBe(`${action} denied`);
      }
      // the decision log is still audit.read, and says which action was refused
      expect((await get('/v1/audit/decisions?on_behalf_of=aud')).status).toBe(200);
      const log = AuditDecisionsView.parse(
        (await get('/v1/audit/decisions?on_behalf_of=aud&action=ops.read&limit=50')).json,
      );
      expect(log.decisions.some((d) => d.principal === 'aud' && d.decision === 'deny')).toBe(true);
    } finally {
      source.set(buildBundle());
    }
    // with the catalogue as it is, the auditor reads them again
    expect((await get('/v1/admission?on_behalf_of=aud')).status).toBe(200);
    expect((await get('/v1/agents?on_behalf_of=aud')).status).toBe(200);
  });
});

describe('GET /v1/catalogue', () => {
  it('lists every released catalogue with its pin, the current one marked, and the items pinned to it', async () => {
    const v = CatalogueView.parse((await get('/v1/catalogue')).json);
    expect(v.versions.map((x) => x.ref.version)).toEqual(CATALOGUE_SNAPSHOTS.map((x) => x.version));
    const cur = v.versions.filter((x) => x.current);
    expect(cur.map((x) => x.ref.version)).toEqual([CATALOGUE_VERSION]);
    expect(cur[0]?.pinned_items).toBeGreaterThanOrEqual(2);
    expect(cur[0]?.lanes.find((l) => l.lane === 'L3')?.stages.length).toBeGreaterThan(0);
    expect((await get('/v1/catalogue', TOKENS.reader)).status).toBe(403);
  });
});
