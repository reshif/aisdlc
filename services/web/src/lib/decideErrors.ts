import { ApiError } from '../api';

// What went wrong with a decision, in words a person can act on. The decision kernel's codes come
// through as the start of the message (`nonce_replayed: ...`), the bff's and core's refusals as the
// status. Nothing here ever decides anything: every one of these means "nothing was decided".

export type DecideProblemKind =
  | 'stale' // what you were shown has changed: reload
  | 'expired' // the form's nonce is spent or too old: it is renewed, check and decide again
  | 'closed' // the card is no longer open
  | 'forbidden'
  | 'step_up'
  | 'refused' // a rule of the card: the message says which
  | 'session'
  | 'other';

export interface DecideProblem {
  readonly kind: DecideProblemKind;
  readonly text: string;
  /** Nothing was decided, whatever the kind. */
  readonly reload: boolean;
}

const has = (m: string, ...needles: string[]): boolean => needles.some((n) => m.includes(n));

export function explainDecideError(e: unknown): DecideProblem {
  if (!(e instanceof ApiError)) {
    return { kind: 'other', text: 'Something went wrong. Nothing was decided.', reload: false };
  }
  const m = e.message;
  if (e.status === 0) {
    return {
      kind: 'other',
      text: 'The factory could not be reached. Nothing was decided; try again in a moment.',
      reload: false,
    };
  }
  if (e.status === 401) {
    return {
      kind: 'session',
      text: 'Your session has ended. Sign in again; nothing was decided.',
      reload: false,
    };
  }
  if (e.status === 403) {
    return {
      kind: 'forbidden',
      text: has(m, 'not_eligible', 'nonce_principal_mismatch')
        ? 'You do not hold the role that decides this card, so you cannot decide it. Nothing was decided.'
        : 'You are not allowed to decide this card. Only the people who hold its role may. Nothing was decided.',
      reload: false,
    };
  }
  if (has(m, 'step_up_required', 'step_up_invalid')) {
    return {
      kind: 'step_up',
      text: 'Your identity confirmation is missing, used up or not for this record. Confirm your identity again, then decide. Nothing was decided.',
      reload: false,
    };
  }
  if (has(m, 'nonce_replayed', 'nonce_expired', 'nonce_unknown', 'evidence_not_viewed')) {
    return {
      kind: 'expired',
      text: 'This decision form was used or has timed out. It has been renewed: look over the card once more and decide again. Nothing was decided.',
      reload: false,
    };
  }
  if (
    has(m, 'evidence_mismatch', 'subject_superseded', 'changed since', 'moved on', 'is stale') ||
    has(m, 'no longer waits', 'is gone')
  ) {
    return {
      kind: 'stale',
      text: 'What you were shown has changed since you opened this page, so your decision was refused. Reload the page to see the current version. Nothing was decided.',
      reload: true,
    };
  }
  if (has(m, 'not open', 'gate_not_pending', 'gate_expired', 'already_voted')) {
    return {
      kind: 'closed',
      text: 'This card is no longer open: it was decided, closed or replaced. Reload the page to see where it stands. Nothing was decided now.',
      reload: true,
    };
  }
  if (e.status === 409) {
    return {
      kind: 'stale',
      text: `The record changed under you (${m}). Reload the page and look again. Nothing was decided.`,
      reload: true,
    };
  }
  if (e.status === 422 || e.status === 400) {
    return {
      kind: 'refused',
      text: `The decision was not accepted: ${m.replace(/^[a-z_]+: /, '')}. Nothing was decided.`,
      reload: false,
    };
  }
  if (e.status >= 500) {
    return {
      kind: 'other',
      text: 'The factory could not take the decision just now. Nothing was decided; try again in a moment.',
      reload: false,
    };
  }
  return { kind: 'other', text: `${m}. Nothing was decided.`, reload: false };
}
