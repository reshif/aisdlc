import { createServer, type Server } from 'node:http';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { bindProject, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';
import {
  CARD_ID,
  CORE_TOKEN,
  cardSummary,
  ITEM_ID,
  gateCardFixture,
  itemViewFixture,
} from './portal-fixtures.js';

// PLAN M14.6: the portal's S7 reads. Each needs the PDP's `project.view` on the item's project (core asks too) AND
// view level V2 there (content of the work), and is cut to the person's data class: a viewer at V1/D0 gets a 403, a
// D1 approver sees finding text but not tripwire evidence or secret findings, a D2 security approver sees all.
// gate-check that cannot be asked is `unknown`, never success. The fakes stand in for core and gate-check over HTTP.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const HEAD = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const PACK = 'a'.repeat(64);
const SIGNED = { format: 'aisdlc-signed-evidence-pack/1', pack_sha256: PACK, z: 1, a: [2, 1] };
const OBJECT_KEY = sha256Hex(new TextEncoder().encode(canonicalJson(SIGNED as never)));
const GC_TOKEN = 'bff-at-gate-check-'.padEnd(32, 'x');

const finding = (kind: string, message: string) => ({
  kind,
  severity: 'critical',
  repair_class: kind === 'secret_new' ? 'hard_fail' : 'quarantine',
  rule_id: null,
  path: 'src/a.ts',
  line: 3,
  message,
  withheld: false,
});
const step = (s: string, check: string, items: unknown[] = []) => ({
  step: s,
  check,
  status: items.length > 0 ? 'failed' : 'passed',
  verdict: items.length > 0 ? 'failed' : 'passed',
  result_sha256: 'e'.repeat(64),
  recorded_at: '2026-11-12T10:00:00.000Z',
  raised: null,
  gate: null,
  mutation: null,
  rules_version: null,
  kits: { total: 1, answered: 1 },
  findings: { total: items.length, failing: items.length, items },
  runs: 1,
});
const verifyView = () => ({
  item_id: ITEM_ID,
  project_id: 'acme',
  lane: 'L4',
  phase: 'S7',
  step: '7.4',
  unit_key: 'main',
  base_sha: BASE,
  head_sha: HEAD,
  heads: [
    { head_sha: HEAD, unit_key: 'main', results: 5, last_recorded_at: '2026-11-12T10:00:00.000Z' },
  ],
  steps: [
    step('7.1', 'deterministic', [finding('command_failed', 'npm test exited 1')]),
    step('7.2', 'test_integrity', [finding('stub_probe_passed', 'the oracle passed on the base')]),
    step('7.3', 'spec_conformance'),
    step('7.4', 'secrets_dependencies', [finding('secret_new', 'generic-api-key on line 3')]),
    step('7.5', 'constitution'),
  ],
  pack: null,
  data_class: 'D2',
});
const packSummary = {
  pack_sha256: PACK,
  unit_key: 'main',
  base_sha: BASE,
  head_sha: HEAD,
  passing: true,
  disposition: { kind: 'passed' },
  key_id: 'dev:notary#1',
  bucket: 'evidence-packs',
  object_key: OBJECT_KEY,
  handoff_pack_sha256: null,
  produced_at: '2026-11-12T10:00:00.000Z',
};
const evidenceView = () => ({
  item_id: ITEM_ID,
  project_id: 'acme',
  packs: [packSummary],
  pack: packSummary,
  contents: null,
  contents_problem: 'the object store is not configured for this service',
  verify_command: `aisdlc-verify-pack --pack ${OBJECT_KEY}.json --notary-key notary-evidence.jwk --head ${HEAD}`,
});
const gateContext = () => ({
  card_id: CARD_ID,
  project_id: 'acme',
  subject_kind: 'item',
  item_id: ITEM_ID,
  s0_id: null,
  gate: 'SECT',
  gate_instance_id: 'g-1',
  station: 'sect:1',
  step: null,
  requester: 'carol',
  quorum_required: 1,
  decisions: [],
  subject_hash: 'd'.repeat(64),
  binds: [{ label: 'station', value: 'sect:1' }],
  step_up: { required: false, bound_hash: 'd'.repeat(64) },
  check: step('7.2', 'test_integrity', [
    finding('stub_probe_passed', 'the oracle passed on the base'),
  ]),
  head_sha: HEAD,
  quarantine: {
    n: 1,
    cause: 'stub_probe_passed',
    origin_phase: 'S7',
    origin_step: '7.2',
    pack_sha256: null,
  },
  patch: null,
  dependencies: [],
  constitution: null,
  onboarding_pack: null,
  handoff: null,
  subject: null,
  data_class: 'D2',
});

// P1-3, P1-7, P1-8: the subject of a G4, a G6 and an X1, as core answers them (uncut)
const prLink = {
  repo: 'acme/web',
  number: 12,
  head_ref: 'agent/x/main',
  state: 'open',
  url: 'https://github.com/acme/web/pull/12',
};
const g4Subject = () => ({
  kind: 'merge_review',
  review: {
    schema: 'g4-review/1',
    mode: 'C',
    reasons: ['sensitive_path'],
    units: [{ unit_key: 'main', pr_number: 12, head_sha: HEAD, base_sha: BASE, pack_sha256: PACK }],
    evidence_sha256: PACK,
    changed_paths: { count: 2, sha256: 'f'.repeat(64) },
    sensitive_paths: ['db/migrations/1.sql'],
    step_up: true,
    deciders: { basis: 'path_owners', principals: ['bob'] },
    codeowners: { read: 'ok', at_sha: BASE, unmapped: [] },
    authors: [],
  },
  units: [
    {
      unit_key: 'main',
      head_sha: HEAD,
      base_sha: BASE,
      pack_sha256: PACK,
      pr: prLink,
      pack: packSummary,
      steps: [{ step: '7.1', check: 'deterministic', status: 'passed' }],
      paths: [
        { path: 'db/migrations/1.sql', sensitive: true, protected: false },
        { path: 'src/a.ts', sensitive: false, protected: false },
      ],
      paths_truncated: false,
    },
  ],
  standing: 'pending',
  b13: { used: 0, limit: 2, left: 2, exhausted_to: 'D3' },
});
const x1Subject = () => ({
  kind: 'irreversible_operation',
  reason_code: 'irreversible_operation',
  operation: {
    kind: 'irreversible_operation',
    source: 'tripwire',
    what: 'a force push',
    command: 'git push --force origin main',
    target: null,
    agent_note: null,
  },
  command_withheld: false,
});
const g6Subject = () => ({
  kind: 'acceptance',
  acceptance: { requester: 'carol', merged_sha: HEAD, release_output: null },
  intent: {
    sha256: 'e'.repeat(64),
    bound_by: 'gate:g-0',
    intact: true,
    goal: 'Admins can export orders',
    acceptance_criteria: ['An admin can download a CSV'],
    non_goals: [],
    withheld: false,
  },
  merged: [{ unit_key: 'main', pr: prLink, head_sha: HEAD, pack: packSummary, steps: [] }],
  release: null,
});
const withSubject = (gate: string, subject: unknown) => ({
  status: 200,
  json: { ...gateContext(), gate, station: gate, check: null, quarantine: null, subject },
});

interface Fake {
  readonly url: string;
  readonly seen: string[];
  readonly override: Map<string, { status: number; json: unknown }>;
  stop(): Promise<void>;
}

async function fakeServer(
  token: string,
  route: (path: string) => { status: number; json: unknown },
): Promise<Fake> {
  const seen: string[] = [];
  const override = new Map<string, { status: number; json: unknown }>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    seen.push(`${req.method} ${path}`);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: { code: 'unauthenticated' } });
    const o = override.get(path.split('?')[0] as string);
    if (o) return send(o.status, o.json);
    const r = route(path);
    return send(r.status, r.json);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    override,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let s: BffStack;
