import { primaryAgentFor } from '@aisdlc/agents';
import {
  AgentDetailView,
  AgentRecentRunsView,
  ItemDocumentsView,
  ItemRequestView,
  ItemTimelineView,
  ItemView,
  type StageOutcome,
} from '@aisdlc/contracts';
import type { TestGateway } from '@aisdlc/gateway/testing';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeStagePorts } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, storeArtefact, submitRequest, type CoreScope } from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { REQUEST_TEXT, planningRig, sharedProvider, startPlanningGateway } from './planning.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// P2-1, P2-3, P2-16, P3-5 over HTTP, real Postgres, the real PDP over the real identity read model, the real planning
// port: the item page's Request, Documents and Timeline reads, the clarifying round on the item, and the agent page's
// detail and recent runs. Each read is `project.view` on the item's project (the agent reads `quality.read`).

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by their contracts
type Json = any;

let s: CoreStack;
let gw: TestGateway;
let app: FastifyInstance;
let url: string;
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'work'],
  reader: ['read'],
};
sharedProvider();

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startPlanningGateway(s);
  await seedPrincipals(s.id.deps, ['ria', 'zed', 'aud']);
  await grantFleetRole(s.id.deps, 'aud', 'factory.auditor');
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
  await gw?.stop();
  await s.stop();
});

