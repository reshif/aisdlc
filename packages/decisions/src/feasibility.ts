import {
  gatePolicy,
  type GateFeasibility,
  type SignoffFeasibility,
  type Tier,
  type TwoPerson,
  type GateOpenedPayload,
  type PrincipalId,
} from '@aisdlc/contracts';
import { barredOf, planQuorum } from './policy.js';
import { gateHolders, type EligibilityPort } from './ports.js';

// GateFeasibility (PLAN M19, DM §3.7 and §3.10): can a waiting gate still be decided by the people eligible NOW? The
// same rules the vote applies (`gateHolders` narrows the slot's holders to the gate's deciders, `planQuorum` applies
// the SoD and two-person rules), against the quorum frozen when the gate opened, less the approvals already on the
// ledger. A read for the floor and the inbox: it decides nothing and opens nothing. Fail closed: when identity cannot
// be asked the answer is `unknown`, which they flag exactly like `infeasible`.

/**
 * The feasibility of one open gate. `approvers` are the distinct approvers already on the ledger (`readGateState`).
 * Never throws for a port failure: that is `unknown`.
 */
export async function gateFeasibility(
  eligibility: EligibilityPort,
  opened: GateOpenedPayload,
  approvers: readonly PrincipalId[],
): Promise<GateFeasibility> {
  const slot = opened.quorum.slot;
  const needed = Math.max(0, opened.quorum.required - new Set(approvers).size);
  const base = { gate_instance_id: opened.gate_instance_id, gate: opened.gate_id, slot, needed };
  const unknown = (why: string): GateFeasibility => ({
    ...base,
    state: 'unknown',
    eligible: null,
    reason: why,
  });
  let holders: readonly PrincipalId[];
  let ctx;
  try {
    const h = await gateHolders(eligibility, opened.project_id, slot, opened.deciders);
    if (!h.ok) return unknown(`who holds ${slot} is unknown: ${h.error.message}`);
    holders = h.value;
    const c = await eligibility.policy(opened.project_id);
    if (!c.ok) return unknown(`the project's policy is unknown: ${c.error.message}`);
    ctx = c.value;
  } catch (e) {
    return unknown(`identity could not be asked: ${e instanceof Error ? e.message : String(e)}`);
  }
  const authors = opened.authors ?? [];
  const plan = planQuorum(opened.gate_id, ctx, holders, opened.requester, authors);
  if (!plan.ok) {
    return { ...base, state: 'infeasible', eligible: 0, reason: plan.error.message };
  }
  // The sole holder who is the requester decides by the waiver; otherwise the SoD rule bars them.
  const barred =
    gatePolicy(opened.gate_id).own_request === 'blocked' && plan.value.basis !== 'own_item'
      ? barredOf(opened.requester, authors)
      : [];
  const voted = new Set(approvers);
  const eligible = [...new Set(holders)].filter((p) => !barred.includes(p) && !voted.has(p)).length;
  if (eligible < needed) {
    return {
      ...base,
      state: 'infeasible',
      eligible,
      reason: `${needed} more approval(s) needed and ${eligible} eligible ${slot} holder(s) left`,
    };
  }
  return { ...base, state: 'feasible', eligible, reason: null };
}

/**
 * Can the onboarding signer gate (M4) be decided at `tier` by `holders` of its slot, for this requester? The same
 * `planQuorum` the gate applies when it opens, asked BEFORE it opens (card 1's tier choice and card 4's role map
 * fix who would decide it). Pure.
 */
export function signoffFeasibility(i: {
  readonly tier: Tier;
  readonly twoPerson: TwoPerson;
  readonly holders: readonly PrincipalId[];
  readonly requester: PrincipalId | null;
}): SignoffFeasibility {
  const slot = gatePolicy('M4').slot;
  const holders = [...new Set(i.holders)];
  const plan = planQuorum('M4', { tier: i.tier, two_person: i.twoPerson }, holders, i.requester);
  const others = holders.filter((h) => !barredOf(i.requester, []).includes(h)).length;
  if (!plan.ok) {
    return {
      state: 'infeasible',
      tier: i.tier,
      slot,
      required: null,
      eligible: others,
      reason: plan.error.message,
    };
  }
  return {
    state: 'feasible',
    tier: i.tier,
    slot,
    required: plan.value.required,
    eligible: plan.value.basis === 'own_item' ? holders.length : others,
    reason: null,
  };
}
