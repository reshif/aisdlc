// Fixtures of the M14.6 screens: an item in S7, its checks, its Evidence Pack, gate-check's verdicts, and the gate
// cards S7 raises (Q1 through SECT, E6, X2, X3, E2). Shapes are the contracts' (`portal-verify.ts`, `planning.ts`).

export const ITEM = '44444444-5555-4666-8777-888888888888';
export const CARD = '55555555-6666-4777-8888-999999999999';
export const HEAD = 'c3d9e20'.padEnd(40, '0');
export const BASE = '3f9c2ab'.padEnd(40, '0');
export const PACK = 'a'.repeat(64);
export const OBJ = 'b'.repeat(64);
export const SUBJECT = 'd'.repeat(64);
export const NOW = '2026-11-12T10:00:00.000Z';

export const accessAt = (view: 'V1' | 'V2' | 'V3', data: 'D0' | 'D1' | 'D2' = 'D1') => ({
  principal: { principal_id: 'alice', display_name: 'Alice Admin' },
  roles_version: '1.1.0',
  bindings: [],
  fleet: { view_level: null, data_class: null, roles: [], actions: [] },
  projects: [
    {
      project_id: 'testbed',
      view_level: view,
      data_class: data,
      roles: ['project.approver'],
      actions: ['project.view'],
    },
  ],
});

export const itemView = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'reshif/asf-factory-testbed',
  request_id: ITEM,
  phase: 'S7',
  lane: 'L4',
  proposed_lane: 'L4',
  terminal: null,
  waiting: 'gates:X2',
  holds: [],
  questions: [],
  gates: [],
  outstanding: 0,
  terminal_cause: null,
  rework_total: 0,
  handoff: null,
  assumptions: [],
  catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
  injection_suspected: false,
  dedupe_links: [],
  may: { ready: false, answer: false, observe: false, plan: false },
  ...over,
});

const notRun = (step: string, check: string) => ({
  step,
  check,
  status: 'not_run',
  verdict: null,
  result_sha256: null,
  recorded_at: null,
  raised: null,
  gate: null,
  mutation: null,
  rules_version: null,
  kits: { total: 0, answered: 0 },
  findings: { total: 0, failing: 0, items: [] },
  runs: 0,
});

const passed = (step: string, check: string, over: Record<string, unknown> = {}) => ({
  ...notRun(step, check),
  status: 'passed',
  verdict: 'passed',
  result_sha256: step.replace('.', '').padEnd(64, 'e'),
  recorded_at: NOW,
  kits: { total: 2, answered: 2 },
  runs: 1,
  ...over,
});

export const x2Step = (message: string | null = 'CODEOWNERS changed', withheld = false) =>
  passed('7.4', 'secrets_dependencies', {
    status: 'raised',
    raised: { kind: 'gate', gate: 'X2', reason_code: 'protected_path' },
    gate: {
      gate: 'X2',
      gate_instance_id: 'g-x2',
      status: 'pending',
      outcome: null,
      card_id: CARD,
    },
    rules_version: 'secrets-v7',
    findings: {
      total: 1,
      failing: 1,
      items: [
        {
          kind: 'protected_path',
          severity: 'high',
          repair_class: 'hard_fail',
          rule_id: 'X2',
          path: 'CODEOWNERS',
          line: 12,
          message,
          withheld,
        },
      ],
    },
  });

export const verifyView = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  lane: 'L4',
  phase: 'S7',
  step: '7.4',
  unit_key: 'main',
  base_sha: BASE,
  head_sha: HEAD,
  heads: [{ head_sha: HEAD, unit_key: 'main', results: 4, last_recorded_at: NOW }],
  steps: [
    passed('7.1', 'deterministic'),
    passed('7.2', 'test_integrity', {
      mutation: { total: 6, killed: 5, survived: 1, unknown: 0, min_score: 0.5 },
    }),
    passed('7.3', 'spec_conformance'),
    x2Step(),
    notRun('7.5', 'constitution'),
  ],
  pack: null,
  data_class: 'D1',
  ...over,
});

export const packSummary = (over: Record<string, unknown> = {}) => ({
  pack_sha256: PACK,
  unit_key: 'main',
  base_sha: BASE,
  head_sha: HEAD,
  passing: true,
  disposition: { kind: 'passed' },
  key_id: 'dev:notary#3',
  bucket: 'evidence-packs',
  object_key: OBJ,
  handoff_pack_sha256: null,
  produced_at: NOW,
  ...over,
});

const packStep = (step: string, check: string) => ({
  step,
  check,
  result_sha256: step.replace('.', '').padEnd(64, 'e'),
  verdict: 'passed',
  inputs_sha256: 'f'.repeat(64),
  raised: null,
  gate_approved: null,
  met: true,
  mutation: null,
  rules_version: null,
  findings: { total: 0, failing: 0, items: [] },
});

