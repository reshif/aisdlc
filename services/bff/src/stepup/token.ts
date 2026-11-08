import { createHash } from 'node:crypto';
import { STEP_UP_TOKEN_PREFIX, StepUpClaims } from '@aisdlc/contracts';
import { b64urlDecode, b64urlEncode, canonicalJson } from '@aisdlc/kernel';

// The wire form of a proof: `su1.<base64url canonical claims>.<base64url ES256 signature>`. The
// signature is over the UTF-8 bytes of `su1.<base64url canonical claims>`, hashed with SHA-256.

export const signingInput = (claims: StepUpClaims): string =>
  `${STEP_UP_TOKEN_PREFIX}.${b64urlEncode(new TextEncoder().encode(canonicalJson(claims)))}`;

export const digestOf = (input: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(input).digest());

export const encodeToken = (claims: StepUpClaims, signature: Uint8Array): string =>
  `${signingInput(claims)}.${b64urlEncode(signature)}`;

export interface DecodedToken {
  readonly claims: StepUpClaims;
  readonly signingInput: string;
  readonly signature: string;
}

/** Parses the three parts and the claims; `null` for anything that is not a well-formed proof. */
export function decodeToken(token: string): DecodedToken | null {
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
