import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  CoreInboxItem,
  DEFAULT_GATING_PROFILE,
  DEFAULT_TWO_PERSON,
  EMPTY_ROLE_MAP,
  LedgerAuditView,
  OnboardingCardSummary,
  ProjectDetail,
  ProjectPrrView,
  ProjectSummary,
  S0Overview,
  SettingsRevisionView,
  SubmitRequestReceipt,
  type OnboardingStepId,
  type OnboardingStepState,
} from '@aisdlc/contracts';
import { HttpCoreClient } from '../src/core-client.js';

// A core stand-in over real HTTP: it records what the bff sent (method, path, headers, body), so a
// test can assert what core would have seen (the service token, no browser cookie, the principal).

export const CORE_TOKEN = 'bff-at-core-'.padEnd(32, 'x');
export const ITEM_ID = '33333333-4444-4555-8666-777777777777';

export function itemViewFixture() {
  return {
    item_id: ITEM_ID,
    project_id: 'acme',
    repo: 'acme/web',
    request_id: ITEM_ID,
    phase: 'S1',
    lane: null,
    proposed_lane: 'L3',
    terminal: null,
    waiting: null,
    holds: [],
    questions: [],
    gates: [],
    outstanding: 1,
    catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
    terminal_cause: null,
    rework_total: 0,
    handoff: null,
    assumptions: [],
    injection_suspected: false,
    dedupe_links: [],
    profile_gates: null,
    clarify: null,
    pull_requests: [],
  };
}

export const HANDOFF_ID = '55555555-6666-4777-8888-999999999999';
export const E4_GATE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
export const E4_CARD = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

/** An item handed off from S6 (D1, ET1) whose E4 is open. */
export function handoffFixture() {
  return {
    handoff_id: HANDOFF_ID,
    item_id: ITEM_ID,
    n: 1,
    code: 'D1',
    trigger: 'ET1',
    origin_phase: 'S6',
    origin_step: null,
    pack: { pack_id: `handoff-pack:${HANDOFF_ID}`, content_sha256: 'd'.repeat(64) },
    e4_gate_instance_id: E4_GATE,
    e4_decided: false,
    status: 'open',
    choice: null,
    chosen_by: null,
    extension: null,
    opened_at: '2026-11-09T10:00:00.000Z',
    chosen_at: null,
  };
}

export function handoffViewFixture() {
  return {
    item_id: ITEM_ID,
    project_id: 'acme',
    lane: 'L3',
    phase: 'Handoff',
    waiting: 'handoff:e4',
    handoff: handoffFixture(),
    e4: {
      gate_instance_id: E4_GATE,
      card_id: E4_CARD,
      status: 'pending',
      outcome: null,
      approvers: [],
    },
    choices: [],
    extension_max_percent: 50,
    human_led: null,
    done: [],
  };
}

/** Core's receipt of a request (P1-1): routed to L8 by the repo's level, with who decides G0 and G1. */
export function requestReceiptFixture() {
  return {
    request_id: ITEM_ID,
    item_id: ITEM_ID,
    state: 'routed_l8',
    verdict: {
      repo: 'acme/web',
      lane: 'L3',
      eligible: false,
      route: 'l8',
      reason: 'level_too_low',
      prr: null,
    },
    duplicate: false,
    dedupe_links: [],
    injection: { suspected: false, rules: [], lines: [], text_sha256: 'b'.repeat(64) },
    asked_lane: 'L3',
    proposed_lane: 'L8',
    lane_opens_at: 'light',
    request_text: {
      text: 'Add pagination to the orders list.',
      taint: 'untrusted',
      origin: 'request',
      provenance: {
        channel: 'N1',
        source: null,
        received_at: NOW,
        submitted_by: 'alice',
        raw_sha256: 'c'.repeat(64),
        normalised_sha256: 'd'.repeat(64),
      },
      flags: [],
    },
    deciders: [
      { gate: 'G0', slot: 'intent', holders: ['bob'], reason: null },
      { gate: 'G1', slot: 'intent', holders: ['bob'], reason: null },
    ],
  };
}

export function agentRunsFixture() {
  return {
    item_id: ITEM_ID,
    project_id: 'acme',
    runs: [
      {
        run_id: '44444444-5555-4666-8777-888888888888',
        item_id: ITEM_ID,
        project_id: 'acme',
        unit_id: null,
        step: '1.3',
        attempt: 1,
        lane: 'L3',
        agent_id: 'A1',
        contract_version: '1.0.0',
        prompt_ref: 'a1_triage@1.0.0',
        prompt_sha256: 'a'.repeat(64),
        provider: null,
        model: null,
        vkey_id: 'vk-1',
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_micro_usd: 0,
        state: 'finished',
        result: 'classified',
        failure_code: null,
        started_at: '2026-11-09T10:00:00.000Z',
        ended_at: '2026-11-09T10:00:01.000Z',
        outcome: {
          run_id: '44444444-5555-4666-8777-888888888888',
          verdict: 'accepted',
          judgements: [],
          back_edges: [],
          triggers: [],
        },
      },
    ],
  };
}