export const evidenceView = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  packs: [packSummary()],
  pack: packSummary(),
  contents: {
    format: 'aisdlc-evidence-pack/1',
    lane: 'L4',
    tier: 'T1',
    profile_sha256: 'c'.repeat(64),
    catalogue_ref: { version: '1.3.0', hash: 'a'.repeat(64) },
    units: ['main'],
    steps: [
      packStep('7.1', 'deterministic'),
      packStep('7.2', 'test_integrity'),
      packStep('7.3', 'spec_conformance'),
      packStep('7.4', 'secrets_dependencies'),
      packStep('7.5', 'constitution'),
    ],
    gates: [
      {
        gate: 'G3',
        gate_instance_id: 'g-g3',
        station: 'G3',
        status: 'decided',
        outcome: 'approve',
        decisions: [
          { entry_id: 'e1', ledger_seq: 18166, entry_hash: '1'.repeat(64), decision: 'approve' },
        ],
      },
    ],
    push_receipt: {
      receipt_id: 'r-1',
      patch_hash: '9'.repeat(64),
      head_sha: HEAD,
      pr_number: 412,
    },
    oracle_locks: 4,
    signature: { alg: 'ES256', key_id: 'dev:notary#3' },
    verified: true,
  },
  contents_problem: null,
  verify_command: `aisdlc-verify-pack --pack ${OBJ}.json --notary-key notary-evidence.jwk --head ${HEAD} --item ${ITEM} --object-key ${OBJ}`,
  ...over,
});

export const gateCheckView = (status: 'ok' | 'unknown' = 'ok') => ({
  item_id: ITEM,
  status,
  verdicts:
    status === 'ok'
      ? [
          {
            seq: 2,
            recorded_at: NOW,
            check_run_id: 7,
            verdict_sha256: '2'.repeat(64),
            repo: 'reshif/asf-factory-testbed',
            pr_number: 412,
            head_sha: HEAD,
            outcome: 'success',
            reason: 'passed',
            detail: 'pack for the head, G3 approved',
            pack_sha256: PACK,
          },
          {
            seq: 1,
            recorded_at: NOW,
            check_run_id: 6,
            verdict_sha256: '3'.repeat(64),
            repo: 'reshif/asf-factory-testbed',
            pr_number: 412,
            head_sha: '1d77e3b'.padEnd(40, '0'),
            outcome: 'failure',
            reason: 'head_moved',
            detail: 'the PR head moved',
            pack_sha256: null,
          },
        ]
      : [],
});

/** `GET /api/cards/:id/gate` of a card with one gate. */
export const gateCard = (gate: string, over: Record<string, unknown> = {}) => ({
  card_id: CARD,
  project_id: 'testbed',
  item_id: ITEM,
  status: 'open',
  gates: [
    {
      gate_instance_id: `g-${gate}`,
      gate,
      slot: gate === 'SECT' ? 'sec' : 'x',
      status: 'pending',
      outcome: null,
      step_up_required: false,
    },
  ],
  subject_hash: SUBJECT,
  proposed_lane: 'L4',
  base_sha: null,
  injection_suspected: false,
  deciders: { slots: [gate === 'SECT' ? 'sec' : 'x'], holders: ['alice', 'bob'] },
  decisions_allowed: ['approve', 'reject', 'request_changes'],
  decision_reason: null,
  may_decide: true,
  why_not: null,
  principal_names: { alice: 'Alice Admin', bob: 'Bob Builder' },
  ...over,
});

const STATION: Record<string, string> = {
  SECT: 'sect:1',
  E6: '7.2!E6',
  X2: '7.4!X2',
  X3: '6.4!X3',
  E2: '4.5!E2',
};

/** `GET /api/cards/:id/gate/context`. */
export const gateContext = (gate: string, over: Record<string, unknown> = {}) => ({
  card_id: CARD,
  project_id: 'testbed',
  item_id: ITEM,
  gate,
  gate_instance_id: `g-${gate}`,
  station: STATION[gate] ?? gate,
  step: gate === 'SECT' ? null : (STATION[gate] ?? '').split('!')[0],
  requester: 'carol',
  quorum_required: gate === 'X2' || gate === 'E2' ? 2 : 1,
  decisions: [],
  subject_hash: SUBJECT,
  binds: [
    { label: 'item', value: ITEM },
    { label: 'station', value: STATION[gate] ?? gate },
    { label: 'lane profile', value: 'c'.repeat(64) },
  ],
  step_up: { required: false, bound_hash: SUBJECT },
  check: gate === 'X2' ? x2Step() : null,
  head_sha: HEAD,
  quarantine:
    gate === 'SECT'
      ? {
          n: 1,
          cause: 'stub_probe_passed',
          origin_phase: 'S7',
          origin_step: '7.2',
          pack_sha256: '7'.repeat(64),
        }
      : null,
  patch:
    gate === 'X2' ? { patch_hash: '9'.repeat(64), source: 'push_receipt', bound: false } : null,
  dependencies:
    gate === 'X3'
      ? [{ name: 'libphonenumber-js', manifest: 'package.json', licence: null, advisories: null }]
      : [],
  constitution:
    gate === 'E2'
      ? {
          sha256: '8'.repeat(64),
          intact: true,
          markdown: '# Constitution check\n\nC-EGRESS: violation',
        }
      : null,
  handoff: null,
  data_class: 'D1',
  principal_names: { alice: 'Alice Admin', bob: 'Bob Builder', carol: 'Carol Customer' },
  ...over,
});

export const prepared = (gate: string, stepUp = false) => ({
  card_id: CARD,
  gates: [
    {
      gate_instance_id: `g-${gate}`,
      gate,
      nonce: `nonce-${gate}`,
      expires_at: '2026-11-12T11:00:00.000Z',
      subject_hash: SUBJECT,
      evidence_hash: 'e'.repeat(64),
      step_up: { required: stepUp, bound_hash: SUBJECT },
    },
  ],
});

export const decided = (gate: string, decision = 'approve') => ({
  card_id: CARD,
  status: 'decided',
  entries: [
    {
      ledger_seq: 42,
      entry_id: 'entry-1',
      entry_hash: '4'.repeat(64),
      entry_type: 'decision',
      gate_id: gate,
      decision,
      actor: 'alice',
      sod_waiver: false,
    },
  ],
});
