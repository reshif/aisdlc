import { taggedError, type TaggedError } from '@aisdlc/kernel';

export type KnowledgeErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  /** The acting principal is unknown, not active, or not a human. */
  | 'principal_refused'
  /** The state change names no decided, ledgered security-card decision for this finding and state. */
  | 'decision_refused'
  | 'unavailable'
  | 'database';

export const KnowledgeError = taggedError('KnowledgeError');
export type KnowledgeError = TaggedError<
  'KnowledgeError',
  { code: KnowledgeErrorCode; message: string }
>;
export const knowledgeError = (code: KnowledgeErrorCode, message: string): KnowledgeError =>
  KnowledgeError({ code, message });

export const KNOWLEDGE_STATUS: Record<KnowledgeErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  principal_refused: 403,
  decision_refused: 403,
  unavailable: 503,
  database: 500,
};
