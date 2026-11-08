import { sha256Hex } from '@aisdlc/kernel';

/** The factory-only canary prefix. Built from parts so this file never holds a canary-shaped string. */
const CANARY_PREFIX = ['AISDLC', 'CANARY', ''].join('_');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A deterministic factory canary (`AISDLC_CANARY_` + 24 characters of `[A-Z0-9]`) for tests, derived
 * from `seed`. A canary is never a real-provider format (OB §7): it exists to be found and to be
 * grepped for in outputs that must not hold a value.
 */
export function makeCanary(seed: string): string {
  const digest = sha256Hex(`aisdlc-canary:${seed}`);
  let out = '';
  for (let i = 0; i < 24; i++) {
    out += ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % ALPHABET.length];
  }
  return CANARY_PREFIX + out;
}
