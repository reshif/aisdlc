import type {
  OnboardingStepId,
  OnboardingStepState,
  PortalCardSummary,
  ProjectSummary,
  S0Overview,
} from '@aisdlc/contracts';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App, createQueryClient } from '../src/App';
import type { Me } from '../src/api';

export const NOW = '2026-11-08T10:00:00.000Z';
export const S0_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54';
export const CARD_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe99';

export const me = (fleet: Me['actions']['fleet'] = ['project.onboard']): Me => ({
  principal: { principal_id: 'alice', display_name: 'Alice Admin' },
  csrf_token: 'csrf-token-of-alice',
  actions: { fleet, projects: [] },
});

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Answer = { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = Answer | ((c: Call) => Answer);

/** Replaces `fetch` with a table keyed by `METHOD path`; an unknown route is a test failure. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const table = { ...routes };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      const call: Call = {
        method,
        path,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const h = table[`${method} ${path}`];
      if (h === undefined) throw new Error(`unexpected request ${method} ${path}`);
      const a = typeof h === 'function' ? h(call) : h;
      const status = a.status ?? 200;
      return new Response(a.json === undefined ? '' : JSON.stringify(a.json), {
        status,
        headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
      });
    }),
  );
  return { calls, table };
}

export function renderAt(path: string) {
  window.history.pushState(null, '', path);
  return render(<App client={createQueryClient()} />);
}

const STEPS: OnboardingStepId[] = ['0.1', '0.2', '0.3', '0.4', '0.5'];

export function s0(
  over: {
    status?: S0Overview['record']['status'];
    states?: Partial<Record<OnboardingStepId, OnboardingStepState>>;
    causes?: Partial<Record<OnboardingStepId, string>>;
    waiting?: string | null;
    level?: 'census' | 'light' | 'full';
    rejected_at?: OnboardingStepId | null;
  } = {},
): S0Overview {
  return {
    record: {
      s0_id: S0_ID,
      project_id: 'testbed',
      repo_id: 'reshif__asf-factory-testbed',
      status: over.status ?? 'running',
      requested_level: over.level ?? 'census',
      signable_level: over.level ?? 'census',
      intake_ref: 'record:abc',
      rejected_at: over.rejected_at ?? null,
      readiness_version: null,
      catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    },
    steps: STEPS.map((step) => ({
      s0_id: S0_ID,
      step,
      state: over.states?.[step] ?? 'todo',
      blocked_cause: over.causes?.[step] ?? null,
      started_at: null,
      finished_at: null,
    })),
    waiting: over.waiting ?? null,
    send_backs: Object.fromEntries(STEPS.map((x) => [x, 0])),
    failures: Object.fromEntries(STEPS.map((x) => [x, 0])),
  } as S0Overview;
}

export const card = (over: Partial<PortalCardSummary> = {}): PortalCardSummary =>
  ({
    card_id: CARD_ID,
    s0_id: S0_ID,
    project_id: 'testbed',
    card: 'C1',
    step: '0.1',
    status: 'open',
    slot: 'admin',
    opened_at: NOW,
    payload_hash: null,
    actionable: true,
    may_decide: true,
    ...over,
  }) as PortalCardSummary;

export const repoOf = () => ({
  repo_id: 'reshif__asf-factory-testbed',
  repo_ref: 'reshif/asf-factory-testbed',
  project_id: 'testbed',
  host: 'github.com',
  owner: 'reshif',
  name: 'asf-factory-testbed',
  visibility: null,
  owner_type: null,
  plan: null,
  default_branch: null,
  stack: null,
  onboarding_level: 'none' as const,
});

export const projectOf = (over: Record<string, unknown> = {}): ProjectSummary['project'] =>
  ({
    project_id: 'testbed',
    name: 'testbed',
    team_id: null,
    classification: 'internal' as const,
    stack: null,
    deploys: null,
    tier: null,
    level: null,
    owner: null,
    version: 1,
    updated_at: NOW,
    ...over,
  }) as ProjectSummary['project'];

export const summaryOf = (over: Partial<ProjectSummary> = {}): ProjectSummary =>
  ({
    project: projectOf(),
    repos: [repoOf()],
    latest_s0: {
      s0_id: S0_ID,
      repo: 'reshif/asf-factory-testbed',
      status: 'card',
      requested_level: 'census',
      signable_level: 'census',
      waiting: null,
      updated_at: NOW,
    },
    ...over,
  }) as ProjectSummary;
