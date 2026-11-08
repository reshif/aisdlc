import { hashCanonical } from '@aisdlc/kernel';
import {
  cardPayloadHash,
  gapId,
  prrRecordId,
  sealPrr,
  type Card,
  type Gap,
  type PrrBody,
  type ProjectReadinessRecord,
  type ProjectSettings,
  type RoleMap,
} from '../../src/index.js';

// Valid samples. Each is plain JSON data (as it arrives from outside), typed loosely on purpose:
// the tests parse them, so the schemas are what is under test.

export const U1 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ab';
export const U2 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ac';
export const U3 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ad';
export const U4 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ae';
export const T0 = '2026-11-08T10:00:00Z';
export const T1 = '2026-11-09T10:00:00Z';
export const H = (s: string): string => hashCanonical(s);
export const SHA40 = 'a'.repeat(40);
export const CAT = { version: '1.0.0', hash: H('catalogue') };

/** Test-only: the samples are plain JSON, so branded ids are asserted here, and the schemas under test do the checking. */
const as = <T>(v: unknown): T => v as T;

export function roleMap(): RoleMap {
  const one = { kind: 'principals', principals: ['alice'] };
  return as<RoleMap>({
    admin: one,
    requesters: one,
    intent: one,
    design: one,
    g4: { kind: 'codeowners' },
    g5: one,
    x: one,
    sec: one,
    m4: one,
    kill: one,
  });
}

export function gatingProfile() {
  return {
    gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
    schedule: 'auto',
    tier_floor_applied: true,
  } as const;
}

export function projectSettings(): ProjectSettings {
  return as<ProjectSettings>({
    project_id: 'acme-web',
    role_map: roleMap(),
    two_person: { enabled: true, default: 'on_if_2plus', locked_on: false },
    gating_profile: { ...gatingProfile() },
    kill_delegations: [
      {
        delegate: 'bob',
        scope: { kind: 'project', ref: 'acme-web' },
        granted_by: 'alice',
        granted_at: T0,
        revoked_at: null,
      },
    ],
    version: 1,
    updated_at: T0,
  });
}

export function gap(over: Partial<Gap> = {}): Gap {
  const base = {
    gap_id: gapId('r1', 'RS-BT-3'),
    repo_id: 'r1',
    criterion: 'RS-BT-3',
    area: null,
    severity: 'tracked',
    blocks_level: null,
    disposition: 'track_only',
    status: 'open',
    issue: null,
    remediation_item_ref: null,
    waiver: null,
    visibility_class: 'public_safe',
    ...over,
  };
  return base as Gap;
}

export function card(over: Partial<Card> = {}): Card {
  const payload: Card['payload'] = [
    {
      kind: 'gap_disposition',
      gap_id: gapId('r1', 'RS-BT-3'),
      criterion: 'RS-BT-3',
      disposition: 'track_only',
    },
    { kind: 'claim_verdict', claim_id: 'c1', verdict: 'affirm' },
  ];
  return {
    card_id: U3,
    s0_id: U1,
    card: 'C5',
    status: 'open',
    role: 'm4',
    decisions: [
      { target: '0.5', gate_instance_id: null, decision: null, ledger_entry_id: null },
      { target: 'M4', gate_instance_id: null, decision: null, ledger_entry_id: null },
    ],
    payload,
    payload_hash: cardPayloadHash(payload),
    send_backs: 0,
    created_at: T0,
    decided_at: null,
    ...over,
  } as Card;
}

export type PrrOver = Partial<PrrBody>;

