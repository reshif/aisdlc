import type { DecisionQuery } from '@aisdlc/contracts';
import type { Call } from './helpers';

// Shared fixtures of the Settings, Agents and Integrations screen tests: a config key view as the bff sends it.

export const GATE = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77';
export const REV = 'b'.repeat(64);
export const HEAD = 'c'.repeat(64);

export const CAPS_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'integer', minimum: 1, maximum: 32 },
    coding: { type: 'integer', minimum: 0, maximum: 8 },
  },
  required: ['total', 'coding'],
  additionalProperties: false,
};

export const summary = (key: string, schema: unknown = {}) => ({
  key,
  kind: 'setting',
  description: `the ${key} key`,
  overridable: false,
  json_schema: schema,
});

export const keyView = (
  key: string,
  schema: unknown,
  value: unknown,
  over: Record<string, unknown> = {},
) => ({
  key: summary(key, schema),
  default: value,
  effective: {
    value,
    source: 'default',
    rev_hash: null,
    gate_instance_id: null,
    ledger_entry_id: null,
    published_at: null,
  },
  head_rev_hash: null,
  pending: [],
  history: [],
  may_propose: true,
  may_apply_now: false,
  principal_names: { alice: 'Alice Admin', carol: 'Carol Approver' },
  ...over,
});

export const decide = (allow: (q: DecisionQuery) => boolean) => (c: Call) => ({
  json: {
    decisions: (c.body as { queries: DecisionQuery[] }).queries.map((q) => ({
      ...q,
      allow: allow(q),
      reasons: allow(q) ? ['role/factory.admin/config.propose'] : ['no_policy_permits'],
    })),
  },
});

export const preview = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  applies: 'now',
  valid: true,
  problems: [],
  changes: [{ path: 'coding', before: 1, after: 2 }],
  effects: ['Coding sandboxes at once: 1 → 2.'],
  items_in_progress: 0,
  ...over,
});

export const proposed = {
  rev_hash: REV,
  parent_rev_hash: null,
  gate_instance_id: GATE,
  superseded: [],
};
