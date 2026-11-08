import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  OnboardingCardSummary,
  ProjectDetail,
  ProjectSummary,
  S0Overview,
  type OnboardingStepId,
  type OnboardingStepState,
} from '@aisdlc/contracts';
import { HttpCoreClient } from '../src/core-client.js';

// A core stand-in over real HTTP: it records what the bff sent (method, path, headers, body), so a
// test can assert what core would have seen (the service token, no browser cookie, the principal).

export const CORE_TOKEN = 'bff-at-core-'.padEnd(32, 'x');
export const S0_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54';
export const CARD_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe99';
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
      if (method === 'GET' && path === `/v1/s0/${S0_ID}`) return reply(200, s0Overview(p));
      if (method === 'GET' && path === `/v1/s0/${S0_ID}/cards`) {
        return reply(200, [cardSummary(p)]);
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}/summary`) {
        return reply(200, cardSummary(p));
      }
      if (method === 'GET' && path === `/v1/cards/${CARD_ID}`) {
        return reply(200, { summary: cardSummary(p), view: { card: 'C1' }, deciders: {} });
      }
      if (method === 'POST' && path.startsWith(`/v1/cards/${CARD_ID}/`)) {
        return reply(200, { ok: path.split('/').pop() });
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
