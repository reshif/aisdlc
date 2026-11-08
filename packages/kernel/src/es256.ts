/** base64url without padding (RFC 4648 §5). */
export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function b64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new RangeError('not base64url');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** A public EC key as a JSON Web Key (RFC 7517). */
export interface Jwk {
  kty?: string | undefined;
  crv?: string | undefined;
  x?: string | undefined;
  y?: string | undefined;
  kid?: string | undefined;
  alg?: string | undefined;
  use?: string | undefined;
}

/**
 * Verifies a raw ES256 signature (r||s, 64 bytes) over `message` with WebCrypto and the JWK alone.
 * WebCrypto hashes `message` with SHA-256 itself, so the signer must have signed sha256(message).
 * Returns false for any failure, including a malformed key or signature (fail closed).
 */
export async function verifyEs256(
  jwk: Jwk,
  message: Uint8Array,
  signatureB64url: string,
): Promise<boolean> {
  try {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return false;
    const sig = b64urlDecode(signatureB64url);
    if (sig.length !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig as Uint8Array<ArrayBuffer>,
      message as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return false;
  }
}
