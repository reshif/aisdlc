import { BackEdgeIdValues, type BackEdgeId, type TriggerId } from '@aisdlc/contracts';
import type {
  BackEdgeLimit,
  EnvelopeExtension,
  FlowLimits,
  Limit,
  LimitUnit,
  ReworkBudget,
  ThenTarget,
  TriggerDef,
} from './schema.js';
import type { z } from 'zod';

// Back-edge limits (FL B1-B28), the rework budget (FIX 14), the envelope extension (E4 -> E3) and
// the ET table. Every number is the flow's. `tune` is true only where the flow writes "(tune)".

const lim = (key: string, value: number | null, unit: LimitUnit, tune = false): Limit => ({
  key,
  value,
  unit,
  tune,
});

const limited = (
  limits: Limit[],
  then: ThenTarget | null,
  note: string | null = null,
): BackEdgeLimit => ({
  kind: 'limited',
  limits,
  then,
  note,
});

const unlimited = (reason: string): BackEdgeLimit => ({ kind: 'unlimited', reason });
const notApplicable = (reason: string): BackEdgeLimit => ({ kind: 'not_applicable', reason });

const NEW_ITEM = 'creates a NEW linked item; there is no loop on this item to limit';
const REWORK_ONLY =
  'the flow draws no limit of its own; the edge still counts toward the item rework budget (B28)';

export const BACK_EDGE_LIMITS: Readonly<Record<BackEdgeId, BackEdgeLimit>> = {
  B1: limited(
    [lim('rounds', 2, 'rounds'), lim('park', 5, 'business_days')],
    'Abandoned',
    '"missing info: ≤2 rounds, park 5 bd"; the PARKED 5 bd timeout goes to ABANDONED',
  ),
  B2: limited([lim('times', 2, 'times')], 'E4', '"intent ambiguous: G1 again, 2×, then E4"'),
  B3: limited(
    [lim('auto_rounds', 3, 'rounds')],
    'ET8',
    '"validator/critic fail: 3 auto, then ET8"',
  ),
  B4: limited(
    [lim('times', 1, 'times')],
    null,
    '"design reveals spec gap: 1×"; the flow names no exit',
  ),
  B5: limited(
    [lim('rejections', 2, 'count')],
    'human_writes_plan',
    '"plan changes requested: 2 rejections, then human writes plan"',
  ),
  B6: unlimited(
    'the flow draws no count; the wait ends when the env is fixed (BLOCKED -> 6.1). ' + REWORK_ONLY,
  ),
  B7: limited(
    [
      lim('et3_rounds', 3, 'rounds'),
      lim('et2_ci_rounds', 5, 'rounds'),
      lim('et2_time_multiple', 2, 'multiple'),
    ],
    'D1',
    '"ET3 3 rounds · ET2 5 CI rounds or 2× time"; "limits hit" goes to D1',
  ),
  B8: limited(
    [lim('times', 1, 'times')],
    'D1',
    '"scope tripwire, 1st: split Unit, G3 again"; the 2nd time goes to D1',
  ),
  B9: limited(
    [
      lim('et3_rounds', null, 'rounds'),
      lim('et4_limit', null, 'count'),
      lim('et5_limit', null, 'count'),
      lim('et6_limit', null, 'count'),
    ],
    'D2',
    '"ET3/ET4/ET5/ET6 limits": the flow names the limits and gives no S7 numbers; "B9-B12 limits hit" goes to D2',
  ),
  B10: limited(
    [lim('times', 1, 'times')],
    'D2',
    '"spec ambiguous: G2 portion again, 1×"; "B9-B12 limits hit" goes to D2',
  ),
  B11: limited(
    [lim('times', 1, 'times')],
    'D2',
    '"approach wrong: G3 again, 1×"; "B9-B12 limits hit" goes to D2',
  ),
  B12: limited(
    [lim('times', 1, 'times')],
    'D2',
    '"locked test must change, 1×"; "B9-B12 limits hit" goes to D2',
  ),
  B13: limited(
    [lim('et7_rounds', 2, 'rounds')],
    'D3',
    '"G4 changes requested: ET7 2 rounds"; ET7 goes to D3',
  ),
  B14: unlimited(
    '"mode-E approver unsure → mode C" is a switch of review mode, not a counted loop. ' +
      REWORK_ONLY,
  ),
  B15: limited(
    [lim('b15a_times', 2, 'times')],
    null,
    '"B15a base moved, clean rebase: S7 re-run, 2×"; B15b (merge conflict, resolve in S6) has no count',
  ),
  B16: notApplicable(NEW_ITEM + ' (rollback and a new L0/L1 item)'),
  B17: notApplicable(NEW_ITEM + ' (new L0/L1 item, ET13)'),
  B18: notApplicable(NEW_ITEM),
  B19: limited(
    [lim('miss_rate', 10, 'percent'), lim('min_sample', 20, 'sample_size')],
    'suspend_mode_e',
    '">10% over ≥20 sampled suspends mode E"; also creates a NEW item',
  ),
  B20: limited(
    [lim('times', 1, 'times')],
    null,
    '"requester amends scope, any active stage, 1×"; the flow names no exit',
  ),
  B21: limited(
    [lim('gate_sla', 1, 'business_days')],
    'backup_approver',
    '"any gate > 1 bd SLA → backup approver / manager"; NEVER auto-approve',
  ),
  B22: notApplicable('ends the item as DECLINED at G0; no loop'),
  B23: limited([lim('rounds', 2, 'rounds')], 'E4', '"spec rejected: 2 rounds, then E4"'),
  B24: limited([lim('rounds', 2, 'rounds')], 'E4', '"design rejected: 2 rounds, then E4"'),
  B25: limited([lim('times', 1, 'times')], 'E4', '"exception denied: redesign 1×, else E4"'),
  B26: unlimited(
    'the flow draws no count; RELEASE HELD waits for a re-request after the fix window or a NEW linked item. ' +
      REWORK_ONLY,
  ),
  B27: notApplicable('a flag on the G0 card (content fenced as data), not a loop'),
  B28: limited(
    [lim('total', 5, 'count', true), lim('item_age', 10, 'business_days', true)],
    'E4',
    'the rework budget; see `rework_budget`',
  ),
};

