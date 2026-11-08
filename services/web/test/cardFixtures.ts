import {
  C1DecisionContent,
  C4DecisionContent,
  C5DecisionContent,
  EMPTY_ROLE_MAP,
  SecrDecisionContent,
  type CardKind,
} from '@aisdlc/contracts';
import { z } from 'zod';
import type { CardDetailWire, LedgerReceipt } from '../src/api';
import { CARD_ID, NOW, S0_ID } from './helpers';

// Card details as core serves them: a view per card kind and the JSON Schema of what a decision
// sends, generated from the same contracts core uses.

export const EVIDENCE = 'e'.repeat(64);
export const REPORT_HASH = 'f'.repeat(64);
export const RECORD_HASH = 'a1'.repeat(32);
export const ENTRY_HASH = 'b2'.repeat(32);

const schemaOf = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;

const deciders = (holders: string[], over: object = {}) => ({
  slot: 'admin',
  holders,
  single_operator: holders.length === 1,
  sod_waiver: holders.length === 1,
  tier: 'T0',
  t2: false,
  can_decide: holders.length > 0,
  error: null,
  ...over,
});

export const gap = (id: string, over: object = {}) => ({
  gap_id: `gap:reshif.asf:${id}`,
  criterion: id,
  severity: 'tracked',
  blocks_level: null,
  visibility_class: 'public_safe',
  default_disposition: 'track_only',
  allowed_dispositions: ['file_issue', 'track_only', 'waive'],
  ...over,
});

export const c1View = (over: Record<string, unknown> = {}) => ({
  card: 'C1',
  repo: 'reshif/asf-factory-testbed',
  requested_level: 'census',
  signable_level: 'census',
  census: {
    census_id: 'census:reshif.asf:abc',
    census_hash: 'c'.repeat(64),
    baseline_sha: '0123456789abcdef0123456789abcdef01234567',
    refs_covered: 'all',
  },
  tier: {
    floor: 'T0',
    detector_floor: 'T0',
    project_attested_floor: null,
    floor_basis: 'complete',
    signals: [],
    regulatory: 'unattested',
    criticality: 'unattested',
    t0: 'unattested',
    blocks_m4_reasons: ['t0_unattested', 'regulatory_unattested', 'criticality_unattested'],
    raise_only: true,
  },
  t0_attestation: { required: true, text: 'no prod, no real data, no dependants' },
  posture: { state: 'green', reasons: [] },
  blockers: [],
  security: { status: 'ok', open: 0 },
  gap_counts: { total: 3, blocking: 1, tracked: 2, private_only: 1 },
  gaps: [
    gap('RS-TH-1', {
      severity: 'blocking',
      blocks_level: 'light',
      default_disposition: 'file_issue',
      allowed_dispositions: ['file_issue', 'track_only'],
    }),
    gap('RS-AI-1'),
    gap('RS-SEC-1', {
      visibility_class: 'private_only',
      allowed_dispositions: ['track_only'],
    }),
  ],
  max_waiver_days: 90,
  owner_suggestions: [],
  ...over,
});

export const controls = (over: Record<string, unknown> = {}) => ({
  schema: 'controls/1',
  repo: 'reshif/asf-factory-testbed',
  branch: 'main',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  reduced: true,
  controls: [
    { id: 'B4a', status: 'met', blocking: true, reasons: [], instruction: null },
    {
      id: 'B4b',
      status: 'not_met',
      blocking: true,
      reasons: ['a check is not pinned'],
      instruction: 'Pin every required status check to the factory App.',
    },
    { id: 'protect_main', status: 'recorded', blocking: false, reasons: [], instruction: null },
    { id: 'codeowners', status: 'unknown', blocking: false, reasons: [], instruction: null },
  ],
  blocking_open: ['B4b'],
  report_hash: REPORT_HASH,
  ...over,
});

const proposed = (admin = ['alice']) => ({
  ...EMPTY_ROLE_MAP,
  admin: { kind: 'principals', principals: admin },
  m4: { kind: 'principals', principals: admin },
  g4: { kind: 'codeowners' },
});

export const c4View = (over: Record<string, unknown> = {}, ctl = controls()) => ({
  card: 'C4',
  reduced: true,
  controls_report: ctl,
  instructions: [],
  can_decide: ctl.blocking_open.length === 0,
  recheck: { action: 'recheck' },
  attestations: {
    required: [
      'bypass_has_no_factory_app',
      'app_scope_selected',
      'github_token_readonly',
      'actions_cannot_approve_prs',
      'fork_pr_approval_required',
      'secret_scanning',
    ],
    secret_scanning_values: ['on', 'plan_unavailable'],
  },
  tier: 'T0',
  role_map: {
    proposed: proposed(),
    basis: {
      codeowners_read: 'ok',
      collaborators_read: 'ok',
      unmapped_logins: [],
      fallback_admin_used: true,
    },
    current: null,
  },
  two_person: { locked_on: false, current: null, default: { enabled: true } },
  gating_profile: { current: null, t2_floor_applies: false, project_deploys: null },
  kill_delegations: { current: [] },
  ...over,
});