let core: Fake;
let gc: Fake;

beforeAll(async () => {
  core = await fakeServer(CORE_TOKEN, (path) => {
    const p = path.split('?')[0];
    if (p === `/v1/items/${ITEM_ID}`)
      return { status: 200, json: { ...itemViewFixture(), project_id: 'acme' } };
    if (p === `/v1/items/${ITEM_ID}/verify`) return { status: 200, json: verifyView() };
    if (p === `/v1/items/${ITEM_ID}/evidence`) return { status: 200, json: evidenceView() };
    if (p === `/v1/items/${ITEM_ID}/evidence/${PACK}/signed`) return { status: 200, json: SIGNED };
    if (p === `/v1/cards/${CARD_ID}/gate/context`) return { status: 200, json: gateContext() };
    if (p === `/v1/cards/${CARD_ID}/gate`) {
      const g = gateCardFixture('acme');
      return { status: 200, json: { ...g, deciders: { slots: ['sec'], holders: ['bob'] } } };
    }
    return { status: 404, json: { error: { code: 'not_found', message: 'no' } } };
  });
  gc = await fakeServer(GC_TOKEN, (path) =>
    path === `/v1/verdicts?item=${ITEM_ID}`
      ? {
          status: 200,
          json: {
            verdicts: [
              {
                seq: 3,
                verdict: {
                  repo: 'acme/web',
                  pr_number: 12,
                  head_sha: HEAD,
                  outcome: 'success',
                  reason: 'passed',
                  detail: 'pack for the head, G3 approved',
                  pack_sha256: PACK,
                },
                verdict_sha256: 'f'.repeat(64),
                check_run_id: '99',
                recorded_at: '2026-11-12T10:00:00.000Z',
              },
            ],
          },
        }
      : { status: 400, json: {} },
  );
  s = await startBffStack({
    override: {
      core: new HttpCoreClient({ baseUrl: core.url, token: CORE_TOKEN }),
      gateCheck: new HttpCoreClient({ baseUrl: gc.url, token: GC_TOKEN }),
    },
  });
  // alice: project admin (V3, D1); bob: security approver (V2, D2); dora: viewer (V1, D0); carol: nothing on acme
  await bindProject(s.identity, 'acme', { admin: ['alice'], sec: ['bob'] });
  await grantRole(s.identity.deps, 'dora', 'project.viewer', { kind: 'project', ref: 'acme' });
});
afterAll(async () => {
  await s.stop();
  await core.stop();
  await gc.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  gc.override.clear();
});

