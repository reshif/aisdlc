import { createHash } from 'node:crypto';
import { b64urlEncode, type Jwk } from '@aisdlc/kernel';
import { p256 } from '@noble/curves/nist.js';

// ES256 on a pre-hashed digest. A KMS signs a digest (AWS KMS: MessageType DIGEST), and Node's
// crypto cannot sign one with ECDSA, so the key holders use this. The signature is the raw
// 64-byte r||s that JWS ES256 and WebCrypto use, and it verifies with WebCrypto over the message
// whose sha256 is the digest.

export const DIGEST_BYTES = 32;

export function randomEs256SecretKey(): Uint8Array {
  return p256.utils.randomSecretKey();
}

/**
 * A fixed secret key derived from a seed string. For fakes and tests only: anyone with the seed
 * has the key.
 */
export function deriveEs256SecretKey(seed: string): Uint8Array {
  for (let i = 0; ; i++) {
    const candidate = createHash('sha256').update(`aisdlc-fake-key:${i}:${seed}`).digest();
    if (p256.utils.isValidSecretKey(candidate)) return new Uint8Array(candidate);
  }
}

export function es256PublicJwk(secretKey: Uint8Array, kid: string): Jwk {
  const pub = p256.getPublicKey(secretKey, false); // 0x04 || x || y
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    kid,
    alg: 'ES256',
    use: 'sig',
  };
}

/** Raw ES256 signature (r||s, 64 bytes) over a 32-byte digest. Deterministic (RFC 6979). */
export function es256SignDigest(secretKey: Uint8Array, digest: Uint8Array): Uint8Array {
  if (digest.length !== DIGEST_BYTES) {
    throw new RangeError(`digest must be ${DIGEST_BYTES} bytes, got ${digest.length}`);
  }
  return p256.sign(digest, secretKey, { prehash: false });
}
