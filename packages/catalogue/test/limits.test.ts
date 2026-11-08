import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BackEdgeIdValues,
  GATES,
  HandoffIdValues,
  TRIGGER_DESCRIPTIONS,
  TriggerIdValues,
  type BackEdgeId,
} from '@aisdlc/contracts';
import {
  BACK_EDGE_LIMITS,
  CATALOGUE,
  ENVELOPE_EXTENSION,
  REWORK_BUDGET,
  TRIGGERS,
  type Limit,
} from '../src/index.js';

const mmd = readFileSync(
  fileURLToPath(new URL('../../../docs/specs/flow-corrected.mmd', import.meta.url)),
  'utf8',
);
const body = mmd
  .split('\n')
  .filter((l) => !l.trim().startsWith('%%'))
  .join('\n');

const limitsOf = (id: BackEdgeId): Limit[] => {
  const e = BACK_EDGE_LIMITS[id];
  return e.kind === 'limited' ? e.limits : [];
};
const value = (id: BackEdgeId, key: string): number | null | undefined =>
  limitsOf(id).find((l) => l.key === key)?.value;

describe('back-edge limits lint', () => {
  it('has an entry for every back-edge in contracts', () => {
    expect(Object.keys(BACK_EDGE_LIMITS).sort()).toEqual([...BackEdgeIdValues].sort());
    expect(Object.keys(CATALOGUE.back_edge_limits).sort()).toEqual([...BackEdgeIdValues].sort());
  });

  it('every entry is a number set, or an explicit unlimited / not_applicable with a reason', () => {
    for (const id of BackEdgeIdValues) {
      const e = BACK_EDGE_LIMITS[id];
      if (e.kind === 'limited') expect(e.limits.length, id).toBeGreaterThan(0);
      else expect(e.reason.length, id).toBeGreaterThan(10);
    }
  });

  it('names a real exit in every `then`', () => {
    for (const id of BackEdgeIdValues) {
      const e = BACK_EDGE_LIMITS[id];
      if (e.kind !== 'limited' || e.then === null) continue;
      const known =
        e.then in GATES ||
        (TriggerIdValues as readonly string[]).includes(e.then) ||
        (HandoffIdValues as readonly string[]).includes(e.then) ||
        ['Abandoned', 'Parked', 'human_writes_plan', 'suspend_mode_e', 'backup_approver'].includes(
          e.then,
        );
      expect(known, `${id} then ${e.then}`).toBe(true);
    }
  });

  /** Every number in a flow label is a limit value of that edge, and the other way round. */
  it('matches every number in the flow labels (read from the .mmd)', () => {
    const labelOf = (id: string): string => {
      const m = new RegExp(`"${id} ([^"]*)"`).exec(body);
      expect(m, `label of ${id}`).not.toBeNull();
      return m?.[1] ?? '';
    };
    const numbers = (text: string): number[] =>
      [
        ...text
          .replaceAll('<br/>', ' ')
          .replace(/\bET\d+\b/g, ' ')
          .replace(/\bB\d+[ab]?\b/g, ' ')
          .replace(/\b[DEXML]\d\b/g, ' ')
          .replace(/\bG\d\w*\b/g, ' ')
          .replace(/\bS\d\b/g, ' ')
          .matchAll(/\d+/g),
      ].map((m) => Number(m[0]));
    const labelIds: Record<BackEdgeId, string[]> = Object.fromEntries(
      BackEdgeIdValues.map((id) => [id, [id]]),
    ) as Record<BackEdgeId, string[]>;
    labelIds.B15 = ['B15a', 'B15b'];
    for (const id of BackEdgeIdValues) {
      if (id === 'B28') continue; // drawn in the rework-budget node, checked below
      const fromFlow = new Set(labelIds[id].flatMap((l) => numbers(labelOf(l))));
      const fromData = new Set(
        limitsOf(id)
          .map((l) => l.value)
          .filter((v): v is number => v !== null),
      );
      expect(
        [...fromData].sort((a, b) => a - b),
        id,
      ).toEqual([...fromFlow].sort((a, b) => a - b));
    }
  });

  it('carries the numbers of the flow', () => {
    expect(value('B1', 'rounds')).toBe(2);
    expect(value('B1', 'park')).toBe(5);
    expect(value('B2', 'times')).toBe(2);
    expect(value('B3', 'auto_rounds')).toBe(3);
    expect(BACK_EDGE_LIMITS.B3).toMatchObject({ then: 'ET8' });
    expect(value('B4', 'times')).toBe(1);
    expect(value('B5', 'rejections')).toBe(2);
    expect(value('B7', 'et3_rounds')).toBe(3);
    expect(value('B7', 'et2_ci_rounds')).toBe(5);
    expect(value('B7', 'et2_time_multiple')).toBe(2);
    expect(value('B8', 'times')).toBe(1);
    expect(value('B10', 'times')).toBe(1);
    expect(value('B11', 'times')).toBe(1);
    expect(value('B12', 'times')).toBe(1);
    expect(value('B13', 'et7_rounds')).toBe(2);
    expect(BACK_EDGE_LIMITS.B13).toMatchObject({ then: 'D3' });
    expect(value('B15', 'b15a_times')).toBe(2);
    expect(value('B19', 'miss_rate')).toBe(10);
    expect(value('B19', 'min_sample')).toBe(20);
    expect(value('B20', 'times')).toBe(1);
    expect(value('B21', 'gate_sla')).toBe(1);
    expect(value('B23', 'rounds')).toBe(2);
    expect(value('B24', 'rounds')).toBe(2);
    expect(value('B25', 'times')).toBe(1);
    expect(BACK_EDGE_LIMITS.B2).toMatchObject({ then: 'E4' });
    expect(BACK_EDGE_LIMITS.B5).toMatchObject({ then: 'human_writes_plan' });
    expect(BACK_EDGE_LIMITS.B8).toMatchObject({ then: 'D1' });
    expect(BACK_EDGE_LIMITS.B10).toMatchObject({ then: 'D2' });
  });

  it('B9 names the ET3-ET6 limits and the flow gives no S7 numbers', () => {
    expect(limitsOf('B9').map((l) => l.key)).toEqual([
      'et3_rounds',
      'et4_limit',
      'et5_limit',
      'et6_limit',
    ]);
    expect(limitsOf('B9').every((l) => l.value === null)).toBe(true);
  });

  it('edges that spawn a NEW item or end the item are not_applicable; B6, B14, B26 are unlimited', () => {
    for (const id of ['B16', 'B17', 'B18', 'B22', 'B27'] as const) {
      expect(BACK_EDGE_LIMITS[id].kind, id).toBe('not_applicable');
    }
    for (const id of ['B6', 'B14', 'B26'] as const)
      expect(BACK_EDGE_LIMITS[id].kind, id).toBe('unlimited');
  });

  it('marks (tune) exactly where the flow does: the rework budget', () => {
    expect(body.match(/\(tune\)/g)).toHaveLength(2);
    const rb = /RB\["([^"]*)"\]/.exec(body)?.[1] ?? '';
    expect(rb.match(/\(tune\)/g)).toHaveLength(2);
    const tuned: string[] = [];
    for (const id of BackEdgeIdValues)
      for (const l of limitsOf(id)) if (l.tune) tuned.push(`${id}.${l.key}`);
    expect(tuned.sort()).toEqual(['B28.item_age', 'B28.total']);
    expect(REWORK_BUDGET.total).toMatchObject({ value: 5, unit: 'count', tune: true });
    expect(REWORK_BUDGET.item_age).toMatchObject({ value: 10, unit: 'business_days', tune: true });
    expect(rb).toContain('5 (tune)');
    expect(rb).toContain('10 bd (tune)');
  });

  it('rework budget counts B2-B26, ends at E4 and counts toward ET14', () => {
    expect(REWORK_BUDGET.counted_edges[0]).toBe('B2');
    expect(REWORK_BUDGET.counted_edges.at(-1)).toBe('B26');
    expect(REWORK_BUDGET.counted_edges).toHaveLength(25);
    expect(REWORK_BUDGET.counted_edges).not.toContain('B1');
    expect(REWORK_BUDGET.counted_edges).not.toContain('B27');
    expect(REWORK_BUDGET.then).toBe('E4');
    expect(REWORK_BUDGET.counts_toward).toBe('ET14');
    expect(BACK_EDGE_LIMITS.B28).toMatchObject({ then: 'E4' });
  });

  it('envelope extension is one extension of at most +50%', () => {
    expect(ENVELOPE_EXTENSION.max_extensions.value).toBe(1);
    expect(ENVELOPE_EXTENSION.max_percent.value).toBe(50);
    expect(ENVELOPE_EXTENSION.via).toBe('E3');
  });
});

