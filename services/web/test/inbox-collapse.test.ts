import type { PortalInboxItem } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { collapseOnboarding, inboxHref, inboxVerb, inboxWhat } from '../src/work/words';

const row = (over: Partial<PortalInboxItem>): PortalInboxItem =>
  ({
    kind: 'onboarding_card',
    id: 'c1',
    project_id: 'acme',
    s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54',
    label: 'C1',
    slot: 'admin',
    opened_at: '2026-11-13T10:00:00.000Z',
    sla_due_at: '2026-11-14T10:00:00.000Z',
    overdue: false,
    escalated: false,
    holders: [],
    item_id: null,
    gate: null,
    card_id: 'c1',
    feasibility: 'feasible',
    feasibility_reason: null,
    may_decide: false,
    deciders: [],
    ...over,
  }) as PortalInboxItem;

describe('an onboarding is one inbox row', () => {
  it('its cards collapse to one row that opens the console; the worst feasibility and any overdue show', () => {
    const rows = collapseOnboarding([
      row({ id: 'c1' }),
      row({ id: 'c2', label: 'C4', overdue: true, feasibility: 'infeasible', may_decide: true }),
      row({ kind: 'settings_revision', id: 'g1', s0_id: null, label: null }),
    ]);
    expect(rows).toHaveLength(2);
    const o = rows[0];
    expect(o?.onboarding?.count).toBe(2);
    expect(o?.overdue).toBe(true);
    expect(o?.feasibility).toBe('infeasible');
    expect(inboxHref(o as never)).toBe('/onboard/01a1bc26-f0e5-719a-a52b-a88a4b6cbe54');
    expect(inboxWhat(o as never)).toBe('Onboarding of acme (2 approvals)');
    expect(inboxVerb(o as never)).toBe('Open');
    // the others are untouched
    expect(rows[1]?.kind).toBe('settings_revision');
  });

  it('a card with no onboarding record stays its own row', () => {
    const rows = collapseOnboarding([row({ s0_id: null })]);
    expect(rows[0]?.onboarding).toBeUndefined();
  });
});
