import { describe, expect, it } from 'vitest';
import {
  CoverageItem,
  FINDING_TRANSITIONS,
  FindingMachine,
  KnowledgeJobMachine,
  SetFindingStateRequest,
  b1Blocked,
  b2Reasons,
  findingStream,
  kjobStream,
} from '../../src/index.js';

const ok = { truncated: false, cap_reached: false, refs_covered: 'all' as const };

describe('knowledge contracts', () => {
  it('finding states move only open -> rotated | false_positive | accepted_test_fixture', () => {
    for (const to of ['rotated', 'false_positive', 'accepted_test_fixture'] as const) {
      expect(FindingMachine.canTransition('open', to)).toBe(true);
      expect(FindingMachine.canTransition(to, 'open')).toBe(false);
    }
    expect(FindingMachine.canTransition('rotated', 'false_positive')).toBe(false);
    expect(FindingMachine.canTransition('open', 'open')).toBe(false);
    expect([...FindingMachine.terminals].sort()).toEqual(
      ['accepted_test_fixture', 'false_positive', 'rotated'].sort(),
    );
    expect(Object.keys(FINDING_TRANSITIONS)).toHaveLength(4);
  });

  it('jobs run queued -> running -> done | error and nothing leaves done or error', () => {
    expect(KnowledgeJobMachine.canTransition('queued', 'running')).toBe(true);
    expect(KnowledgeJobMachine.canTransition('queued', 'done')).toBe(false);
    expect(KnowledgeJobMachine.canTransition('running', 'done')).toBe(true);
    expect(KnowledgeJobMachine.canTransition('running', 'error')).toBe(true);
    expect(KnowledgeJobMachine.canTransition('done', 'error')).toBe(false);
    expect(KnowledgeJobMachine.canTransition('error', 'running')).toBe(false);
  });

  it('a state change names a human principal, a non-open state and a reason', () => {
    const good = { state: 'rotated', principal_id: 'alice', reason: 'rotated in the console' };
    expect(SetFindingStateRequest.safeParse(good).success).toBe(true);
    expect(SetFindingStateRequest.safeParse({ ...good, state: 'open' }).success).toBe(false);
    expect(SetFindingStateRequest.safeParse({ ...good, reason: '' }).success).toBe(false);
    expect(SetFindingStateRequest.safeParse({ state: 'rotated', reason: 'x' }).success).toBe(false);
  });

  it('a coverage item names a kind, where it is and why', () => {
    const item = { kind: 'lfs_pointer', path: 'a.bin', object: 'a'.repeat(40), reason: 'x' };
    expect(CoverageItem.safeParse(item).success).toBe(true);
    expect(CoverageItem.safeParse({ ...item, kind: 'skipped' }).success).toBe(false);
    expect(CoverageItem.safeParse({ ...item, reason: '' }).success).toBe(false);
  });

  it('B2 is met only by a complete scan of all refs; every shortfall is a reason', () => {
    expect(b2Reasons({ scan_status: 'ok', scan_coverage: ok })).toEqual([]);
    expect(b2Reasons({ scan_status: 'error', scan_coverage: ok })).toEqual(['scan_error']);
    expect(
      b2Reasons({
        scan_status: 'ok',
        scan_coverage: { ...ok, cap_reached: true, truncated: true },
      }),
    ).toEqual(['cap_reached', 'truncated']);
    expect(
      b2Reasons({ scan_status: 'ok', scan_coverage: { ...ok, refs_covered: 'default_only' } }),
    ).toEqual(['refs_default_only']);
  });

  it('B1 is blocked by any open finding and by nothing else', () => {
    expect(b1Blocked({ open: 1 })).toBe(true);
    expect(b1Blocked({ open: 0 })).toBe(false);
  });

  it('streams are kjob:<id> and finding:<id>', () => {
    expect(kjobStream('x')).toBe('kjob:x');
    expect(findingStream('y')).toBe('finding:y');
  });
});
