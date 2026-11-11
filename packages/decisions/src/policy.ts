import {
  gatePolicy,
  type PolicyKey,
  type PrincipalId,
  type QuorumBasis,
  type RoleSlot,
  type Tier,
  type TwoPerson,
  type VoteDecision,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';

// Quorum, separation of duties and the two-person rules (PLAN M3.2; OB §1B; DEC-6, DEC-27, DEC-28).
// Pure functions of their arguments: no clock, no database, no ports. The tables in
// `test/policy.test.ts` are the executable form of the rules below.
//
// The rules
//  - Which slot decides a gate, and whether it is a two-person gate, comes from `GATE_POLICIES`.
//  - Two-person gates (X1, X2, E2, M4, kill release) need two distinct approvers when the project's
//    setting is on. T2 locks the setting on.
//  - A slot with exactly one holder decides alone; so does a project with the setting off (never
//    T2). Relying on either is stamped `sod_waiver`.
//  - The requester cannot decide their own request, unless they are the sole holder of the slot
//    (stamped `sod_waiver`, never T2). The author of what a gate decides (B5: the person who wrote the
//    plan by hand) is treated exactly like the requester. Gates whose policy says `own_request: allowed` (G6, the
//    requester's own acceptance) have no such rule.
//  - T2: no waiver of any kind, so a T2 two-person gate with one holder is infeasible.
//  - Any eligible voter's reject or request_changes ends the gate; one approve is a vote.

/** What the project says about itself; from the `ProjectPolicyPort`. */
export interface PolicyContext {
  readonly tier: Tier | null;
  readonly two_person: TwoPerson;
}

/** T2 is by tier, or by the settings document having locked two-person on. Unknown tier is not T2. */
export const isT2 = (c: PolicyContext): boolean => c.tier === 'T2' || c.two_person.locked_on;

export interface QuorumPlan {
  readonly slot: RoleSlot;
  readonly required: number;
  readonly basis: QuorumBasis;
  /** The quorum rests on a waiver, so a decision that relies on it is stamped `sod_waiver`. */
  readonly waiver: boolean;
}

export type PolicyRefusalCode =
  'not_eligible' | 'own_request' | 'already_voted' | 'quorum_infeasible' | 'policy_changed';

export interface PolicyRefusal {
  readonly code: PolicyRefusalCode;
  readonly message: string;
}
const refuse = (code: PolicyRefusalCode, message: string): PolicyRefusal => ({ code, message });

/** The requester and the authors: the people who may not decide the gate (unless the sole holder). */
export const barredOf = (
  requester: PrincipalId | null,
  authors: readonly PrincipalId[],
): PrincipalId[] => [...new Set([...(requester === null ? [] : [requester]), ...authors])];

const unique = (xs: readonly PrincipalId[]): PrincipalId[] => [...new Set(xs)];

/**
 * How many distinct approvals decide this gate for the given holders. `Err` (`quorum_infeasible`)
 * means the gate could never be decided as configured, so it must not be opened and a vote on it is
 * refused: nobody holds the slot, or T2 requires two people and fewer than two can approve.
 */
export function planQuorum(
  key: PolicyKey,
  ctx: PolicyContext,
  holdersIn: readonly PrincipalId[],
  requester: PrincipalId | null,
  /** Authors of the decided artefact: barred like the requester (B5 plan author). */
  authors: readonly PrincipalId[] = [],
): Result<QuorumPlan, PolicyRefusal> {
  const policy = gatePolicy(key);
  const holders = unique(holdersIn);
  const slot = policy.slot;
  const t2 = isT2(ctx);
  const infeasible = (why: string) =>
    err(refuse('quorum_infeasible', `${key}: ${why} (slot ${slot}, ${holders.length} holder(s))`));
  if (holders.length === 0) return infeasible('nobody holds the slot');

  const barred = policy.own_request === 'blocked' ? barredOf(requester, authors) : [];
  const requesterHolds = holders.some((h) => barred.includes(h));
  const others = holders.filter((h) => !barred.includes(h));

  // The sole holder is the requester: only the single-holder waiver lets them decide.
  if (requesterHolds && others.length === 0) {
    // Only the SINGLE-holder waiver exists: several holders who are all barred (requester and plan author) cannot decide.
    if (holders.length > 1) return infeasible('every holder is the requester or the author');
    if (t2) return infeasible('T2 allows no waiver, and the only holder is the requester');
    return ok({ slot, required: 1, basis: 'own_item', waiver: true });
  }

  if (policy.two_person === 'never') {
    return ok({ slot, required: 1, basis: 'single', waiver: false });
  }
  if (t2) {
    if (others.length < 2) return infeasible('T2 needs two approvers and allows no waiver');
    return ok({ slot, required: 2, basis: 'two_person', waiver: false });
  }
  if (!ctx.two_person.enabled)
    return ok({ slot, required: 1, basis: 'two_person_off', waiver: true });
  if (holders.length === 1) return ok({ slot, required: 1, basis: 'single_holder', waiver: true });
  if (others.length < 2) return infeasible('two-person needs two approvers besides the requester');
  return ok({ slot, required: 2, basis: 'two_person', waiver: false });
}

export interface VoteInput {
  readonly key: PolicyKey;
  readonly ctx: PolicyContext;
  /** The current holders of the deciding slot (from the `EligibilityPort`). */
  readonly holders: readonly PrincipalId[];
  readonly requester: PrincipalId | null;
  /** Authors of the decided artefact (B5 plan author): barred like the requester. */
  readonly authors?: readonly PrincipalId[];
  readonly voter: PrincipalId;
  readonly decision: VoteDecision;
  /** Distinct approvers already on the ledger for this instance. */
  readonly approvers: readonly PrincipalId[];
  /** The quorum frozen when the gate was opened. */
  readonly frozenQuorum: number;
}

export interface VoteVerdict {
  /** `decided` when this vote ends the gate: any reject or request_changes, or the approval that reaches quorum. */
  readonly outcome: 'pending' | 'decided';
  readonly sod_waiver: boolean;
  readonly approvals_after: number;
  readonly required: number;
}

/**
 * Decides whether `voter` may cast `decision` now and what it does to the gate. A refusal writes
 * nothing. Order of checks: eligibility, own request, feasibility, drift of the policy since open,
 * repeat vote.
 */
export function evaluateVote(v: VoteInput): Result<VoteVerdict, PolicyRefusal> {
  const policy = gatePolicy(v.key);
  const holders = unique(v.holders);
  if (!holders.includes(v.voter)) {
    return err(refuse('not_eligible', `${v.voter} does not hold slot ${policy.slot}`));
  }
  const selfDecided =
    policy.own_request === 'blocked' && barredOf(v.requester, v.authors ?? []).includes(v.voter);

  const plan = planQuorum(v.key, v.ctx, holders, v.requester, v.authors ?? []);
  if (!plan.ok) {
    // The plan is infeasible; a requester voting on their own request gets the clearer refusal.
    return err(
      selfDecided && holders.length > 1
        ? refuse('own_request', `${v.voter} cannot decide their own request`)
        : plan.error,
    );
  }
  if (selfDecided && plan.value.basis !== 'own_item') {
    return err(refuse('own_request', `${v.voter} cannot decide their own request`));
  }
  if (plan.value.required > v.frozenQuorum) {
    return err(
      refuse(
        'policy_changed',
        `${v.key} now needs ${plan.value.required} approvals, the gate was opened for ${v.frozenQuorum}: reopen it`,
      ),
    );
  }

  const approvers = unique(v.approvers);
  if (v.decision !== 'approve') {
    return ok({
      outcome: 'decided',
      sod_waiver: selfDecided,
      approvals_after: approvers.length,
      required: v.frozenQuorum,
    });
  }
  if (approvers.includes(v.voter)) {
    return err(refuse('already_voted', `${v.voter} already approved; a repeat vote counts once`));
  }
  const after = approvers.length + 1;
  return ok({
    outcome: after >= v.frozenQuorum ? 'decided' : 'pending',
    // The waiver is stamped when this approval relies on it: the quorum was cut to one, or the
    // approver is the requester (basis own_item). Never reachable for T2 (planQuorum refuses).
    sod_waiver: plan.value.waiver && v.frozenQuorum === plan.value.required,
    approvals_after: after,
    required: v.frozenQuorum,
  });
}
