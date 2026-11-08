import { RECORD_GENESIS_HASH } from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';

export const GENESIS_HASH: string = RECORD_GENESIS_HASH;

/** The fields the event hash covers (names as in the table). `global_seq` is not hashed. */
export interface EventHashInput {
  stream: string;
  seq: number;
  event_id: string;
  type: string;
  body: Record<string, unknown>;
  actor: string;
  /** ISO 8601 UTC with milliseconds, as `Date.prototype.toISOString` writes it. */
  occurred_at: string;
  prev_hash: string;
}

/** sha256 of the canonical JSON (RFC 8785) of the hash input. */
export function computeEventHash(input: EventHashInput): string {
  const { stream, seq, event_id, type, body, actor, occurred_at, prev_hash } = input;
  return hashCanonical({ stream, seq, event_id, type, body, actor, occurred_at, prev_hash });
}
