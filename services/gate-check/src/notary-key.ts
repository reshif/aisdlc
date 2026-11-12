import type { Jwk } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import type { NotaryKeyPort } from './checker.js';

// The Notary's PUBLIC key, which gate-check checks every Evidence Pack signature with (PLAN M14.5: the pack is verified
// here, offline, never taken on core's word). From key custody (a public-key read: this caller may use no key), or a
// pinned public JWK. A key that cannot be had is `null`: no pass is given meanwhile, and it is asked again next time.

export const NOTARY_KEY_ID = 'dev:notary';

export class StaticNotaryKey implements NotaryKeyPort {
  constructor(private readonly key: Jwk | null) {}
  async get(): Promise<Jwk | null> {
    return this.key;
  }
}

export class CustodyNotaryKey implements NotaryKeyPort {
  private key: Jwk | null = null;

  constructor(
    private readonly custody: Pick<KeyCustodyPort, 'publicKey'>,
    private readonly keyId: string = NOTARY_KEY_ID,
  ) {}

  async get(): Promise<Jwk | null> {
    if (this.key) return this.key;
    try {
      const r = await this.custody.publicKey(this.keyId);
      if (!r.ok) return null;
      if ('d' in r.value) return null; // never a private key
      this.key = r.value;
      return this.key;
    } catch {
      return null;
    }
  }
}

/** A public JWK read from a file (pinned), refusing anything that carries a private part. */
export function parsePublicJwk(text: string): Jwk {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (
    j['kty'] !== 'EC' ||
    j['crv'] !== 'P-256' ||
    typeof j['x'] !== 'string' ||
    typeof j['y'] !== 'string'
  ) {
    throw new Error('the Notary key is not a P-256 EC public JWK');
  }
  if ('d' in j)
    throw new Error('the Notary key file holds a private key: give the public JWK only');
  return j as Jwk;
}
