import { AgentRunsView, AgentStats } from '@aisdlc/contracts';
import { grantFleetRole, grantRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { FakeAgentKeys } from '@aisdlc/ports';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, submitRequest, type CoreScope } from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// The read API of M11.2 over HTTP, with the real PDP over the real identity read model: an item's runs
// need `project.view` on its project, an agent's stats `audit.read` (V3) on the fleet or the project.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let project = '';
let itemId = '';
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal', 'work'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'aud', 'vic', 'eve']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'aud', 'factory.auditor');
  const seeded = await seedActivePrr(s, { level: 'light', gating: GATING_OFF });
  project = seeded.project;
  await grantRole(s.id.deps, 'vic', 'project.viewer', { kind: 'project', ref: project });
  approvers(s, project, ['bob']);
  const r = await submitRequest(s.deps, {
    project_id: pid(project),
    repo: seeded.repo,
    lane: 'L3',
    requester: pr('alice'),
    channel: 'N1',
    text: 'agent runs over http',
  });
  if (!r.ok) throw new Error(r.error.message);
  itemId = r.value.item_id as string;
  await runItem(s, { ...driverOver(s), keys: new FakeAgentKeys() }, itemId);
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

async function get(token: string, path: string) {
  const res = await fetch(new URL(path, url), { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

describe('GET /v1/agent-runs?item=', () => {
  it('lists the runs of an item with their outcomes, for someone who may view the project', async () => {
    const r = await get(TOKENS.bff, `/v1/agent-runs?item=${itemId}&on_behalf_of=vic`);
    expect(r.status).toBe(200);
    const view = AgentRunsView.parse(r.json);
    expect(view).toMatchObject({ item_id: itemId, project_id: project });
    expect(view.runs.length).toBeGreaterThan(3);
    expect(view.runs.map((x) => x.agent_id)).toEqual(expect.arrayContaining(['A1', 'coder']));
    for (const run of view.runs) {
      expect(run.vkey_id).toMatch(/^fake-vkey-/);
      expect(run.outcome.run_id).toBe(run.run_id);
    }
    // it carries ids, hashes and counts: never any text of a request, a prompt or an output
    expect(JSON.stringify(r.json)).not.toContain('agent runs over http');
  });

  it('refuses: nobody it knows (403), no scope (403), no principal or a bad id (400), no such item (404)', async () => {
    expect((await get(TOKENS.bff, `/v1/agent-runs?item=${itemId}&on_behalf_of=eve`)).status).toBe(
      403,
    );
    expect(
      (await get(TOKENS.reader, `/v1/agent-runs?item=${itemId}&on_behalf_of=vic`)).status,
    ).toBe(403);
    expect((await get(TOKENS.bff, `/v1/agent-runs?item=${itemId}`)).status).toBe(400);
    expect((await get(TOKENS.bff, `/v1/agent-runs?item=nope&on_behalf_of=vic`)).status).toBe(400);
    expect((await get(TOKENS.bff, `/v1/agent-runs?on_behalf_of=vic`)).status).toBe(400);
    expect(
      (
        await get(
          TOKENS.bff,
          `/v1/agent-runs?item=00000000-0000-4000-8000-000000000000&on_behalf_of=vic`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('GET /v1/agents/:id/stats', () => {
  it('needs audit.read: the auditor and the admin may read the fleet and a project; a project viewer may not', async () => {
    for (const who of ['aud', 'ada']) {
      const fleet = await get(TOKENS.bff, `/v1/agents/coder/stats?on_behalf_of=${who}`);
      expect(fleet.status, who).toBe(200);
      const st = AgentStats.parse(fleet.json);
      expect(st).toMatchObject({ agent_id: 'coder', project_id: null });
      expect(st.runs).toBeGreaterThan(0);
      expect(st.accepted).toBeGreaterThan(0);
      expect(st.acceptance_rate).toBe(1);
      expect(st.back_edge_rate).toBe(0);
      const one = await get(
        TOKENS.bff,
        `/v1/agents/coder/stats?project=${project}&on_behalf_of=${who}`,
      );
      expect(AgentStats.parse(one.json)).toMatchObject({ project_id: project });
    }
    expect((await get(TOKENS.bff, `/v1/agents/coder/stats?on_behalf_of=vic`)).status).toBe(403);
    expect(
      (await get(TOKENS.bff, `/v1/agents/coder/stats?project=${project}&on_behalf_of=vic`)).status,
    ).toBe(403);
    expect((await get(TOKENS.bff, `/v1/agents/coder/stats?on_behalf_of=eve`)).status).toBe(403);
    expect((await get(TOKENS.reader, `/v1/agents/coder/stats?on_behalf_of=aud`)).status).toBe(403);
  });

  it('refuses an unknown agent and a bad project; an agent that never ran has null rates', async () => {
    expect((await get(TOKENS.bff, `/v1/agents/A99/stats?on_behalf_of=aud`)).status).toBe(400);
    expect(
      (await get(TOKENS.bff, `/v1/agents/coder/stats?project=Bad Id&on_behalf_of=aud`)).status,
    ).toBe(400);
    expect((await get(TOKENS.bff, `/v1/agents/coder/stats`)).status).toBe(400);
    const none = await get(TOKENS.bff, `/v1/agents/A10/stats?on_behalf_of=aud`);
    expect(AgentStats.parse(none.json)).toMatchObject({
      runs: 0,
      acceptance_rate: null,
      back_edge_rate: null,
      cost_per_run_micro_usd: null,
    });
  });
});
