import { z } from 'zod';
import { IsoDateTime, PrincipalId, Sha256Hex } from './ids.js';

// Step-up (PLAN M4.5; D37, DEC-11(c)): a fresh strong authentication of a principal, bound to a
// hash so a proof for one thing cannot confirm another. The bff issues a proof, a `StepUpPort`
// verifies it (`@aisdlc/bff/stepup`); the decision kernel only sees `verify(proof, hash, principal)`.

/**
 * `reauth`: the principal signed in again at the identity provider (`prompt=login`, `max_age=0`)
 * and `auth_time` is that sign-in. `reconfirm`: DEC-11(c-ii), a plain confirm in the browser
 * session with no new authentication; `auth_time` is then the time of the confirm, and every
 * consumer can see from `method` that it is the weaker form.
 */
export const StepUpMethod = z.enum(['reauth', 'reconfirm']);
export type StepUpMethod = z.infer<typeof StepUpMethod>;
export const StepUpMethodValues: readonly StepUpMethod[] = StepUpMethod.options;

/** A proof lives this long (D37: short-lived), and is good for one decision. */
export const STEP_UP_TTL_SECONDS = 300;
/** The kms-local key that signs proofs (only the bff may sign; anyone may verify). */
export const STEP_UP_KEY_ID = 'dev:bff-stepup';
export const STEP_UP_TOKEN_PREFIX = 'su1';

/** What a proof says; the proof is `su1.<base64url canonical claims>.<base64url ES256 signature>`. */
export const StepUpClaims = z.strictObject({
  v: z.literal(1),
  /** Unique per proof; the single-use ledger keys on it. */
  proof_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  principal: PrincipalId,
  /** `subject_hash` or `text_sha256` the caller supplied; a decision verifies against its own. */
  bound_hash: Sha256Hex,
  method: StepUpMethod,
  /** When the principal last authenticated (reauth) or confirmed (reconfirm). */
  auth_time: IsoDateTime,
  issued_at: IsoDateTime,
  expires_at: IsoDateTime,
});
export type StepUpClaims = z.infer<typeof StepUpClaims>;

/** The stamp written next to a weaker-than-D37 proof, so a reader never mistakes it for a re-auth. */
export const STEP_UP_RECONFIRM_STAMP = 'dec-11c-ii:plain_confirm';
