import { EvalSignedManifest, type EvalManifest } from '@aisdlc/contracts';
import {
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  err,
  ok,
  sha256Hex,
  verifyEs256,
  type Result,
} from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { storeError, type EvalStoreError } from './errors.js';
import { jwkOf, type PinnedKey } from './pinned.js';

// The signed manifest: ES256 over sha256 of the manifest's canonical JSON (RFC 8785). The signer is
// key custody (`dev:eval-store` in kms-local); the verifier has only the public key pinned in the repo.

const bytes = (m: EvalManifest): Uint8Array => new TextEncoder().encode(canonicalJson(m));

/** The digest a run records as `manifest_digest`: what the store was when the run read it. */
export const manifestDigest = (m: EvalManifest): string => sha256Hex(canonicalJson(m));

export async function signManifest(
  manifest: EvalManifest,
  custody: KeyCustodyPort,
): Promise<Result<EvalSignedManifest, EvalStoreError>> {
  const digest = new Uint8Array(Buffer.from(manifestDigest(manifest), 'hex'));
  let sig;
  try {
    sig = await custody.sign(manifest.key_id, digest);
  } catch {
    return err(storeError('custody', 'key custody could not be reached'));
  }
  if (!sig.ok) return err(storeError('custody', `key custody refused: ${sig.error.kind}`));
  return ok({
    manifest,
    signature: { alg: 'ES256', kid: manifest.key_id, value: b64urlEncode(sig.value) },
  });
}

/** Checks the shape, the key id against the pin and the signature with the pinned key alone. */
export async function verifyManifest(
  raw: unknown,
  pinned: PinnedKey,
): Promise<Result<EvalSignedManifest, EvalStoreError>> {
  const p = EvalSignedManifest.safeParse(raw);
  if (!p.success) return err(storeError('unsigned', 'manifest.json is not a signed manifest'));
  const s = p.data;
  if (s.signature.kid !== pinned.key_id || s.manifest.key_id !== pinned.key_id) {
    return err(storeError('bad_signature', 'the manifest is signed with a key that is not pinned'));
  }
  // a malformed signature is a bad signature, not a crash
  try {
    b64urlDecode(s.signature.value);
  } catch {
    return err(storeError('bad_signature', 'the signature is malformed'));
  }
  const good = await verifyEs256(jwkOf(pinned), bytes(s.manifest), s.signature.value);
  return good ? ok(s) : err(storeError('bad_signature', 'the manifest signature does not verify'));
}
