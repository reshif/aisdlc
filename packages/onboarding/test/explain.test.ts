import { describe, expect, it } from 'vitest';
import { explainS0, type ExplainInput } from '../src/index.js';

const base: ExplainInput = {
  status: 'in_progress',
  requested_level: 'light',
  census_ready: true,
  census_blockers_open: [],
  open_secret_findings: 0,
  cards: [],
  controls_blocking_open: [],
  floors: null,
  probe: null,
  signoff: null,
  proposal_ready: true,
} as never;

const by = (r: ReturnType<typeof explainS0>, id: string) => r.blockers.find((b) => b.id === id);

describe('explainS0: the owner’s three stuck scenarios', () => {
  it('a tier the role map cannot sign: a feasibility blocker owned by you, which C5 waits behind', () => {
    const r = explainS0({
      ...base,
      cards: [{ card: 'C5', status: 'open', live: true }],
      signoff: {
        state: 'infeasible',
        tier: 'T2',
        slot: 'm4',
        required: null,
        eligible: 1,
        reason: 'M4: T2 needs two approvers and allows no waiver (slot m4, 1 holder(s))',
      },
    });
    const m4 = by(r, 'm4_infeasible');
    expect(m4?.owner).toBe('you');
    expect(m4?.why).toMatch(/only ever goes up/);
    expect(by(r, 'card:C5')?.blocked_by).toContain('m4_infeasible');
    expect(r.ready).toBe(false);
  });

  it('no test command: the probe blocker is yours, names the Makefile route, and the floor is not its own blocker', () => {
    const r = explainS0({
      ...base,
      probe: { outcome: 'no_test_command', detail: null },
      floors: {
        met: false,
        floors: [{ floor: 'LF3', state: 'unmet', reasons: ['no_test_command'] }],
      },
    });
    const p = by(r, 'probe');
    expect(p?.code).toBe('no_test_command');
    expect(p?.owner).toBe('you');
    expect(p?.next).toMatch(/Makefile/);
    expect(r.blockers.some((b) => b.id === 'floor:LF3')).toBe(false);
  });

  it('b1_blocked is explained by the open secret finding, whose owner is security', () => {
    const r = explainS0({
      ...base,
      open_secret_findings: 2,
      cards: [{ card: 'SECR', status: 'open', live: true, finding_id: 'f1' }],
      probe: { outcome: 'b1_blocked', detail: null },
    });
    expect(by(r, 'secret_findings')?.owner).toBe('security');
    const p = by(r, 'probe');
    expect(p?.code).toBe('b1_blocked');
    expect(p?.blocked_by).toEqual(['secret_findings']);
    expect(p?.owner).toBe('security');
  });
});

describe('explainS0: the fix pull request', () => {
  it('awaiting approval: a card blocker with its card; an open one: the person merges on GitHub; a refused one: yours', () => {
    const r = explainS0({
      ...base,
      requested_level: 'census',
      fixes: [
        {
          title: 'Add code owners',
          state: 'awaiting_approval',
          approval: { card_id: 'c-x2', status: 'pending' },
        },
        { title: 'Add AGENTS.md', state: 'pr_open', approval: null },
        { title: 'Add ruleset', state: 'refused', approval: null },
      ],
    });
    expect(by(r, 'fix:0')).toMatchObject({ kind: 'card', owner: 'you', card_id: 'c-x2' });
    expect(by(r, 'fix:1')).toMatchObject({ owner: 'github', code: 'fix_pr_open' });
    expect(by(r, 'fix:2')).toMatchObject({ owner: 'you', code: 'fix_pr_refused' });
    expect(r.ready).toBe(false);
  });

  it('a card blocker carries its card id', () => {
    const r = explainS0({
      ...base,
      requested_level: 'census',
      cards: [{ card: 'C1', status: 'open', live: true, card_id: 'c-1' }],
    });
    expect(by(r, 'card:C1')?.card_id).toBe('c-1');
  });
});

describe('explainS0: shape', () => {
  it('a probe that has not run waits behind an open finding', () => {
    const r = explainS0({ ...base, open_secret_findings: 1 });
    expect(by(r, 'probe')?.blocked_by).toEqual(['secret_findings']);
  });

  it('unknown findings are a blocker, never fine', () => {
    expect(by(explainS0({ ...base, open_secret_findings: null }), 'secret_findings')?.code).toBe(
      'findings_unknown',
    );
  });

  it('a census level has no probe or floors', () => {
    const r = explainS0({ ...base, requested_level: 'census' });
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('open GitHub controls are github’s move and C5 waits behind them', () => {
    const r = explainS0({
      ...base,
      requested_level: 'census',
      controls_blocking_open: ['protect_main'],
      cards: [{ card: 'C5', status: 'open', live: true }],
    });
    expect(by(r, 'control:protect_main')?.owner).toBe('github');
    expect(by(r, 'card:C5')?.blocked_by).toContain('control:protect_main');
  });

  it('only cards left: ready', () => {
    const r = explainS0({
      ...base,
      requested_level: 'census',
      cards: [{ card: 'C1', status: 'open', live: true }],
    });
    expect(r.ready).toBe(true);
    expect(r.blockers.map((b) => b.id)).toEqual(['card:C1']);
  });

  it('a closed record has no blockers', () => {
    const r = explainS0({ ...base, status: 'done', open_secret_findings: 3 });
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(false);
  });

  it('every blocked_by names a blocker that exists', () => {
    const r = explainS0({
      ...base,
      open_secret_findings: 1,
      probe: { outcome: 'b1_blocked', detail: null },
      controls_blocking_open: ['x'],
      cards: [
        { card: 'C1', status: 'open', live: true },
        { card: 'C5', status: 'open', live: true },
      ],
    });
    const ids = new Set(r.blockers.map((b) => b.id));
    for (const b of r.blockers) for (const x of b.blocked_by) expect(ids.has(x)).toBe(true);
  });
});
