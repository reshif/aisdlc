import type {
  ActionId,
  AskResult,
  AssistantBudgetView,
  NotificationList,
  NotificationPreferences,
  NotificationPreferencesView,
  ThreadList,
  ThreadView,
  ConfigKeySummary,
  ConfigKeyView,
  ConfigProposeResult,
  DecisionBatchView,
  DecisionQuery,
  MyAccessView,
  ItemActionResult,
  ItemObserveRequest,
  ItemPlanRequest,
  ItemPlanResult,
  PortalItemView,
  CardDeciders,
  LedgerAuditView,
  OnboardRequest,
  OnboardingCardSummary,
  PortalCardSummary,
  PortalInbox,
  PortalS0Revision,
  PortalSettingsRevision,
  ProjectDetail,
  ProjectPrrView,
  PortalIssueTwinView,
  IssueTwinBatchResult,
  IssueTwinRequestResult,
  ProjectSummary,
  S0Overview,
  EvidencePackView,
  FleetView,
  FloorView,
  GateCardContext,
  GateCheckRunsView,
  ItemVerifyView,
  AccessExplainView,
  AdmissionView,
  AgentRegistryView,
  AuditDecisionsView,
  CatalogueView,
  ControlKind,
  ControlsView,
  DirectoryView,
  EvalRunsView,
  EvalSummaryView,
  IntegrationsView,
  HealthView,
  ItemListView,
  KillsView,
  OpsPreview,
  SandboxSlots,
  Scope,
  AuditOutcome,
  AuditResultResult,
  DuplicateResult,
  FactoryRevisionView,
  ItemCloseOutView,
  LearnProposeResult,
  LearnRunResult,
  ProjectLearnView,
} from '@aisdlc/contracts';
import type { JsonSchema } from './lib/schema';

// The browser's only server is the bff, on this origin: one HttpOnly session cookie (sent by the
// browser by itself), a CSRF token from /api/me that a write must send back in a header. Nothing
// here holds a credential.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `GET /api/me`: who is signed in, what they may do at the top level, the CSRF token. */
export interface Me {
  readonly principal: { readonly principal_id: string; readonly display_name: string };
  readonly csrf_token: string;
  readonly actions: {
    readonly fleet: readonly ActionId[];
    readonly projects: ReadonlyArray<{ project_id: string; actions: readonly ActionId[] }>;
  };
}

/** `GET /api/config/keys/:key`: core's view plus what only the bff knows for this person. */
export type ConfigKeyWire = ConfigKeyView & {
  readonly may_propose: boolean;
  readonly principal_names: Readonly<Record<string, string>>;
};

export type OnboardInput = Omit<OnboardRequest, 'on_behalf_of'>;
export interface OnboardResult {
  readonly s0_id: string;
  readonly duplicate: boolean;
}

/** `GET /api/cards/:id`: the card with what it shows, who decides it and the form's JSON Schema. */
export interface CardDetailWire {
  readonly summary: OnboardingCardSummary;
  /** What the person is shown; its hash is the evidence a decision is bound to. */
  readonly view: Record<string, unknown>;
  readonly evidence_hash: string;
  readonly deciders: CardDeciders;
  /** Card 5: who decides its M4 gate. */
  readonly m4_deciders: CardDeciders | null;
  readonly decision_schema: JsonSchema;
  readonly decisions_allowed: readonly string[];
  readonly send_backs: { readonly used: number; readonly limit: number };
  /** The PDP's yes, and the person holds the slot (a card 5 also the m4 slot). */
  readonly may_decide: boolean;
  readonly principal_names: Readonly<Record<string, string>>;
}

/** `GET /api/cards/:id/artefacts`: what a work-item gate card (G1f, G2) decides, each artefact with its hash. */
export interface GateArtefactsWire {
  readonly card_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly gates: readonly string[];
  readonly subject_hash: string;
  /** False when an artefact is missing or its stored bytes do not hash to the bound hash. */
  readonly intact: boolean;
  readonly artefacts: ReadonlyArray<{
    readonly step: string;
    readonly type: string;
    readonly sha256: string;
    readonly version: number | null;
    /** Rendered for people; shown as text, never as HTML. */
    readonly markdown: string | null;
    readonly intact: boolean;
  }>;
}

