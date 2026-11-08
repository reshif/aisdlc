import { createHash, randomBytes } from 'node:crypto';
import { err, ok, taggedError, type Result } from './result.js';

declare const brand: unique symbol;
declare const kind: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A UUID string (lowercase, canonical 8-4-4-4-12 form). */
export type Uuid = Brand<string, 'Uuid'>;
/** A UUID tagged with the kind of entity it identifies, e.g. `Id<'Project'>`. */
export type Id<K extends string> = Uuid & { readonly [kind]: K };

export const InvalidUuid = taggedError('InvalidUuid');
export type InvalidUuid = ReturnType<typeof InvalidUuid>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(input: string): Result<Uuid, InvalidUuid & { input: string }> {
  return UUID_RE.test(input) ? ok(input.toLowerCase() as Uuid) : err(InvalidUuid({ input }));
}

export function parseId<K extends string>(
  input: string,
): Result<Id<K>, InvalidUuid & { input: string }> {
  return parseUuid(input) as Result<Id<K>, InvalidUuid & { input: string }>;
}

/**
 * Builds a UUID v7 (RFC 9562) generator: 48-bit unix ms, 12-bit sequence in rand_a, 62 random
 * bits. Each generator is monotonic on its own: ids made in the same millisecond (or after the
 * clock steps back) still sort in generation order.
 */
export function uuidv7Generator(): (nowMs?: number) => Uuid {
  let lastMs = -1;
  let lastSeq = 0;
  return (nowMs = Date.now()) => {
    let ms = Math.max(Math.floor(nowMs), 0);
    if (ms <= lastMs) {
      ms = lastMs;
      lastSeq += 1;
      if (lastSeq > 0xfff) {
        ms += 1;
        lastSeq = 0;
      }
    } else {
      lastSeq = randomBytes(2).readUInt16BE(0) & 0x1ff; // leave headroom for increments
    }
    lastMs = ms;

    const b = randomBytes(16);
    b[0] = Math.floor(ms / 2 ** 40) & 0xff;
    b[1] = Math.floor(ms / 2 ** 32) & 0xff;
    b[2] = Math.floor(ms / 2 ** 24) & 0xff;
    b[3] = Math.floor(ms / 2 ** 16) & 0xff;
    b[4] = Math.floor(ms / 2 ** 8) & 0xff;
    b[5] = ms & 0xff;
    b[6] = 0x70 | (lastSeq >> 8);
    b[7] = lastSeq & 0xff;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as Uuid;
  };
}

const shared = uuidv7Generator();

/** UUID v7 from the process-wide monotonic generator. */
export function uuidv7(nowMs?: number): Uuid {
  return shared(nowMs);
}

/**
 * New time-ordered branded id. Without an argument it uses the process-wide monotonic generator.
 * With an explicit `nowMs` (e.g. from a test Clock) the timestamp is exactly that value.
 */
export function newId<K extends string>(nowMs?: number): Id<K> {
  return (nowMs === undefined ? shared() : uuidv7Generator()(nowMs)) as Id<K>;
}

/** Milliseconds since epoch encoded in a UUID v7. */
export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

/**
 * A stable id derived from `seed` (sha256, first 128 bits, version nibble 8 = "custom", RFC 9562
 * variant). The same seed always gives the same id, so a writer can make a retry idempotent
 * without a lookup. It carries no timestamp, so `uuidv7Timestamp` means nothing for it.
 */
export function deterministicId<K extends string>(seed: string): Id<K> {
  const h = createHash('sha256').update(seed).digest();
  h[6] = 0x80 | ((h[6] ?? 0) & 0x0f);
  h[8] = 0x80 | ((h[8] ?? 0) & 0x3f);
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}` as Id<K>;
}