export function agentStatsFixture(agent: string, project: string | null) {
  return {
    agent_id: agent,
    project_id: project,
    runs: 2,
    finished: 2,
    failed: 0,
    judged: 2,
    accepted: 1,
    rejected: 0,
    sent_back: 1,
    reworked: 0,
    handed_off: 0,
    with_back_edge: 1,
    acceptance_rate: 0.5,
    back_edge_rate: 0.5,
    calls: 4,
    tokens_in: 400,
    tokens_out: 200,
    cost_micro_usd: 1000,
    cost_per_run_micro_usd: 500,
  };
}

export function evalSummaryFixture() {
  return {
    rows: [
      {
        task_id: 't-1',
        profile: 'A1.classify',
        suite: 'triage',
        provider: 'fake',
        trials: 3,
        passes: 3,
        pass_rate: 1,
        pass_k: 1,
        k: 3,
        status: 'pass',
      },
    ],
  };
}

export const S0_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54';
export const CARD_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe99';
export const GATE_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77';
const NOW = '2026-11-08T10:00:00.000Z';

const STEPS: OnboardingStepId[] = ['0.1', '0.2', '0.3', '0.4', '0.5'];

export function project(id: string) {
  return {
    project_id: id,
    name: id,
    team_id: null,
    classification: 'internal',
    stack: null,
    deploys: null,
    tier: null,
    level: null,
    owner: null,
    version: 1,
    updated_at: NOW,
  };
}

export const repo = (projectId: string, ref: string) => ({
  repo_id: ref.replace('/', '__'),
  repo_ref: ref,
  project_id: projectId,
  host: 'github.com',
  owner: ref.split('/')[0],
  name: ref.split('/')[1],
  visibility: null,
  owner_type: null,
  plan: null,
  default_branch: null,
  stack: null,
  onboarding_level: 'none',
});

export function s0Overview(
  projectId: string,
  states: Partial<Record<OnboardingStepId, OnboardingStepState>> = { '0.1': 'card' },
  waiting: string | null = null,
) {
  return {
    record: {
      s0_id: S0_ID,
      project_id: projectId,
      repo_id: 'acme__web',
      status: 'card',
      requested_level: 'census',
      signable_level: 'census',
      intake_ref: 'record:abc',
      rejected_at: null,
      readiness_version: null,
      catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    },
    steps: STEPS.map((step) => ({
      s0_id: S0_ID,
      step,
      state: states[step] ?? 'todo',
      blocked_cause: null,
      started_at: null,
      finished_at: null,
    })),
    waiting,
    send_backs: Object.fromEntries(STEPS.map((s) => [s, 0])),
    failures: Object.fromEntries(STEPS.map((s) => [s, 0])),
  };
}

/** What a work-item gate card (G2) decides: the artefacts its subject hash binds (M12). */
export function gateArtefactsFixture(projectId: string) {
  return {
    card_id: CARD_ID,
    project_id: projectId,
    item_id: ITEM_ID,
    gates: ['G2'],
    subject_hash: 'c'.repeat(64),
    intact: true,
    artefacts: [
      {
        step: '3.2',
        type: 'spec_delta',
        sha256: 'd'.repeat(64),
        version: 1,
        markdown: '# Spec delta\n',
        intact: true,
      },
    ],
  };
}

/** A work-item card as something to decide (Gap B): G2, pending, alice holds the slot. */
export function gateCardFixture(projectId: string) {
  return {
    card_id: CARD_ID,
    project_id: projectId,
    item_id: ITEM_ID,
    status: 'open',
    gates: [
      {
        gate_instance_id: '0190a000-0000-7000-8000-0000000000f1',
        gate: 'G2',
        slot: 'intent',
        status: 'pending',
        outcome: null,
        step_up_required: false,
      },
    ],
    subject_hash: 'c'.repeat(64),
    proposed_lane: null,
    base_sha: null,
    injection_suspected: false,
    deciders: { slots: ['intent'], holders: ['alice'] },
    decisions_allowed: ['approve', 'reject', 'request_changes'],
    decision_reason: null,
  };
}