/** `GET /api/cards/:id/gate`: a work-item gate card as something to decide. */
export interface GateCardWire {
  readonly card_id: string;
  readonly project_id: string;
  readonly item_id: string;
  readonly status: string;
  readonly gates: ReadonlyArray<{
    readonly gate_instance_id: string;
    readonly gate: string;
    readonly slot: string;
    readonly status: string;
    readonly outcome: string | null;
    readonly step_up_required: boolean;
  }>;
  readonly subject_hash: string;
  readonly proposed_lane: string | null;
  readonly base_sha: string | null;
  readonly injection_suspected: boolean;
  readonly deciders: { readonly slots: readonly string[]; readonly holders: readonly string[] };
  readonly decisions_allowed: readonly string[];
  readonly decision_reason: string | null;
  /** The PDP's yes, the person holds the role and the card is open (a step-up gate asks for the proof first). */
  readonly may_decide: boolean;
  /** Why not this person: the PDP's reasons first (`pdp_denied`), then `not_slot_holder`, `not_open`. */
  readonly why_not?: { readonly code: string; readonly reasons: readonly string[] } | null;
  readonly principal_names: Readonly<Record<string, string>>;
}

/** `GET /api/cards/:id/gate/context`: what an exception or quarantine gate binds, with the names of its deciders. */
export type GateContextWire = GateCardContext & {
  readonly principal_names: Readonly<Record<string, string>>;
};

export interface GateCardPreparedWire {
  readonly card_id: string;
  readonly gates: ReadonlyArray<{
    readonly gate_instance_id: string;
    readonly gate: string;
    readonly nonce: string;
    readonly expires_at: string;
    readonly subject_hash: string;
    readonly evidence_hash: string;
    readonly step_up: { readonly required: boolean; readonly bound_hash: string };
  }>;
}

export interface PreparedCard {
  readonly nonce: string;
  readonly expires_at: string;
  readonly evidence_hash: string;
  /** Card 5: the M4 gate needs a step-up proof bound to this hash. */
  readonly step_up: { readonly required: boolean; readonly bound_hash: string } | null;
}

/** What the ledger says about one decision. */
export interface LedgerReceipt {
  readonly ledger_seq: number;
  readonly entry_id: string;
  readonly entry_hash: string;
  readonly entry_type: string;
  readonly gate_id: string | null;
  readonly decision: string | null;
  readonly actor: string | null;
  readonly sod_waiver: boolean;
}

export interface CardDecision {
  readonly card_id: string;
  readonly decision: { readonly entries: readonly LedgerReceipt[]; readonly status: string };
  readonly applied: 'applied' | 'pending';
  readonly apply_error: string | null;
}

export interface DecideInput {
  readonly nonce: string;
  readonly decision: 'approve' | 'request_changes' | 'reject';
  readonly content?: unknown;
  readonly reason?: string;
  readonly step_up?: { readonly proof: string };
}

export type StepUpStart =
  | { readonly status: 'redirect'; readonly attempt_id: string; readonly authorize_url: string }
  | {
      readonly status: 'ready';
      readonly method: string;
      readonly proof: string;
      readonly bound_hash: string;
    };

export interface RevisionDecision {
  readonly entry: { ledger_seq: number; entry_hash: string; decision: string | null };
  readonly outcome: string | null;
  readonly published: boolean;
  readonly publish_error: string | null;
}

/** The browser's observed-signal bodies: the principal is the session's, never a field. */
export type PortalObserve =
  | Omit<Extract<ItemObserveRequest, { edge: 'B4' }>, 'on_behalf_of'>
  | Omit<Extract<ItemObserveRequest, { edge: 'R2' }>, 'on_behalf_of'>;
export type PortalPlan = Omit<ItemPlanRequest, 'on_behalf_of'>;

/** What the browser sends to the assistant: never a person or a data class (the bff adds them from the session). */
export type AskInput =
  | {
      /** `ThreadSubjectRequest`'s two shapes, with plain ids as the browser holds them. */
      readonly subject:
        | { readonly kind: 's0'; readonly s0_id: string }
        | { readonly kind: 'project'; readonly project_id: string };
      readonly text: string;
    }
  | { readonly thread_id: string; readonly text: string };

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'The factory could not be reached.');
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const retry = Number(res.headers.get('retry-after'));
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `The request failed (${res.status}).`,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return json as T;
}