const browsers = new Map<string, Browser>();
async function get(who: 'alice' | 'bob' | 'carol' | 'dora', path: string) {
  let b = browsers.get(who);
  if (!b) {
    b = (await signIn(s, who)).browser;
    browsers.set(who, b);
  }
  const res = await b.request(`${s.base}${path}`);
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, res };
}

describe('GET /api/items/:id/verify', () => {
  it('cuts finding text to the data class: D1 sees ordinary findings, not tripwire evidence or secrets', async () => {
    const r = await get('alice', `/api/items/${ITEM_ID}/verify`);
    expect(r.status).toBe(200);
    expect(r.json.data_class).toBe('D1');
    const msg = (st: string) => r.json.steps.find((x: Json) => x.step === st).findings.items[0];
    expect(msg('7.1')).toMatchObject({ message: 'npm test exited 1', withheld: false });
    expect(msg('7.2')).toMatchObject({ message: null, withheld: true });
    expect(msg('7.4')).toMatchObject({ message: null, withheld: true });
    expect(r.text).not.toContain('generic-api-key');
    // core was asked as alice, the principal of the session
    expect(core.seen).toContain(`GET /v1/items/${ITEM_ID}/verify?on_behalf_of=alice`);
  });

  it('a D2 security approver sees the tripwire evidence and the secret finding', async () => {
    const r = await get('bob', `/api/items/${ITEM_ID}/verify`);
    expect(r.status).toBe(200);
    expect(r.json.data_class).toBe('D2');
    expect(r.text).toContain('the oracle passed on the base');
  });

  it('a viewer at V1 gets a 403 and no content; someone who may not view the project a 403 too', async () => {
    const v1 = await get('dora', `/api/items/${ITEM_ID}/verify`);
    expect(v1.status).toBe(403);
    expect(v1.json.error.code).toBe('view_level');
    expect(v1.text).not.toContain('npm test');
    const none = await get('carol', `/api/items/${ITEM_ID}/verify`);
    expect(none.status).toBe(403);
    expect(none.text).not.toContain('npm test');
  });

  it('refuses a head that is not a commit sha before core is asked', async () => {
    const r = await get('alice', `/api/items/${ITEM_ID}/verify?head=nope`);
    expect(r.status).toBe(400);
    expect(core.seen).toHaveLength(0);
  });
});