async function get(path: string, token = TOKENS.bff) {
  const res = await fetch(new URL(path, url), { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

describe('the item page over an L4 item planned to S4 by real agents', () => {
  let item: string;
  let project: string;
  beforeAll(async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    item = rig.itemId;
    project = rig.project;
    await bindProject(s.id, project, { requesters: ['ria'] });
    await runItem(s, rig.d, item, { stop: (st) => st.underlying === 'S4', passes: 120 });
    // a redraft of the spec after G2: version 2, which no gate has bound
    const v2 = await storeArtefact(s.deps, {
      item_id: item,
      project_id: project,
      type: 'spec_delta',
      step: '3.2',
      command_key: 'test:redraft',
      run_id: null,
      content: { kind: 'spec', title: 'Audit log v2', sections: [], citations: [] },
    });
    if (!v2.ok) throw new Error('the redraft was not stored');
  });

  it('every read needs the work scope and project.view on the item: a stranger learns only the refusal', async () => {
    for (const tab of ['request', 'documents', 'timeline']) {
      expect((await get(`/v1/items/${item}/${tab}?on_behalf_of=ria`, TOKENS.reader)).status).toBe(
        403,
      );
      expect((await get(`/v1/items/${item}/${tab}?on_behalf_of=zed`)).status).toBe(403);
      expect((await get(`/v1/items/${item}/${tab}`)).status).toBe(400);
      expect(
        (await get(`/v1/items/00000000-0000-4000-8000-000000000000/${tab}?on_behalf_of=ria`))
          .status,
      ).toBe(404);
    }
  });

  it('the request: the text as kept with its taint mark, the lane asked and the intake verdict', async () => {
    const r = await get(`/v1/items/${item}/request?on_behalf_of=ria`);
    expect(r.status).toBe(200);
    const v = ItemRequestView.parse(r.json);
    expect(v.request_text?.text).toContain(REQUEST_TEXT);
    expect(v.request_text?.taint).toBe('untrusted');
    expect(v.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.asked_lane).toBe('L4');
    expect(v.lane).toBe('L4');
    expect(v.intake_route).toBe('normal');
    expect(v.eligibility_reason).toBe('eligible');
    expect(v.lane_opens_at).not.toBeNull();
  });

  it('the documents: each type with its versions in order, who wrote them, and the gate that approved each by hash', async () => {
    const r = await get(`/v1/items/${item}/documents?on_behalf_of=ria`);
    expect(r.status).toBe(200);
    const v = ItemDocumentsView.parse(r.json);
    expect(v.not_intact).toBe(0);
    const spec = v.documents.find((d) => d.type === 'spec_delta');
    expect(spec?.group).toBe('spec');
    expect(spec?.versions.map((x) => x.version)).toEqual([1, 2]);
    const [v1, v2] = spec?.versions ?? [];
    // version 1 is what G2 approved: the ledger's decision on the subject hash that bound it
    expect(v1?.author).toMatchObject({ kind: 'agent', agent_id: primaryAgentFor('3.2')?.agent_id });
    const g2 = v1?.gates.find((g) => g.gate === 'G2');
    expect(g2).toMatchObject({ status: 'decided', outcome: 'approve' });
    expect(g2?.approvers.length).toBeGreaterThan(0);
    expect(g2?.ledger_entry_id).not.toBeNull();
    expect(g2?.card_id).not.toBeNull();
    // version 2 is a redraft nobody has decided
    expect(v2?.author).toEqual({ kind: 'factory' });
    expect(v2?.gates).toEqual([]);
    expect(v2?.markdown).toEqual(expect.any(String));
    expect(v2?.markdown).not.toBe(v1?.markdown);
    expect(v2?.sha256).not.toBe(v1?.sha256);
    // the intent block bound by G0 and G1, the design docs in their own group
    const intent = v.documents.find((d) => d.type === 'intent_block');
    expect(intent?.group).toBe('intent');
    expect(intent?.versions[0]?.gates.map((g) => g.gate)).toEqual(
      expect.arrayContaining(['G0', 'G1']),
    );
    expect(v.documents.find((d) => d.type === 'adr')?.group).toBe('design');
    expect(v.documents.find((d) => d.type === 'constitution_report')?.group).toBe('constitution');
  });

  it('the timeline: the record folded to steps with actor, time and codes, oldest first, never text', async () => {
    const r = await get(`/v1/items/${item}/timeline?on_behalf_of=ria`);
    expect(r.status).toBe(200);
    const v = ItemTimelineView.parse(r.json);
    const kinds = v.entries.map((e) => e.kind);
    expect(kinds[0]).toBe('item.created');
    expect(kinds).toContain('item.gate_decided');
    expect(kinds).toContain('artefact.stored');
    expect(kinds).not.toContain('item.command_done');
    const seqs = v.entries.map((e) => e.global_seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const g2 = v.entries.find((e) => e.kind === 'item.gate_decided' && e.gates.includes('G2'));
    expect(g2?.codes).toContain('outcome:approve');
    const stored = v.entries.find(
      (e) => e.kind === 'artefact.stored' && e.codes.includes('type:spec_delta'),
    );
    expect(stored?.step).toBe('3.2');
    expect(JSON.stringify(v)).not.toContain(REQUEST_TEXT);
  });

  it('the agent page: the contract with its schemas, and the newest runs with their items (quality.read)', async () => {
    const agent = primaryAgentFor('3.2')?.agent_id as string;
    expect((await get(`/v1/agents/${agent}?on_behalf_of=ria`)).status).toBe(403);
    const d = await get(`/v1/agents/${agent}?on_behalf_of=aud`);
    expect(d.status).toBe(200);
    const detail = AgentDetailView.parse(d.json);
    expect(detail.agent.agent_id).toBe(agent);
    expect(Object.keys(detail.output_schema).length).toBeGreaterThan(0);
    expect(Object.keys(detail.input_schema).length).toBeGreaterThan(0);
    expect(detail.input_schema_id).toMatch(/_input\.v1$/);
    expect((await get(`/v1/agents/nope?on_behalf_of=aud`)).status).toBe(400);
    const runs = await get(`/v1/agents/${agent}/runs?on_behalf_of=aud&limit=2`);
    expect(runs.status).toBe(200);
    const view = AgentRecentRunsView.parse(runs.json);
    expect(view.runs.length).toBeGreaterThan(0);
    expect(view.runs.length).toBeLessThanOrEqual(2);
    expect(view.runs.every((x) => x.agent_id === agent)).toBe(true);
    const starts = view.runs.map((x) => x.started_at);
    expect([...starts].sort().reverse()).toEqual(starts);
    expect(view.runs.some((x) => x.item_id === item)).toBe(true);
    expect((await get(`/v1/agents/${agent}/runs?on_behalf_of=aud&limit=0`)).status).toBe(400);
  });
});

describe('the clarifying round on the item (P2-16) and its pull requests (P3-5)', () => {
  it('says the round, the limit and the business-day deadline the silence parks the item on', async () => {
    const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, seeded.project, ['bob']);
    await bindProject(s.id, seeded.project, { requesters: ['ria'] });
    const ports = new FakeStagePorts();
    const asks: StageOutcome = {
      outcome: 'questions',
      questions: [{ text: 'Which table?', material: 'blocking' }],
    };
    ports.planning.scriptStep('1.5', [asks]);
    const sub = await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L3',
      requester: pr('ria'),
      channel: 'N1',
      text: 'Add pagination to the invoices list.',
    });
    if (!sub.ok) throw new Error(sub.error.message);
    const item = sub.value.item_id as string;
    await runItem(s, driverOver(s, { ports }), item, {
      stop: (st) => st.waiting?.kind === 'questions',
    });
    const r = await get(`/v1/items/${item}?on_behalf_of=ria`);
    expect(r.status).toBe(200);
    const v = ItemView.parse(r.json);
    expect(v.clarify).toMatchObject({ round: 1, rounds_max: 2, open: 1, then: 'parks' });
    expect(Date.parse(v.clarify?.deadline ?? '')).toBeGreaterThan(
      Date.parse(v.clarify?.since ?? ''),
    );
    expect(v.pull_requests).toEqual([]);
    // the Push Broker's pull request, as `core.pull_request` folds it: the link and the head on the item
    await s.record.pool.query(
      `INSERT INTO core.pull_request (repo, number, item_id, unit_key, head_ref, head_sha, state, draft)
       VALUES ($1, 7, $2, 'main', $3, $4, 'open', false)`,
      [seeded.repo, item, `agent/${item}/main`, 'c'.repeat(40)],
    );
    const again = ItemView.parse((await get(`/v1/items/${item}?on_behalf_of=ria`)).json);
    expect(again.pull_requests).toEqual([
      {
        repo: seeded.repo,
        number: 7,
        unit_key: 'main',
        head_ref: `agent/${item}/main`,
        head_sha: 'c'.repeat(40),
        state: 'open',
        draft: false,
        url: `https://github.com/${seeded.repo}/pull/7`,
      },
    ]);
    const t = ItemTimelineView.parse(
      (await get(`/v1/items/${item}/timeline?on_behalf_of=ria`)).json,
    );
    const raised = t.entries.find((e) => e.kind === 'item.questions_raised');
    expect(raised?.codes).toContain('round:1');
    expect(JSON.stringify(t)).not.toContain('Which table?');
  });
});
