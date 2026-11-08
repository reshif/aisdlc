import { z } from 'zod';
import { defineMachine, type TransitionTable } from './machine.js';

/** GateInstance status (DM §6.2). */
export const GateStatus = z.enum(['pending', 'decided', 'superseded', 'expired', 'closed']);
export type GateStatus = z.infer<typeof GateStatus>;
export const GateStatusValues: readonly GateStatus[] = GateStatus.options;

/** The `decision` value of a ledger entry (`ledger_entry.schema.json`). Not a gate status. */
export const LedgerDecision = z.enum([
  'approve',
  'reject',
  'request_changes',
  'supersede',
  'expire',
  'withdraw',
]);
export type LedgerDecision = z.infer<typeof LedgerDecision>;
export const LedgerDecisionValues: readonly LedgerDecision[] = LedgerDecision.options;

/**
 * The gate status a ledger decision leaves behind. approve, reject and request_changes are all
 * quorum outcomes, so the instance is `decided`; the decision itself is on the ledger entry.
 * `closed` covers "item ended or withdrawn" (DM §6.2); `withdraw` is the decision that closes.
 * `expire` is written only by the sweep and never approves.
 */
export const DECISION_TO_STATUS: Readonly<Record<LedgerDecision, GateStatus>> = {
  approve: 'decided',
  reject: 'decided',
  request_changes: 'decided',
  supersede: 'superseded',
  expire: 'expired',
  withdraw: 'closed',
};

/** `pending -> pending` is a vote recorded without quorum. A decided instance is never touched. */
export const GATE_TRANSITIONS: TransitionTable<GateStatus> = {
  pending: ['pending', 'decided', 'superseded', 'expired', 'closed'],
  decided: [],
  superseded: [],
  expired: [],
  closed: [],
};

export const GateMachine = defineMachine('GateInstance', GATE_TRANSITIONS);
export const canTransitionGate = GateMachine.canTransition;
export const assertTransitionGate = GateMachine.assertTransition;