describe('the Evidence Pack', () => {
  it('GET /api/items/:id/evidence: V2 and project.view', async () => {
    const r = await get('alice', `/api/items/${ITEM_ID}/evidence`);
    expect(r.status).toBe(200);
    expect(r.json.pack.pack_sha256).toBe(PACK);
    expect((await get('dora', `/api/items/${ITEM_ID}/evidence`)).status).toBe(403);
  });

  it('the signed bytes are canonical and hash to the recorded object key', async () => {
    const r = await get('alice', `/api/items/${ITEM_ID}/evidence/${PACK}/signed`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-disposition')).toContain(`${OBJECT_KEY}.json`);
    expect(sha256Hex(new TextEncoder().encode(r.text))).toBe(OBJECT_KEY);
    expect(r.text).toBe(canonicalJson(SIGNED as never));
  });

  it('bytes that do not hash to the object key are never sent', async () => {
    core.override.set(`/v1/items/${ITEM_ID}/evidence/${PACK}/signed`, {
      status: 200,
      json: { ...SIGNED, z: 2 },
    });
    const r = await get('alice', `/api/items/${ITEM_ID}/evidence/${PACK}/signed`);
    expect(r.status).toBe(502);
    expect(r.text).not.toContain('"z":2');
  });
});

describe('GET /api/items/:id/gate-check', () => {
  it('maps gate-check’s verdicts', async () => {
    const r = await get('alice', `/api/items/${ITEM_ID}/gate-check`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
    expect(r.json.verdicts[0]).toMatchObject({
      outcome: 'success',
      head_sha: HEAD,
      pr_number: 12,
      check_run_id: 99,
    });
  });

  it('gate-check failing or answering nonsense is unknown, never success', async () => {
    gc.override.set('/v1/verdicts', { status: 500, json: {} });
    const a = await get('alice', `/api/items/${ITEM_ID}/gate-check`);
    expect(a.json).toEqual({ item_id: ITEM_ID, status: 'unknown', verdicts: [] });
    gc.override.set('/v1/verdicts', {
      status: 200,
      json: {
        verdicts: [
          {
            seq: 1,
            verdict: { outcome: 'success' },
            verdict_sha256: 'x',
            check_run_id: null,
            recorded_at: 'x',
          },
        ],
      },
    });
    const b = await get('alice', `/api/items/${ITEM_ID}/gate-check`);
    expect(b.json.status).toBe('unknown');
  });

  it('needs V2', async () => {
    expect((await get('dora', `/api/items/${ITEM_ID}/gate-check`)).status).toBe(403);
  });
});

describe('the gate screens', () => {
  it('GET /api/cards/:id/gate/context is cut to the data class and names the people', async () => {
    const a = await get('alice', `/api/cards/${CARD_ID}/gate/context`);
    expect(a.status).toBe(200);
    expect(a.json.check.findings.items[0]).toMatchObject({ message: null, withheld: true });
    expect(a.json.data_class).toBe('D1');
    const b = await get('bob', `/api/cards/${CARD_ID}/gate/context`);
    expect(b.json.check.findings.items[0].message).toBe('the oracle passed on the base');
    expect((await get('dora', `/api/cards/${CARD_ID}/gate/context`)).status).toBe(403);
  });

  it('G4 (P1-3): the review, the PR link, the pack and the diff by path pass through to a V2 person', async () => {
    core.override.set(`/v1/cards/${CARD_ID}/gate/context`, withSubject('G4', g4Subject()));
    const a = await get('alice', `/api/cards/${CARD_ID}/gate/context`);
    expect(a.status).toBe(200);
    expect(a.json.subject).toEqual(g4Subject());
    expect((await get('dora', `/api/cards/${CARD_ID}/gate/context`)).status).toBe(403);
  });

  it('X1 (P1-8): the command is tripwire evidence: D2 sees it, D1 gets the classification only', async () => {
    core.override.set(`/v1/cards/${CARD_ID}/gate/context`, withSubject('X1', x1Subject()));
    const a = await get('alice', `/api/cards/${CARD_ID}/gate/context`);
    expect(a.json.subject).toMatchObject({
      operation: { what: 'a force push', command: null },
      command_withheld: true,
    });
    const b = await get('bob', `/api/cards/${CARD_ID}/gate/context`);
    expect(b.json.subject).toEqual(x1Subject());
  });

  it('G6 (P1-7): the intent and its acceptance criteria reach D1 and above', async () => {
    core.override.set(`/v1/cards/${CARD_ID}/gate/context`, withSubject('G6', g6Subject()));
    const a = await get('alice', `/api/cards/${CARD_ID}/gate/context`);
    expect(a.json.subject.intent).toMatchObject({
      acceptance_criteria: ['An admin can download a CSV'],
      withheld: false,
    });
  });

  it('a subject that is not the contract’s shape is refused (502), never shown in part', async () => {
    core.override.set(
      `/v1/cards/${CARD_ID}/gate/context`,
      withSubject('G4', { ...g4Subject(), b13: { used: -1 } }),
    );
    expect((await get('alice', `/api/cards/${CARD_ID}/gate/context`)).status).toBe(502);
  });

  it('P3-8: GET /api/cards/:id/kind answers both kinds after project.view, with one route', async () => {
    const gate = await get('alice', `/api/cards/${CARD_ID}/kind`);
    expect(gate.status).toBe(200);
    expect(gate.json).toEqual({ card_id: CARD_ID, kind: 'work_gate' });
    expect((await get('carol', `/api/cards/${CARD_ID}/kind`)).status).toBe(403);
    core.override.set(`/v1/cards/${CARD_ID}/summary`, {
      status: 200,
      json: cardSummary('acme'),
    });
    const onb = await get('alice', `/api/cards/${CARD_ID}/kind`);
    expect(onb.json).toEqual({ card_id: CARD_ID, kind: 'onboarding' });
    expect((await get('carol', `/api/cards/${CARD_ID}/kind`)).status).toBe(403);
    // neither kind: the one 404
    expect(
      (await get('alice', `/api/cards/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/kind`))
        .status,
    ).toBe(404);
  });

  it('GET /api/cards/:id/gate says why not: the PDP’s reasons first, then the slot', async () => {
    const viewer = await get('dora', `/api/cards/${CARD_ID}/gate`);
    expect(viewer.status).toBe(200);
    expect(viewer.json.may_decide).toBe(false);
    expect(viewer.json.why_not.code).toBe('pdp_denied');
    expect(viewer.json.why_not.reasons.length).toBeGreaterThan(0);
    const holder = await get('bob', `/api/cards/${CARD_ID}/gate`);
    expect(holder.json).toMatchObject({ may_decide: true, why_not: null });
  });

  it('a gate that needs a step-up is decidable (the proof is asked for on the page)', async () => {
    const g = gateCardFixture('acme');
    core.override.set(`/v1/cards/${CARD_ID}/gate`, {
      status: 200,
      json: {
        ...g,
        gates: g.gates.map((x) => ({ ...x, step_up_required: true })),
        deciders: { slots: ['sec'], holders: ['bob'] },
      },
    });
    const r = await get('bob', `/api/cards/${CARD_ID}/gate`);
    expect(r.json.may_decide).toBe(true);
  });
});