export function cardSummary(projectId: string) {
  return {
    card_id: CARD_ID,
    s0_id: S0_ID,
    project_id: projectId,
    card: 'C1',
    step: '0.1',
    status: 'open',
    slot: 'admin',
    opened_at: NOW,
    payload_hash: null,
    actionable: true,
  };
}

const deciders = (holders: string[]) => ({
  slot: 'admin',
  holders,
  single_operator: holders.length === 1,
  sod_waiver: holders.length === 1,
  tier: 'T0',
  t2: false,
  can_decide: holders.length > 0,
  error: null,
});

export function revisionView(projectId: string, holders = ['alice']) {
  return {
    gate_instance_id: GATE_ID,
    project_id: projectId,
    s0_id: S0_ID,
    rev_hash: 'c'.repeat(64),
    proposed_by: 'alice',
    status: 'pending',
    outcome: null,
    published: false,
    settings: {
      role_map: EMPTY_ROLE_MAP,
      two_person: DEFAULT_TWO_PERSON,
      gating_profile: DEFAULT_GATING_PROFILE,
      kill_delegations: [],
    },
    evidence_hash: 'd'.repeat(64),
    deciders: deciders(holders),
  };
}

export function inboxItems() {
  const card = (
    projectId: string,
    holders: string[],
    over: { id?: string; label?: string } = {},
  ) => ({
    card_id: over.id ?? CARD_ID,
    kind: 'onboarding_card',
    id: CARD_ID,
    project_id: projectId,
    s0_id: S0_ID,
    label: 'C1',
    slot: 'admin',
    opened_at: NOW,
    sla_due_at: '2026-11-09T10:00:00.000Z',
    overdue: false,
    escalated: false,
    holders,
    item_id: null,
    gate: null,
    feasibility: 'feasible',
    feasibility_reason: null,
    ...over,
  });
  return [
    card('acme', ['alice']),
    card('secret', ['root']),
    {
      kind: 'settings_revision',
      id: GATE_ID,
      project_id: 'acme',
      s0_id: S0_ID,
      label: null,
      slot: 'admin',
      opened_at: NOW,
      sla_due_at: null,
      overdue: false,
      escalated: false,
      holders: ['alice'],
      item_id: null,
      gate: 'M1',
      card_id: null,
      feasibility: 'feasible',
      feasibility_reason: null,
    },
    // A card of acme that bob (an intent approver) can see but alice alone decides.
    card('acme', ['alice'], { label: 'C4', id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe88' }),
  ];
}

export function summary(projectId: string) {
  return {
    project: project(projectId),
    repos: [repo(projectId, 'acme/web')],
    latest_s0: {
      s0_id: S0_ID,
      repo: 'acme/web',
      status: 'card',
      requested_level: 'census',
      signable_level: 'census',
      waiting: null,
      updated_at: NOW,
    },
  };
}

// The fixtures must be what the contracts say, or the tests prove nothing.
ProjectSummary.parse(summary('acme'));
ProjectDetail.parse({
  project: project('acme'),
  repos: [repo('acme', 'acme/web')],
  s0: [s0Overview('acme')],
});
S0Overview.parse(s0Overview('acme'));
OnboardingCardSummary.parse(cardSummary('acme'));
inboxItems().forEach((i) => CoreInboxItem.parse(i));
SubmitRequestReceipt.parse(requestReceiptFixture());
SettingsRevisionView.parse(revisionView('acme'));
const prrFixture = (id: string) => ({
  project_id: id,
  repos: [{ repo: 'acme/web', governing: null, proposed: null }],
});
ProjectPrrView.parse(prrFixture('acme'));
LedgerAuditView.parse({ project_id: 'acme', s0_id: null, entries: [], head: null });

export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

/** project of everything the fake serves, unless a test changes it. */
export interface FakeCore {
  readonly client: HttpCoreClient;
  readonly seen: Seen[];
  /** `status` and body for the next calls, by `METHOD path`; unset paths use the defaults. */
  readonly override: Map<string, { status: number; json: unknown }>;
  projectOfRecords: string;
  stop(): Promise<void>;
}

export async function startFakeCore(): Promise<FakeCore> {
  const seen: Seen[] = [];
  const override = new Map<string, { status: number; json: unknown }>();
  const state = { projectOfRecords: 'acme' };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const method = req.method ?? 'GET';
      seen.push({ method, path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${CORE_TOKEN}`) {
        return reply(401, { error: { code: 'unauthenticated', message: 'no' } });
      }
      const o = override.get(`${method} ${path}`);
      if (o) return reply(o.status, o.json);
      const p = state.projectOfRecords;
      if (method === 'GET' && path === '/v1/projects') {
        return reply(200, [summary('acme'), summary('secret')]);
      }
      if (method === 'GET' && /^\/v1\/projects\/[a-z0-9_-]+\/overview$/.test(path)) {
        const id = path.split('/')[3] as string;
        return reply(200, {
          project: project(id),
          repos: [repo(id, 'acme/web')],
          s0: [s0Overview(id)],
        });
      }
      if (method === 'POST' && path === '/v1/onboard') {
        return reply(201, { s0_id: S0_ID, duplicate: false });
      }
      if (method === 'POST' && path === '/v1/requests') {
        return reply(201, requestReceiptFixture());
      }
      if (method === 'GET' && path.startsWith(`/v1/items/${ITEM_ID}?on_behalf_of=`)) {
        return reply(200, itemViewFixture());
      }
      if (method === 'GET' && path.startsWith(`/v1/items/${ITEM_ID}/handoff?on_behalf_of=`)) {
        return reply(200, handoffViewFixture());
      }
      if (method === 'POST' && path === `/v1/items/${ITEM_ID}/plan`) {
        return reply(200, {
          item: itemViewFixture(),
          units: 1,
          base_sha: 'b'.repeat(40),
          outputs: { '5.1': 'c'.repeat(64) },
        });
      }
      if (
        method === 'POST' &&
        /^\/v1\/items\/[0-9a-f-]+\/(ready|answers|observe|human-done|hand-back|handoff\/choose)$/.test(
          path,
        )
      ) {
        return reply(200, { item: itemViewFixture(), duplicate: false });
      }
      if (method === 'GET' && path.startsWith(`/v1/agent-runs?item=${ITEM_ID}&on_behalf_of=`)) {
        return reply(200, agentRunsFixture());
      }
      const st = /^\/v1\/agents\/([A-Za-z0-9]+)\/stats\?(.*)$/.exec(path);
      if (method === 'GET' && st) {
        const project = new URLSearchParams(st[2]).get('project');
        return reply(200, agentStatsFixture(st[1] as string, project));
      }
      if (method === 'GET' && path.startsWith('/v1/evals/summary?')) {
        return reply(200, evalSummaryFixture());
      }
      if (method === 'GET' && path.startsWith('/v1/evals/runs?')) return reply(200, { runs: [] });
      if (method === 'GET' && /^\/v1\/agents\/[A-Za-z0-9]+\/scores\?/.test(path)) {
        return reply(200, { agent_id: 'A1', scores: [] });
      }
      if (method === 'GET' && path === `/v1/s0/${S0_ID}`) return reply(200, s0Overview(p));
      if (method === 'GET' && path === `/v1/s0/${S0_ID}/cards`) {
        return reply(200, [cardSummary(p)]);
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}/summary`) {
        return reply(200, cardSummary(p));
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}/gate`) {
        return reply(200, gateCardFixture(p));
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}/artefacts`) {
        return reply(200, gateArtefactsFixture(p));
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}`) {
        return reply(200, {
          summary: cardSummary(p),
          view: { card: 'C1' },
          deciders: deciders(['alice']),
          m4_deciders: null,
        });
      }
      if (method === 'POST' && path.startsWith(`/v1/cards/${CARD_ID}/`)) {
        return reply(200, { ok: path.split('/').pop() });
      }
      if (method === 'GET' && path === '/v1/inbox') return reply(200, inboxItems());
      if (method === 'GET' && path === `/v1/s0/${S0_ID}/revision`) {
        return reply(200, { revision: revisionView(p) });
      }
      if (method === 'GET' && path === `/v1/revisions/${GATE_ID}`) {
        return reply(200, revisionView(p));
      }
      if (method === 'POST' && path.startsWith(`/v1/revisions/${GATE_ID}/`)) {
        return reply(200, { ok: path.split('/').pop() });
      }
      if (method === 'GET' && /^\/v1\/projects\/[a-z0-9_-]+\/prr$/.test(path)) {
        return reply(200, prrFixture(path.split('/')[3] as string));
      }
      const led = /^\/v1\/projects\/([a-z0-9_-]+)\/ledger(\?.*)?$/.exec(path);
      if (method === 'GET' && led) {
        return reply(200, { project_id: led[1], s0_id: null, entries: [], head: null });
      }
      return reply(404, { error: { code: 'not_found', message: 'no such route' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    client: new HttpCoreClient({ baseUrl: `http://127.0.0.1:${port}`, token: CORE_TOKEN }),
    seen,
    override,
    get projectOfRecords() {
      return state.projectOfRecords;
    },
    set projectOfRecords(v: string) {
      state.projectOfRecords = v;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
