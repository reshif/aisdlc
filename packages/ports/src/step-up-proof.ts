import { createHash } from 'node:crypto';
import {
  STEP_UP_TOKEN_PREFIX,
  StepUpClaims,
  type PrincipalId,
  type StepUpMethod,
} from '@aisdlc/contracts';
import {
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  err,
  ok,
  verifyEs256,
  type Jwk,
  type Result,
} from '@aisdlc/kernel';

// The wire form of a step-up proof (PLAN M4.5), shared by every verifier: core's `SignedStepUp`
// (through `@aisdlc/bff/stepup`) and the kill switch, which may import nothing of the bff (AR9).
// `su1.<base64url canonical claims>.<base64url ES256 signature>`; the signature is over the UTF-8
// bytes of `su1.<base64url canonical claims>`, hashed with SHA-256. Only the bff can sign (its
// kms-local key `dev:bff-stepup`); anyone holding the public key can check. Single use is NOT
// checked here: each verifier keeps its own ledger of used `proof_id`s.

export const stepUpSigningInput = (claims: StepUpClaims): string =>
  `${STEP_UP_TOKEN_PREFIX}.${b64urlEncode(new TextEncoder().encode(canonicalJson(claims)))}`;

export const stepUpDigest = (input: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(input).digest());

export const encodeStepUpToken = (claims: StepUpClaims, signature: Uint8Array): string =>
  `${stepUpSigningInput(claims)}.${b64urlEncode(signature)}`;

export interface DecodedStepUpToken {
  readonly claims: StepUpClaims;
  readonly signingInput: string;
  readonly signature: string;
}

/** Parses the three parts and the claims; `null` for anything that is not a well-formed proof. */
export function decodeStepUpToken(token: string): DecodedStepUpToken | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== STEP_UP_TOKEN_PREFIX) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1] as string))) as unknown;
    const claims = StepUpClaims.safeParse(raw);
    if (!claims.success) return null;
    return {
      claims: claims.data,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2] as string,
    };
  } catch {
    return null;
  }
}

export interface StepUpCheck {
  /** The hash the proof must be bound to. */
  readonly bound_hash: string;
  /** The principal the proof must be for. */
  readonly principal: PrincipalId | string;
  readonly now: Date;
  /** Accepted methods; `reconfirm` (DEC-11(c-ii)) only where that decision was made. */
  readonly allowedMethods: readonly StepUpMethod[];
  /** Clock skew tolerated for `issued_at` in the future, in seconds. */
  readonly skewSeconds: number;
}

/**
 * Every check of a step-up proof except single use: well-formed, signed by `key`, unexpired, not from
 * the future, an accepted method, for exactly this principal and hash. `Ok` carries the claims (the
 * caller then consumes `proof_id` in its own ledger). Every failure, including a throw, is a refusal.
 */
export async function checkStepUpProof(
  proof: string,
  key: Jwk,
  c: StepUpCheck,
): Promise<Result<StepUpClaims, string>> {
  try {
    const t = decodeStepUpToken(proof);
    if (!t) return err('step-up proof is malformed');
    const good = await verifyEs256(key, new TextEncoder().encode(t.signingInput), t.signature);
    if (!good) return err('step-up proof signature is invalid');
    const claims = t.claims;
    if (Date.parse(claims.expires_at) <= c.now.getTime()) return err('step-up proof has expired');
    if (Date.parse(claims.issued_at) > c.now.getTime() + c.skewSeconds * 1000) {
      return err('step-up proof is from the future');
    }
    if (!c.allowedMethods.includes(claims.method)) {
      return err(`step-up method ${claims.method} is not accepted here`);
    }
    if (claims.principal !== c.principal) return err('step-up proof is for another principal');
    if (claims.bound_hash !== c.bound_hash) return err('step-up proof is bound to another hash');
    return ok(claims);
  } catch (e) {
    return err(`step-up verification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
