import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import {
  ServiceConfigError,
  resolveSecretRef,
  secretRefVersion,
  type SecretRefDeps,
} from '@aisdlc/service-kit';

function parseKey(ref: string, pem: string): KeyObject {
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
  return key;
}

/**
 * The GitHub App private key (RV §2 "Code-host credential custody": this service alone holds it).
 *
 * It is read from a file named by a `file:` reference, or from Vault by a `vault:` reference (portal v2: the owner
 * pastes it in the portal), never from an environment variable, parsed, and kept in a `#private` field as a
 * `KeyObject`. The only thing it can do is sign (RS256); there is no getter, no export, and `JSON.stringify`,
 * `String` and `util.inspect` all print a redaction. Error messages are fixed text and never include the key.
 *
 * A `vault:` key is read lazily: a stack starts before the owner has pasted it, so a missing key is a refusal of the
 * signature (the token mint fails, the integration reads unhealthy), not a refusal to start; and a new version in
 * Vault is picked up at the next signature (the process's reference cache is refreshed on a timer).
 */
export class AppKey {
  #key: KeyObject | null;
  #version: number | null | undefined;
  readonly #ref: string;

  private constructor(ref: string, key: KeyObject | null) {
    this.#ref = ref;
    this.#key = key;
    this.#version = secretRefVersion(ref);
  }

  /** `ref` is `file:/path/to/key.pem` or `vault:<path>#<key>` (PKCS#1 or PKCS#8 PEM, RSA, at least 2048 bits). */
  static fromRef(ref: string, deps: SecretRefDeps = {}): AppKey {
    if (ref.startsWith('vault:')) return new AppKey(ref, null);
    if (!ref.startsWith('file:')) {
      throw new ServiceConfigError('the GitHub App key must be a vault: or file: reference');
    }
    return new AppKey(ref, parseKey(ref, resolveSecretRef(ref, deps)));
  }

  /** The key, re-read from the reference cache when its Vault version changed. Throws a fixed-text error. */
  #current(): KeyObject {
    if (this.#ref.startsWith('vault:')) {
      const v = secretRefVersion(this.#ref);
      if (this.#key === null || v !== this.#version) {
        this.#version = v;
        this.#key = null;
        if (v === null || v === undefined) {
          throw new ServiceConfigError(`the GitHub App key ${this.#ref} is not set in Vault`);
        }
        this.#key = parseKey(this.#ref, resolveSecretRef(this.#ref));
      }
    }
    if (this.#key === null)
      throw new ServiceConfigError(`the GitHub App key ${this.#ref} is not set`);
    return this.#key;
  }

  /** An RS256 (RSASSA-PKCS1-v1_5, SHA-256) signature, as a Buffer. */
  signRs256(data: string): Buffer {
    return sign('RSA-SHA256', Buffer.from(data), this.#current());
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