export const c5View = (over: Record<string, unknown> = {}) => ({
  card: 'C5',
  repo: 'reshif/asf-factory-testbed',
  requested_level: 'census',
  signed_level: 'census',
  owners: ['alice'],
  tier: { value: 'T0', floor: 'T0', raised_by: [] },
  m4_package: {
    census_hash: 'c'.repeat(64),
    gap_ledger_hash: 'd'.repeat(64),
    controls_report_hash: REPORT_HASH,
    prr_record_hash: RECORD_HASH,
  },
  prr: {
    record_id: 'prr:testbed:reshif.asf',
    version: 1,
    supersedes: null,
    record_hash: RECORD_HASH,
    status: 'proposed',
    issued_at: NOW,
    fresh_until: '2027-02-06T10:00:00.000Z',
    review_by: null,
    baseline_sha: '0123456789abcdef0123456789abcdef01234567',
    composite: 1,
    pillars: [
      { pillar: 'VRL', level: 1 },
      { pillar: 'ERL', level: 2 },
    ],
    autonomy: {
      tier_cap: 'A3',
      level_cap: 'A1',
      readiness_cap: 'A2',
      posture_cap: null,
      probation_until: null,
      effective: 'A1',
      lanes_eligible: ['L2', 'L8'],
      r3_zones: [],
    },
    writes: 'none',
    gating_profile: {},
    two_person: { enabled: false, locked_on: false },
    signer: {
      principal: 'alice',
      role: 'project.onboarding_signer',
      mode: 'solo',
      sod_waiver: true,
    },
    security_summary: { history_scan: { status: 'ok', open: 0 } },
    gaps: { total: 3, blocking: 0, waived: 1 },
  },
  m4: { gate: 'M4', subject_hash: RECORD_HASH, step_up: 'bound to record_hash' },
  ...over,
});

export const secrView = (over: Record<string, unknown> = {}) => ({
  card: 'SECR',
  repo: 'reshif/asf-factory-testbed',
  ordinal: 1,
  of: 2,
  counts: { open: 2, rotated: 0, false_positive: 0, accepted_test_fixture: 0 },
  states: ['rotated', 'false_positive', 'accepted_test_fixture'],
  guidance: 'Rotate the credential first, then mark the finding rotated.',
  ...over,
});

const SCHEMAS = {
  C1: C1DecisionContent,
  C4: C4DecisionContent,
  C5: C5DecisionContent,
  SECR: SecrDecisionContent,
} as const;

const STEP = { C1: '0.1', C4: '0.4', C5: '0.5', SECR: '0.1' } as const;

export function detail(
  kind: Exclude<CardKind, 'C2' | 'C3' | 'BATCH' | 'X2'>,
  view: object,
  over: Partial<CardDetailWire> = {},
): CardDetailWire {
  return {
    summary: {
      card_id: CARD_ID,
      s0_id: S0_ID,
      project_id: 'testbed',
      card: kind,
      step: STEP[kind],
      status: 'open',
      slot: 'admin',
      opened_at: NOW,
      payload_hash: null,
      actionable: true,
    } as never,
    view: view as Record<string, unknown>,
    evidence_hash: EVIDENCE,
    deciders: deciders(['alice']) as never,
    m4_deciders: kind === 'C5' ? (deciders(['alice'], { slot: 'm4' }) as never) : null,
    decision_schema: schemaOf(SCHEMAS[kind]),
    decisions_allowed: kind === 'SECR' ? ['approve'] : ['approve', 'request_changes', 'reject'],
    send_backs: { used: 0, limit: 1 },
    may_decide: true,
    principal_names: { alice: 'Alice Admin' },
    ...over,
  };
}

export const receipt = (over: Partial<LedgerReceipt> = {}): LedgerReceipt => ({
  ledger_seq: 7,
  entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbeaa',
  entry_hash: ENTRY_HASH,
  entry_type: 'card.step_decision',
  gate_id: null,
  decision: 'approve',
  actor: 'alice',
  sod_waiver: true,
  ...over,
});

export const decided = (entries: LedgerReceipt[] = [receipt()]) => ({
  card_id: CARD_ID,
  decision: { entries, status: 'decided', payload_hash: 'p'.repeat(64) },
  applied: 'applied' as const,
  apply_error: null,
});
