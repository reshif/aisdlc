import { createHmac, createHash } from 'node:crypto';
import { err, ok, taggedError, type Jwk, type Result, type TaggedError } from '@aisdlc/kernel';
import { deriveEs256SecretKey, es256PublicJwk, es256SignDigest } from './es256.js';

export type KeyCustodyErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'unknown_key'
  /** A `dev:` key id outside `FACTORY_ENV=local`. */
  | 'dev_key_refused'
  | 'wrong_key_type'
  | 'invalid_request'
  | 'unavailable';

export const KeyCustodyError = taggedError('KeyCustodyError');
export type KeyCustodyError = TaggedError<
  'KeyCustodyError',
  { kind: KeyCustodyErrorKind; message: string }
>;

export const keyCustodyError = (kind: KeyCustodyErrorKind, message: string): KeyCustodyError =>
  KeyCustodyError({ kind, message });

/**
 * Key custody: the only way anything signs or MACs (PLAN §2 "Signing"). `kms-local` is the local
 * implementation, AWS KMS the cloud one. Private keys and the HMAC key never cross this port.
 * Every method can fail; callers treat an error as a refusal.
 */
export interface KeyCustodyPort {
  /** The public key of an ES256 key. */
  publicKey(keyId: string): Promise<Result<Jwk, KeyCustodyError>>;
  /** Raw ES256 signature (r||s, 64 bytes) over a 32-byte digest. */
  sign(keyId: string, digest32: Uint8Array): Promise<Result<Uint8Array, KeyCustodyError>>;
  /** HMAC-SHA-256 of `data` as lowercase hex. */
  hmac(keyId: string, data: Uint8Array): Promise<Result<string, KeyCustodyError>>;
}

export interface FakeKeyCustodyOptions {
  /** Makes every key derive from this seed. Default `"fake"`. */
  seed?: string;
  /** ES256 key ids. Default `dev:notary`, `dev:witness`. */
  es256?: readonly string[];
  /** HMAC key ids. Default `dev:fingerprint-hmac`. */
  hmac?: readonly string[];
}

/**
 * In-process, deterministic key custody for tests of other packages: same seed, same keys, same
 * signatures. Unknown ids are refused. It does not model callers or `FACTORY_ENV`.
 */
export function fakeKeyCustody(opts: FakeKeyCustodyOptions = {}): KeyCustodyPort {
  const seed = opts.seed ?? 'fake';
  const es = new Map(
    (opts.es256 ?? ['dev:notary', 'dev:witness']).map((id) => [
      id,
      deriveEs256SecretKey(`${seed}:${id}`),
    ]),
  );
  const mac = new Map(
    (opts.hmac ?? ['dev:fingerprint-hmac']).map((id) => [
      id,
      createHash('sha256').update(`aisdlc-fake-hmac:${seed}:${id}`).digest(),
    ]),
  );
  return {
    async publicKey(keyId) {
      const k = es.get(keyId);
      return k ? ok(es256PublicJwk(k, keyId)) : err(keyCustodyError('unknown_key', keyId));
    },
    async sign(keyId, digest32) {
      const k = es.get(keyId);
      if (!k) {
        return err(keyCustodyError(mac.has(keyId) ? 'wrong_key_type' : 'unknown_key', keyId));
      }
      if (digest32.length !== 32)
        return err(keyCustodyError('invalid_request', 'digest must be 32 bytes'));
      return ok(es256SignDigest(k, digest32));
    },
    async hmac(keyId, data) {
      const k = mac.get(keyId);
      if (!k) {
        return err(keyCustodyError(es.has(keyId) ? 'wrong_key_type' : 'unknown_key', keyId));
      }
      return ok(createHmac('sha256', k).update(data).digest('hex'));
    },
  };
}
