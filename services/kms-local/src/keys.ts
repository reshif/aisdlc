import { createHmac, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64urlDecode, b64urlEncode, type Jwk } from '@aisdlc/kernel';
import { es256PublicJwk, es256SignDigest } from '@aisdlc/ports';

export type KeyKind = 'es256' | 'hmac';

/** The keys kms-local holds. Anything else is unknown. */
export const KEY_REGISTRY: Readonly<Record<string, KeyKind>> = {
  'dev:notary': 'es256',
  'dev:witness': 'es256',
  'dev:bff-stepup': 'es256',
  // The kill switch signs its own journal (PLAN M9.6, AR9): a key core and the Notary cannot use.
  'dev:killswitch': 'es256',
  // The eval store's manifest signer (PLAN M11.3): used only by the eval tooling, never by a service an agent can reach.
  'dev:eval-store': 'es256',
  'dev:fingerprint-hmac': 'hmac',
};

/** Which caller may use which key (RV §2). A caller not listed here may use none. */
export const DEFAULT_KEY_ALLOW_LIST: Readonly<Record<string, readonly string[]>> = {
  notary: ['dev:notary'],
  witness: ['dev:witness'],
  knowledge: ['dev:fingerprint-hmac'],
  // The bff signs step-up proofs (PLAN M4.5); verifiers need only the public key, which is open.
  bff: ['dev:bff-stepup'],
  killswitch: ['dev:killswitch'],
  // The eval tooling signs the eval store's manifest (PLAN M11.3); no other caller may use the key.
  evals: ['dev:eval-store'],
};

export class KeyStoreError extends Error {
  override readonly name = 'KeyStoreError';
}

function fileFor(dir: string, keyId: string): string {
  if (!(keyId in KEY_REGISTRY)) throw new KeyStoreError(`unknown key id ${keyId}`);
  return join(dir, `${keyId.replace(':', '_')}.key.json`);
}

/** A key as held in memory. The private parts stay inside this module's closures. */
export interface HeldKey {
  kind: KeyKind;
  publicJwk?: Jwk;
  sign?: (digest: Uint8Array) => Uint8Array;
  hmac?: (data: Uint8Array) => string;
}

function hold(keyId: string, kind: KeyKind, material: Record<string, string>): HeldKey {
  if (kind === 'es256') {
    const d = b64urlDecode(material['d'] ?? '');
    if (d.length !== 32) throw new KeyStoreError(`key ${keyId} is not a P-256 private key`);
    return {
      kind,
      publicJwk: es256PublicJwk(d, keyId),
      sign: (digest) => es256SignDigest(d, digest),
    };
  }
  const k = Buffer.from(b64urlDecode(material['k'] ?? ''));
  if (k.length < 32) throw new KeyStoreError(`key ${keyId} is shorter than 32 bytes`);
  return { kind, hmac: (data) => createHmac('sha256', k).update(data).digest('hex') };
}

function generate(kind: KeyKind): Record<string, string> {
  if (kind === 'hmac') return { kty: 'oct', k: b64urlEncode(randomBytes(32)) };
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', d: jwk.d as string, x: pub.x as string, y: pub.y as string };
}

/**
 * Loads every registered key from `dir`, creating missing ones on first start with file mode
 * 0600 in a 0700 directory. A key file readable by group or others is refused: the volume has
 * been tampered with or mounted wrongly, and signing from it would be unsafe.
 */
export function loadOrCreateKeys(dir: string): Map<string, HeldKey> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = new Map<string, HeldKey>();
  for (const [keyId, kind] of Object.entries(KEY_REGISTRY)) {
    const path = fileFor(dir, keyId);
    try {
      // 'wx': never overwrite an existing key, and a concurrent first start cannot clobber it.
      writeFileSync(path, JSON.stringify(generate(kind)), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      throw new KeyStoreError(
        `key file ${path} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)})`,
      );
    }
    out.set(
      keyId,
      hold(keyId, kind, JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>),
    );
  }
  return out;
}
