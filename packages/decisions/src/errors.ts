import { taggedError, type TaggedError } from '@aisdlc/kernel';
import type { LedgerWriteError } from '@aisdlc/ledger';

export type DecisionErrorCode =
  | 'invalid_input'
  | 'gate_not_found'
  | 'gate_not_pending'
  | 'gate_expired'
  | 'not_allowed'
  // M3.2 policy
  | 'not_eligible'
  | 'own_request'
  | 'already_voted'
  | 'quorum_infeasible'
  | 'policy_changed'
  | 'eligibility_unavailable'
  // M3.3 prepared decision
  | 'nonce_unknown'
  | 'nonce_replayed'
  | 'nonce_expired'
  | 'nonce_principal_mismatch'
  | 'subject_superseded'
  | 'evidence_not_viewed'
  | 'evidence_mismatch'
  | 'step_up_required'
  | 'step_up_invalid'
  // MM-2
  | 'maintenance'
  // infrastructure
  | 'conflict'
  | 'ledger'
  | 'database';

/** A refusal. Every error is a refusal, never an approval (AGENTS.md: fail closed). */
export const DecisionError = taggedError('DecisionError');
export type DecisionError = TaggedError<
  'DecisionError',
  { code: DecisionErrorCode; message: string; ledger?: LedgerWriteError }
>;

export const decisionError = (
  code: DecisionErrorCode,
  message: string,
  ledger?: LedgerWriteError,
): DecisionError => DecisionError({ code, message, ...(ledger ? { ledger } : {}) });
