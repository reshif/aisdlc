import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { ServiceConfigError, resolveSecretRef, type SecretRefDeps } from '@aisdlc/service-kit';

/**
 * The GitHub App private key (RV §2 "Code-host credential custody": this service alone holds it).
 *
 * It is read from a file named by a `file:` reference, never from an environment variable, parsed
 * once, and kept in a `#private` field as a `KeyObject`. The only thing it can do is sign (RS256);
 * there is no getter, no export, and `JSON.stringify`, `String` and `util.inspect` all print a
 * redaction. Error messages are fixed text and never include the file contents.
 */
export class AppKey {
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /** `ref` must be `file:/path/to/key.pem` (PKCS#1 or PKCS#8 PEM, RSA, at least 2048 bits). */
  static fromRef(ref: string, deps: SecretRefDeps = {}): AppKey {
    if (!ref.startsWith('file:')) {
      throw new ServiceConfigError('the GitHub App key must be a file: reference');
    }
    const pem = resolveSecretRef(ref, deps);
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw new ServiceConfigError(`${ref} is not a readable private key`);
    }
    if (key.asymmetricKeyType !== 'rsa') {
      throw new ServiceConfigError(`${ref} is not an RSA private key`);
    }
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new ServiceConfigError(`${ref} is an RSA key shorter than 2048 bits`);
    }
    return new AppKey(key);
  }

  /** An RS256 (RSASSA-PKCS1-v1_5, SHA-256) signature, as a Buffer. */
  signRs256(data: string): Buffer {
    return sign('RSA-SHA256', Buffer.from(data), this.#key);
  }

  toJSON(): string {
    return '[redacted GitHub App key]';
  }

  toString(): string {
    return '[redacted GitHub App key]';
  }

  [inspect.custom](): string {
    return '[redacted GitHub App key]';
  }
}

/** A short-lived secret (an installation token): the same redaction, and one way to read it. */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret, for the one place that puts it in an `Authorization` header. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return '[redacted]';
  }
}
