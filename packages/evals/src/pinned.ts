import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { storeError, type EvalStoreError } from './errors.js';

// The pinned public key (DM §5.1 `eval_store.pub.json`): the ONE key a store's manifest may verify
// with. It is a file of the repo, so changing the signer is a reviewed change to the repo and not
// something a store can do for itself. `aisdlc-evals pin` rewrites it from key custody.

export const PINNED_KEY_FORMAT = 'aisdlc-eval-store-pub/v1';

export const PinnedKey = z.strictObject({
  format: z.literal(PINNED_KEY_FORMAT),
  key_id: z.string().min(1),
  jwk: z.looseObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1),
  }),
});
export type PinnedKey = z.infer<typeof PinnedKey>;

export const PINNED_KEY_PATH = fileURLToPath(new URL('../eval_store.pub.json', import.meta.url));

export function loadPinnedKey(path: string = PINNED_KEY_PATH): Result<PinnedKey, EvalStoreError> {
  try {
    const p = PinnedKey.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return p.success
      ? ok(p.data)
      : err(storeError('bad_key', 'the pinned public key is malformed'));
  } catch {
    return err(storeError('bad_key', 'the pinned public key cannot be read'));
  }
}

export const jwkOf = (k: PinnedKey): Jwk => k.jwk as Jwk;