/** A valid, sealed `prr/1` for a Light-signed T1 project. */
export function prrBody(over: PrrOver = {}): PrrBody {
  const body = as<PrrBody>({
    schema: 'prr/1',
    record_id: prrRecordId('acme-web', 'r1'),
    version: 1,
    supersedes: null,
    status: 'active',
    repo: {
      owner: 'acme',
      name: 'web',
      repo_id: 'r1',
      visibility: 'private',
      owner_type: 'org',
      plan: 'team',
      default_branch: 'main',
      archetype: null,
    },
    baseline_sha: SHA40,
    pins: {
      catalogue: CAT,
      criteria_set: 'CRITERIA_V2@1.0.0',
      detector_set: 'detectors@0.1.0',
      governance_cap_map: 'caps@0.1.0',
    },
    level: {
      requested: 'light',
      signed: 'light',
      by_area: { '*': 'light' },
      steps: { '0.1': 'done', '0.2': 'done', '0.3': 'not_requested', '0.4': 'done', '0.5': 'done' },
    },
    tier: {
      value: 'T1',
      floor: 'T1',
      raised_by: [],
      t0_attested: false,
      risk_category_hash: H('risk'),
    },
    pillars: [
      {
        pillar: 'VRL',
        level: 2,
        criteria: [{ id: 'RS-BT-1', class: 'FLOOR', met: true, evidence_ref: 'probe:1' }],
      },
      { pillar: 'ERL', level: 3, criteria: [] },
      {
        pillar: 'ORL',
        level: 2,
        criteria: [{ id: 'RS-OP-1', class: 'FLOOR', met: 'unknown', evidence_ref: null }],
      },
      { pillar: 'KRL', level: 3, criteria: [], by_area: { '*': 3 } },
    ],
    gating_profile: { ...gatingProfile(), project_deploys: true },
    role_map: {
      slots: roleMap(),
      kill_delegations: [],
      two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
      source: { codeowners_sha: SHA40, collaborators_read_at: T0 },
    },
    composite: 2,
    autonomy: {
      tier_cap: 'A3',
      level_cap: 'A3',
      readiness_cap: 'A2',
      posture_cap: null,
      probation_until: '2026-12-06T10:00:00Z',
      effective: 'A1',
      lanes_eligible: ['L1', 'L2', 'L3', 'L8'],
      r3_zones: [],
    },
    writes: 'docs',
    affirmed: {
      instructions: [
        {
          area: '*',
          path: 'AGENTS.md',
          text_sha256: H('agents'),
          source_blob_sha: SHA40,
          lint_report_hash: H('lint'),
          step_up_ref: null,
          sod_waiver: true,
        },
      ],
      claims: {
        total_high_impact: 50,
        affirmed: 40,
        corrected: 2,
        unknown: 5,
        pct: 94,
        claims_hash: H('claims'),
      },
      intent: {
        answers_hash: H('answers'),
        attested_by: 'alice',
      },
      operations: null,
    },
    controls: {
      effective_rules: {
        hash: H('rules'),
        required_checks: [{ name: 'gate-check', integration_id: 42 }],
        read_at: T0,
      },
      attested: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        at: T0,
        by: 'alice',
      },
      app_installation: {
        installation_id: 7,
        repository_selection: 'selected',
        permissions: { contents: 'read', pull_requests: 'write' },
      },
      codeowners: { path: '.github/CODEOWNERS', blob_sha: SHA40, errors: 0 },
      sensitive_paths_hash: H('paths'),
      egress_request_ref: 'egress:1',
    },
    security_summary: {
      history_scan: {
        status: 'ok',
        refs_covered: 'all',
        commits_scanned: 1200,
        truncated: false,
        open: 0,
        rotated: 1,
        false_positive: 2,
        rules_version: 'rules@1',
      },
    },
    gaps: [gap()],
    signer: {
      principal: 'alice',
      role: 'EM',
      mode: 'solo',
      sod_waiver: true,
    },
    m4: {
      ledger_entry_id: U2,
      decision_hash: H('m4'),
    },
    issued_at: T0,
    fresh_until: '2027-02-06T10:00:00Z',
    review_by: '2027-02-08T10:00:00Z',
    freshness: { last_mechanical_check_at: T0, last_check_sha: SHA40, stale_areas: [] },
    ...over,
  });
  return body;
}

export function prr(over: PrrOver = {}): ProjectReadinessRecord {
  return sealPrr(prrBody(over));
}