/** Back-edges B2-B26 each add 1 to the item's rework counter (FIX 14). */
const REWORK_FIRST: BackEdgeId = 'B2';
const REWORK_LAST: BackEdgeId = 'B26';

export const REWORK_BUDGET: ReworkBudget = {
  counted_edges: BackEdgeIdValues.slice(
    BackEdgeIdValues.indexOf(REWORK_FIRST),
    BackEdgeIdValues.indexOf(REWORK_LAST) + 1,
  ),
  total: lim('total', 5, 'count', true),
  item_age: lim('item_age', 10, 'business_days', true),
  then: 'E4',
  counts_toward: 'ET14',
  survives: ['relane', 'handoff'],
};

export const ENVELOPE_EXTENSION: z.infer<typeof EnvelopeExtension> = {
  max_extensions: lim('max_extensions', 1, 'times'),
  max_percent: lim('max_percent', 50, 'percent'),
  via: 'E3',
};

/** D4 "hand back once" (the E4 takeover is handed back at most once) and X3 "denied: find alternative, 1x, else D1". */
export const FLOW_LIMITS: z.infer<typeof FlowLimits> = {
  d4_hand_back: lim('times', 1, 'times'),
  x3_alternative: lim('times', 1, 'times'),
};

const unknownLimit = (key: string): Limit => lim(key, null, 'count');

/**
 * The ET table. Effects come from where the flow draws each trigger: D1 lists ET1, ET2, ET3, ET8,
 * ET9, ET11, ET12; D2 is "loop limits ET3-ET6 hit"; D3 is ET7; Q1 is ET10; R3 is ET14; B17 names
 * ET13 with "NEW L0/L1". ET3 appears at both D1 and D2. ET4-ET6, ET8 and ET10-ET12 have no
 * number in the flow; ET14's `trip` is set by catalogue 1.3.0 (see `catalogue.ts`).
 */
export const TRIGGERS: Readonly<Record<TriggerId, TriggerDef>> = {
  ET1: {
    effects: [{ kind: 'handoff', handoff: 'D1' }],
    thresholds: [lim('budget', 100, 'percent')],
    counts_from: [],
  },
  ET2: {
    effects: [{ kind: 'handoff', handoff: 'D1' }],
    thresholds: [lim('ci_rounds', 5, 'rounds'), lim('time_multiple', 2, 'multiple')],
    counts_from: [],
  },
  ET3: {
    effects: [
      { kind: 'handoff', handoff: 'D1' },
      { kind: 'handoff', handoff: 'D2' },
    ],
    thresholds: [lim('rounds', 3, 'rounds')],
    counts_from: [],
  },
  ET4: {
    effects: [{ kind: 'handoff', handoff: 'D2' }],
    thresholds: [unknownLimit('limit')],
    counts_from: [],
  },
  ET5: {
    effects: [{ kind: 'handoff', handoff: 'D2' }],
    thresholds: [unknownLimit('limit')],
    counts_from: [],
  },
  ET6: {
    effects: [{ kind: 'handoff', handoff: 'D2' }],
    thresholds: [unknownLimit('limit')],
    counts_from: [],
  },
  ET7: {
    effects: [{ kind: 'handoff', handoff: 'D3' }],
    thresholds: [lim('rejection_rounds', 2, 'rounds')],
    counts_from: [],
  },
  ET8: { effects: [{ kind: 'handoff', handoff: 'D1' }], thresholds: [], counts_from: [] },
  ET9: {
    effects: [{ kind: 'handoff', handoff: 'D1' }],
    thresholds: [lim('scope_drift', 2, 'times')],
    counts_from: [],
  },
  ET10: { effects: [{ kind: 'quarantine', gate: 'Q1' }], thresholds: [], counts_from: [] },
  ET11: { effects: [{ kind: 'handoff', handoff: 'D1' }], thresholds: [], counts_from: [] },
  ET12: { effects: [{ kind: 'handoff', handoff: 'D1' }], thresholds: [], counts_from: [] },
  ET13: { effects: [{ kind: 'new_item', lanes: ['L0', 'L1'] }], thresholds: [], counts_from: [] },
  ET14: {
    effects: [{ kind: 'circuit_breaker', relane: 'R3' }],
    // The flow draws R3 with no number. 1.3.0 gives it one, to be tuned: three counts since the last
    // human reset trip the breaker for a project and lane (the reset, an M5 decision, is the window).
    thresholds: [lim('trip', 3, 'count', true)],
    counts_from: ['Q1', 'E4_abandon', 'E4_takeover', 'rework_budget'],
  },
};