describe('ET table', () => {
  it('has a row for every trigger', () => {
    expect(Object.keys(TRIGGERS).sort()).toEqual([...TriggerIdValues].sort());
  });

  it('sends triggers where the flow draws them', () => {
    const handoffs = (id: (typeof TriggerIdValues)[number]) =>
      TRIGGERS[id].effects.flatMap((e) => (e.kind === 'handoff' ? [e.handoff] : []));
    for (const id of ['ET1', 'ET2', 'ET8', 'ET9', 'ET11', 'ET12'] as const)
      expect(handoffs(id), id).toEqual(['D1']);
    expect(handoffs('ET3')).toEqual(['D1', 'D2']);
    for (const id of ['ET4', 'ET5', 'ET6'] as const) expect(handoffs(id), id).toEqual(['D2']);
    expect(handoffs('ET7')).toEqual(['D3']);
    expect(TRIGGERS.ET10.effects).toEqual([{ kind: 'quarantine', gate: 'Q1' }]);
    expect(TRIGGERS.ET13.effects).toEqual([{ kind: 'new_item', lanes: ['L0', 'L1'] }]);
    expect(TRIGGERS.ET14.effects).toEqual([{ kind: 'circuit_breaker', relane: 'R3' }]);
    expect(TRIGGERS.ET14.counts_from).toEqual(['Q1', 'E4_abandon', 'E4_takeover', 'rework_budget']);
  });

  it('carries the thresholds the flow words give, and null where it gives none', () => {
    const t = (id: (typeof TriggerIdValues)[number], key: string) =>
      TRIGGERS[id].thresholds.find((x) => x.key === key)?.value;
    expect(t('ET1', 'budget')).toBe(100);
    expect(t('ET2', 'ci_rounds')).toBe(5);
    expect(t('ET2', 'time_multiple')).toBe(2);
    expect(t('ET3', 'rounds')).toBe(3);
    expect(t('ET7', 'rejection_rounds')).toBe(2);
    expect(t('ET9', 'scope_drift')).toBe(2);
    for (const id of ['ET4', 'ET5', 'ET6'] as const) expect(t(id, 'limit')).toBeNull();
    // A trigger the flow describes with words has a description in contracts; ET4-ET6 have none.
    for (const id of ['ET4', 'ET5', 'ET6'] as const) expect(TRIGGER_DESCRIPTIONS[id]).toBeNull();
  });
});
