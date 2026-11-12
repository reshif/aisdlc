import type { ItemListRow } from '@aisdlc/contracts';
import type { Call } from './helpers';

// Fixtures of the screens built 2026-11-12 (home, items, quality, operate, govern, admin).

export const T = '2026-11-12T10:00:00.000Z';
export const ITEM_A = 'aaaa1111-0000-7000-8000-00000000000a';
export const ITEM_B = 'bbbb2222-0000-7000-8000-00000000000b';
export const ITEM_C = 'cccc3333-0000-7000-8000-00000000000c';

export const itemRow = (over: Record<string, unknown> = {}): ItemListRow =>
  ({
    item_id: ITEM_A,
    project_id: 'testbed',
    repo: 'reshif/asf-factory-testbed',
    lane: 'L3',
    proposed_lane: 'L3',
    phase: 'S2',
    underlying: 'S2',
    terminal: null,
    holds: 0,
    in_flight: false,
    mine: false,
    catalogue_version: '1.3.0',
    created_at: T,
    updated_at: T,
    ...over,
  }) as ItemListRow;

/** `POST /api/me/decisions` that allows exactly these actions. */
export const allowOnly =
  (...actions: string[]) =>
  (c: Call) => ({
    json: {
      decisions: (
        (c.body as { queries?: Array<{ action: string; resource: unknown }> }).queries ?? []
      ).map((q) => ({
        ...q,
        allow: actions.includes(q.action),
        reasons: actions.includes(q.action) ? ['policy'] : ['no_policy_permits'],
      })),
    },
  });

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

export const agentRow = (over: Record<string, unknown> = {}) => ({
  agent_id: 'A1',
  name: 'triage',
  role: 'triage',
  note: null,
  steps: ['1.2', '1.3'],
  specialist_steps: [],
  contract_version: '1.1.0',
  output_schema_id: 'triage.v1',
  tools: [],
  data_class_max: 'D1',
  models: ['claude-sonnet-5-5'],
  prompt: { ref: 'a1_triage@1.0.0', sha256: SHA_A },
  ...over,
});

export const evalRun = (over: Record<string, unknown> = {}) => ({
  eval_run_id: '0193a1b2-0000-7000-8000-0000000000e1',
  suite_id: 'triage-core',
  project_tag: null,
  agent_id: 'A1',
  profile: 'default',
  prompt_ref: 'a1_triage@1.0.0',
  prompt_sha256: SHA_A,
  contract_version: '1.1.0',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  harness_version: '1',
  trigger: 'manual',
  git_sha: null,
  manifest_digest: SHA_B,
  k: 3,
  cases: 4,
  trials: 12,
  passes: 11,
  pass_rate: 11 / 12,
  cost_micro_usd: 0,
  errored: 0,
  started_at: T,
  ended_at: T,
  ...over,
});

export const tile = (over: Record<string, unknown> = {}) => ({
  integration_id: 'github',
  kind: 'code_host',
  adapter: 'github_app',
  display_name: 'GitHub',
  status: 'enabled',
  state: 'ok',
  detail_code: null,
  as_of: T,
  stale: false,
  reporters: [],
  installs: 2,
  ...over,
});

export const grant = (over: Record<string, unknown> = {}) => ({
  grant_id: 'g-1',
  item_id: ITEM_A,
  unit_id: `${ITEM_A}:main`,
  project_id: 'testbed',
  lease_epoch: 2,
  slot: {},
  envelope: {},
  status: 'active',
  release_cause: null,
  granted_at: T,
  released_at: null,
  snapshot_ref: null,
  clock: { paused_ms: 0, paused_since: null },
  resumes_grant_id: null,
  ...over,
});

export const ledgerEntry = (seq: number, prev: string | null, hash: string) => ({
  ledger_seq: seq,
  entry_id: `e-${seq}`,
  entry_type: 'gate.decision',
  gate_id: 'G0',
  gate_instance_id: null,
  step: null,
  card_id: null,
  subject_kind: null,
  subject_id: null,
  decision: 'approve',
  actor: 'alice',
  sod_waiver: false,
  created_at: T,
  entry_hash: hash,
  prev_hash: prev,
});