/** A conditional GET: with the last ETag, an unchanged answer is `not_modified` and carries no body. */
export type Conditional<T> =
  | { readonly kind: 'fresh'; readonly etag: string | null; readonly value: T }
  | { readonly kind: 'not_modified' };

async function conditional<T>(path: string, etag: string | null): Promise<Conditional<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (etag !== null) headers['if-none-match'] = etag;
  let res: Response;
  try {
    res = await fetch(path, { method: 'GET', headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'The factory could not be reached.');
  }
  if (res.status === 304) return { kind: 'not_modified' };
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `The request failed (${res.status}).`,
    );
  }
  return { kind: 'fresh', etag: res.headers.get('etag'), value: json as T };
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  /** M19: a project's floor, cut to the person; polled with the last ETag. */
  floor: (project: string, etag: string | null) =>
    conditional<FloorView>(`/api/floor/${encodeURIComponent(project)}`, etag),
  /** M19: every project the person may see as one row (a confidential one without a role there collapsed). */
  fleet: () => request<FleetView>('GET', '/api/fleet'),
  /** The person's bindings, view level and data class per project (hints only; the server decides). */
  myAccess: () => request<MyAccessView>('GET', '/api/me/access'),
  /** A batch of PDP capability probes; a POST because it carries a body, so it sends the CSRF token. */
  decisions: (queries: readonly DecisionQuery[], csrf: string) =>
    request<DecisionBatchView>('POST', '/api/me/decisions', { queries }, csrf),
  configKeys: () =>
    request<{ keys: ConfigKeySummary[]; may_propose: boolean }>('GET', '/api/config/keys'),
  configKey: (key: string) =>
    request<ConfigKeyWire>('GET', `/api/config/keys/${encodeURIComponent(key)}`),
  proposeConfig: (
    key: string,
    b: { value: unknown; parent_rev_hash: string | null },
    csrf: string,
  ) =>
    request<ConfigProposeResult>(
      'POST',
      `/api/config/keys/${encodeURIComponent(key)}/proposals`,
      b,
      csrf,
    ),
  logout: (csrf: string) => request<{ ok: true }>('POST', '/api/logout', {}, csrf),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(id)}`),
  onboard: (input: OnboardInput, csrf: string) =>
    request<OnboardResult>('POST', '/api/onboard', input, csrf),
  s0: (id: string) => request<S0Overview>('GET', `/api/s0/${encodeURIComponent(id)}`),
  cards: (s0Id: string) =>
    request<PortalCardSummary[]>('GET', `/api/s0/${encodeURIComponent(s0Id)}/cards`),
  card: (id: string) => request<CardDetailWire>('GET', `/api/cards/${encodeURIComponent(id)}`),
  cardArtefacts: (id: string) =>
    request<GateArtefactsWire>('GET', `/api/cards/${encodeURIComponent(id)}/artefacts`),
  gateCard: (id: string) =>
    request<GateCardWire>('GET', `/api/cards/${encodeURIComponent(id)}/gate`),
  gateContext: (id: string) =>
    request<GateContextWire>('GET', `/api/cards/${encodeURIComponent(id)}/gate/context`),
  prepareGateCard: (id: string, csrf: string) =>
    request<GateCardPreparedWire>(
      'POST',
      `/api/cards/${encodeURIComponent(id)}/gate/prepare`,
      {},
      csrf,
    ),
  gateCardEvidence: (
    id: string,
    views: ReadonlyArray<{ nonce: string; evidence_hash: string }>,
    csrf: string,
  ) =>
    request<{ evidence_viewed: true }>(
      'POST',
      `/api/cards/${encodeURIComponent(id)}/gate/evidence`,
      { views },
      csrf,
    ),
  decideGateCard: (
    id: string,
    b: {
      decision: 'approve' | 'request_changes' | 'reject';
      reason?: string;
      votes: ReadonlyArray<{ nonce: string; step_up?: { proof: string } }>;
    },
    csrf: string,
  ) =>
    request<{
      readonly card_id: string;
      readonly entries: readonly LedgerReceipt[];
      readonly status: string;
    }>('POST', `/api/cards/${encodeURIComponent(id)}/gate/decide`, b, csrf),
  prepareCard: (id: string, csrf: string) =>
    request<PreparedCard>('POST', `/api/cards/${encodeURIComponent(id)}/prepare`, {}, csrf),
  cardEvidence: (id: string, b: { nonce: string; evidence_hash: string }, csrf: string) =>
    request<{ evidence_viewed: true }>(
      'POST',
      `/api/cards/${encodeURIComponent(id)}/evidence`,
      b,
      csrf,
    ),
  decideCard: (id: string, b: DecideInput, csrf: string) =>
    request<CardDecision>('POST', `/api/cards/${encodeURIComponent(id)}/decide`, b, csrf),
  recheck: (id: string, csrf: string) =>
    request<unknown>('POST', `/api/cards/${encodeURIComponent(id)}/recheck`, {}, csrf),
  /** Card 2 (M16): ask for the onboarding probe again (only when it ran nothing; the factory records the request). */
  retryProbe: (id: string, csrf: string) =>
    request<unknown>('POST', `/api/cards/${encodeURIComponent(id)}/probe/retry`, {}, csrf),
  /** Card 2: edit one file's proposed instruction text (secret-scanned by the factory before it is stored). */
  editInstructions: (
    id: string,
    b: { path: string; text: string; base_text_sha256: string | null },
    csrf: string,
  ) =>
    request<CardDetailWire>('POST', `/api/cards/${encodeURIComponent(id)}/instructions`, b, csrf),
  stepUpStart: (b: { subject_hash: string; return_to: string }, csrf: string) =>
    request<StepUpStart>('POST', '/api/step-up', b, csrf),
  stepUpCollect: (attempt: string) =>
    request<{ status: 'ready'; method: string; proof: string; bound_hash: string }>(
      'GET',
      `/api/step-up/${encodeURIComponent(attempt)}`,
    ),
  inbox: () => request<PortalInbox>('GET', '/api/inbox'),
  s0Revision: (s0Id: string) =>
    request<PortalS0Revision>('GET', `/api/s0/${encodeURIComponent(s0Id)}/revision`),
  revision: (gate: string) =>
    request<PortalSettingsRevision & { principal_names: Record<string, string> }>(
      'GET',
      `/api/revisions/${encodeURIComponent(gate)}`,
    ),
  prepareRevision: (gate: string, csrf: string) =>
    request<{ nonce: string; expires_at: string; evidence_hash: string }>(
      'POST',
      `/api/revisions/${encodeURIComponent(gate)}/prepare`,
      {},
      csrf,
    ),
  revisionEvidence: (gate: string, b: { nonce: string; evidence_hash: string }, csrf: string) =>
    request<{ evidence_viewed: true }>(
      'POST',
      `/api/revisions/${encodeURIComponent(gate)}/evidence`,
      b,
      csrf,
    ),
  decideRevision: (gate: string, b: { nonce: string; decision: string }, csrf: string) =>
    request<RevisionDecision>('POST', `/api/revisions/${encodeURIComponent(gate)}/decide`, b, csrf),
  publishRevision: (gate: string, csrf: string) =>
    request<{ published: boolean }>(
      'POST',
      `/api/revisions/${encodeURIComponent(gate)}/publish`,
      {},
      csrf,
    ),
  item: (id: string) => request<PortalItemView>('GET', `/api/items/${encodeURIComponent(id)}`),
  itemVerify: (id: string, head?: string) =>
    request<ItemVerifyView>(
      'GET',
      `/api/items/${encodeURIComponent(id)}/verify${head ? `?head=${encodeURIComponent(head)}` : ''}`,
    ),
  itemEvidence: (id: string, pack?: string) =>
    request<EvidencePackView>(
      'GET',
      `/api/items/${encodeURIComponent(id)}/evidence${pack ? `?pack=${encodeURIComponent(pack)}` : ''}`,
    ),
  itemGateCheck: (id: string) =>
    request<GateCheckRunsView>('GET', `/api/items/${encodeURIComponent(id)}/gate-check`),
  itemReady: (id: string, csrf: string) =>
    request<ItemActionResult>('POST', `/api/items/${encodeURIComponent(id)}/ready`, {}, csrf),
  itemAnswer: (id: string, b: { question_id: string; text: string }, csrf: string) =>
    request<ItemActionResult>('POST', `/api/items/${encodeURIComponent(id)}/answers`, b, csrf),
  itemObserve: (id: string, b: PortalObserve, csrf: string) =>
    request<ItemActionResult>('POST', `/api/items/${encodeURIComponent(id)}/observe`, b, csrf),
  itemPlan: (id: string, b: PortalPlan, csrf: string) =>
    request<ItemPlanResult>('POST', `/api/items/${encodeURIComponent(id)}/plan`, b, csrf),
  prr: (project: string) =>
    request<ProjectPrrView>('GET', `/api/projects/${encodeURIComponent(project)}/prr`),
  // ------------------------------------------------------------ the GitHub issue twin (M16)
  issueTwin: (project: string) =>
    request<PortalIssueTwinView>('GET', `/api/projects/${encodeURIComponent(project)}/issue-twin`),
  issueTwinBatch: (
    project: string,
    b: {
      repo: string;
      rows: ReadonlyArray<{ gap_id: string; disposition: 'file_issue' | 'track_only' }>;
    },
    csrf: string,
  ) =>
    request<IssueTwinBatchResult>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/issue-twin/batches`,
      b,
      csrf,
    ),
  issueTwinRequest: (project: string, b: { repo: string; gap_id: string }, csrf: string) =>
    request<IssueTwinRequestResult>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/issue-twin/requests`,
      b,
      csrf,
    ),
  // ------------------------------------------------------------ the assistant (M18)
  ask: (input: AskInput, csrf: string) =>
    request<AskResult>('POST', '/api/assistant/ask', input, csrf),
  threads: (f: { s0?: string; project?: string }) => {
    const qs = new URLSearchParams();
    if (f.s0) qs.set('s0', f.s0);
    if (f.project) qs.set('project', f.project);
    const q = qs.toString();
    return request<ThreadList>('GET', `/api/assistant/threads${q ? `?${q}` : ''}`);
  },
  thread: (id: string) =>
    request<ThreadView>('GET', `/api/assistant/threads/${encodeURIComponent(id)}`),
  assistantBudget: () => request<AssistantBudgetView>('GET', '/api/assistant/budget'),
  /**
   * A proposal button of kind `call`: the bff route it names, under the person's own session (the PDP decides there).
   * Only a path under `/api/` is ever called; the button never carries a body.
   */
  callProposal: (path: string, csrf: string) => {
    if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(path)) {
      return Promise.reject(new ApiError(400, 'invalid_route', 'Not a route the portal calls.'));
    }
    return request<unknown>('POST', path, {}, csrf);
  },
  // ------------------------------------------------------------ notifications (M18)
  notifications: () => request<NotificationList>('GET', '/api/me/notifications'),
  notificationPrefs: () =>
    request<NotificationPreferencesView>('GET', '/api/me/notifications/preferences'),
  setNotificationPrefs: (preferences: NotificationPreferences, csrf: string) =>
    request<NotificationPreferencesView>(
      'PUT',
      '/api/me/notifications/preferences',
      { preferences },
      csrf,
    ),
  // ------------------------------------------------------------ lists, quality, operate, govern, admin (2026-11-12)
  items: (project?: string) =>
    request<ItemListView>(
      'GET',
      `/api/items${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    ),
  agents: () => request<AgentRegistryView>('GET', '/api/agents'),
  evalSummary: () => request<EvalSummaryView>('GET', '/api/evals/summary'),
  evalRuns: () => request<EvalRunsView>('GET', '/api/evals/runs?limit=50'),
  integrations: () => request<IntegrationsView>('GET', '/api/integrations'),
  health: () => request<HealthView>('GET', '/api/health'),
  catalogue: () => request<CatalogueView>('GET', '/api/catalogue'),
  admission: () => request<AdmissionView>('GET', '/api/admission'),
  slots: () => request<SandboxSlots>('GET', '/api/slots'),
  controls: () => request<ControlsView>('GET', '/api/controls'),
  previewControl: (b: { kind: ControlKind; scope: Scope }, csrf: string) =>
    request<OpsPreview>('POST', '/api/controls/preview', b, csrf),
  applyControl: (
    b: { kind: ControlKind; scope: Scope; preview_id: string; nonce: string },
    csrf: string,
  ) => request<unknown>('POST', '/api/controls', b, csrf),
  liftControl: (id: string, reason: string, csrf: string) =>
    request<unknown>('POST', `/api/controls/${encodeURIComponent(id)}/lift`, { reason }, csrf),
  kills: () => request<KillsView>('GET', '/api/kills'),
  auditDecisions: (action?: string) =>
    request<AuditDecisionsView>(
      'GET',
      `/api/audit/decisions?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`,
    ),
  directory: () => request<DirectoryView>('GET', '/api/directory'),
  explain: (project: string) =>
    request<AccessExplainView>('GET', `/api/projects/${encodeURIComponent(project)}/explain`),
  // ------------------------------------------------------------ M15: release, review, close-out, learn, factory M1
  itemReRequestRelease: (id: string, key: string, csrf: string) =>
    request<ItemActionResult>(
      'POST',
      `/api/items/${encodeURIComponent(id)}/release/re-request`,
      { key },
      csrf,
    ),
  itemUnsure: (id: string, key: string, csrf: string) =>
    request<DuplicateResult>(
      'POST',
      `/api/items/${encodeURIComponent(id)}/review/unsure`,
      { key },
      csrf,
    ),
  itemEscape: (
    id: string,
    b: { lane: 'L0' | 'L1'; reason_code: string; key: string },
    csrf: string,
  ) => request<DuplicateResult>('POST', `/api/items/${encodeURIComponent(id)}/escape`, b, csrf),
  itemCloseout: (id: string) =>
    request<ItemCloseOutView>('GET', `/api/items/${encodeURIComponent(id)}/closeout`),
  itemAudit: (id: string, b: { outcome: AuditOutcome; reason_code: string }, csrf: string) =>
    request<AuditResultResult>('POST', `/api/items/${encodeURIComponent(id)}/audit`, b, csrf),
  learn: (project: string) =>
    request<ProjectLearnView & { may_propose: boolean }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/learn`,
    ),
  learnRun: (project: string, csrf: string) =>
    request<LearnRunResult>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/learn/run`,
      {},
      csrf,
    ),
  learnModeELift: (project: string, csrf: string) =>
    request<LearnProposeResult>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/learn/mode-e-lift`,
      {},
      csrf,
    ),
  factoryRevision: (gate: string) =>
    request<FactoryRevisionView & { may_decide: boolean }>(
      'GET',
      `/api/config/revisions/${encodeURIComponent(gate)}`,
    ),
  prepareFactoryRevision: (gate: string, csrf: string) =>
    request<{ nonce: string; expires_at: string; evidence_hash: string }>(
      'POST',
      `/api/config/revisions/${encodeURIComponent(gate)}/prepare`,
      {},
      csrf,
    ),
  factoryRevisionEvidence: (
    gate: string,
    b: { nonce: string; evidence_hash: string },
    csrf: string,
  ) =>
    request<unknown>('POST', `/api/config/revisions/${encodeURIComponent(gate)}/evidence`, b, csrf),
  decideFactoryRevision: (
    gate: string,
    b: { nonce: string; decision: 'approve' | 'reject' | 'request_changes' },
    csrf: string,
  ) =>
    request<unknown>('POST', `/api/config/revisions/${encodeURIComponent(gate)}/decide`, b, csrf),
  ledger: (project: string, s0?: string) =>
    request<LedgerAuditView>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/ledger${s0 ? `?s0=${encodeURIComponent(s0)}` : ''}`,
    ),
};

/** Where the browser downloads a pack's signed bytes (a plain GET with the session cookie). */
export const signedPackHref = (item: string, pack: string): string =>
  `/api/items/${encodeURIComponent(item)}/evidence/${encodeURIComponent(pack)}/signed`;
