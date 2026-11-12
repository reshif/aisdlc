import { GATE_CHECK_NAME, type BranchRules } from '@aisdlc/contracts';
import { readOk } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import { protectMain } from '../src/cards/controls.js';

// LF2's protect-main: the required check pinned to an App is the check run gate-check writes (`aisdlc/gate`), not a
// check named after the service, which no App ever writes.

const rules = (checks: BranchRules['required_checks']): BranchRules =>
  ({
    pull_request: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_review_thread_resolution: false,
    },
    required_checks: checks,
    blocks_force_push: true,
    blocks_deletion: true,
  }) as unknown as BranchRules;

describe('protect-main (LF2)', () => {
  it('is met with aisdlc/gate pinned to an App, and not with a check nobody writes', () => {
    expect(GATE_CHECK_NAME).toBe('aisdlc/gate');
    expect(
      protectMain(readOk(rules([{ context: 'aisdlc/gate', integration_id: 654321 }]))),
    ).toEqual({ status: 'met', reasons: [] });
    expect(
      protectMain(readOk(rules([{ context: 'gate-check', integration_id: 654321 }]))).reasons,
    ).toEqual(['gate_check_not_pinned']);
    expect(
      protectMain(readOk(rules([{ context: 'aisdlc/gate', integration_id: null }]))).reasons,
    ).toEqual(['gate_check_not_pinned']);
  });
});
