import { sha256Hex } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import { type ObjectStoreError, type ObjectStorePort } from './object-store.js';

// The ObjectStorePort contract suite (PLAN M14.1). `objectStoreContract` runs against any adapter: the fake
// always, `S3ObjectStore` against MinIO when it is reachable. The harness names buckets (a real store keeps a
// write-once bucket's objects, so each run uses fresh names) and can plant corrupt bytes under a key.

export interface ObjectStoreHarness {
  readonly port: ObjectStorePort;
  /** A bucket name unique to this run and `label` (valid for the port's bucket rules). */
  bucket(label: string): string;
  /** Replaces what the store holds under `sha256` with `bytes` behind the port's back. */
  corrupt(bucket: string, sha256: string, bytes: Uint8Array): Promise<void>;
  /** The per-object limit the port was made with. */
  readonly maxObjectBytes: number;
  stop?: () => Promise<void>;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function failure<T>(r: { ok: boolean; error?: ObjectStoreError; value?: T }): ObjectStoreError {
  if (r.ok || !r.error) throw new Error('expected an error result');
  return r.error;
}

export function objectStoreContract(name: string, make: () => Promise<ObjectStoreHarness>): void {
  describe(`ObjectStorePort contract: ${name}`, () => {
    it('put is content-addressed: key = sha256, idempotent, size reported', async () => {
      const h = await make();
      const b = h.bucket('normal');
      expect((await h.port.declareBucket(b, 'normal')).ok).toBe(true);
      const a = await h.port.put(b, bytes('hello'), { contentType: 'text/plain' });
      expect(a).toEqual({ ok: true, value: { sha256: sha256Hex('hello'), size: 5 } });
      const again = await h.port.put(b, bytes('hello'), { contentType: 'text/plain' });
      expect(again).toEqual(a);
      const other = await h.port.put(b, bytes('hello!'), { contentType: 'text/plain' });
      expect(other.ok && other.value.sha256).toBe(sha256Hex('hello!'));
      await h.stop?.();
    });

    it('get returns the bytes; head returns size and content type, or null; get of absent is not_found', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      const sha = sha256Hex('{"a":1}');
      expect(await h.port.head(b, sha)).toEqual({ ok: true, value: null });
      expect(failure(await h.port.get(b, sha)).code).toBe('not_found');
      await h.port.put(b, bytes('{"a":1}'), { contentType: 'application/json' });
      const got = await h.port.get(b, sha);
      expect(got.ok && text(got.value)).toBe('{"a":1}');
      const head = await h.port.head(b, sha);
      expect(head.ok && head.value).toMatchObject({
        sha256: sha,
        size: 7,
        contentType: 'application/json',
      });
      await h.stop?.();
    });

    it('empty and binary objects round-trip', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      const bin = Uint8Array.from({ length: 256 }, (_, i) => i);
      for (const data of [new Uint8Array(0), bin]) {
        const p = await h.port.put(b, data, { contentType: 'application/octet-stream' });
        expect(p.ok).toBe(true);
        const g = await h.port.get(b, sha256Hex(data));
        expect(g.ok && Buffer.from(g.value).equals(Buffer.from(data))).toBe(true);
      }
      await h.stop?.();
    });

    it('get verifies the hash: bytes that do not hash to the key are a hash_mismatch, never returned', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      const sha = sha256Hex('genuine');
      await h.port.put(b, bytes('genuine'), { contentType: 'text/plain' });
      await h.corrupt(b, sha, bytes('forged'));
      const r = await h.port.get(b, sha);
      expect(failure(r).code).toBe('hash_mismatch');
      expect(JSON.stringify(r)).not.toContain('forged');
      await h.stop?.();
    });

    it('delete removes an object of a normal bucket and is idempotent', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      const sha = sha256Hex('gone');
      await h.port.put(b, bytes('gone'), { contentType: 'text/plain' });
      expect((await h.port.delete(b, sha)).ok).toBe(true);
      expect(await h.port.head(b, sha)).toEqual({ ok: true, value: null });
      expect((await h.port.delete(b, sha)).ok).toBe(true);
      await h.stop?.();
    });

    it('a write_once bucket refuses delete with a tagged error and keeps the object', async () => {
      const h = await make();
      const b = h.bucket('once');
      expect((await h.port.declareBucket(b, 'write_once')).ok).toBe(true);
      const sha = sha256Hex('evidence');
      await h.port.put(b, bytes('evidence'), { contentType: 'text/plain' });
      const d = await h.port.delete(b, sha);
      expect(failure(d)).toMatchObject({ _tag: 'ObjectStoreError', code: 'write_once' });
      const g = await h.port.get(b, sha);
      expect(g.ok && text(g.value)).toBe('evidence');
      // refused for an absent key too: the bucket's rule does not depend on what is in it
      expect(failure(await h.port.delete(b, sha256Hex('absent'))).code).toBe('write_once');
      await h.stop?.();
    });

    it('a write_once put of identical bytes is a no-op; different bytes are a different object, the first is untouched', async () => {
      const h = await make();
      const b = h.bucket('once');
      await h.port.declareBucket(b, 'write_once');
      const first = await h.port.put(b, bytes('pack-1'), { contentType: 'text/plain' });
      const same = await h.port.put(b, bytes('pack-1'), { contentType: 'text/plain' });
      expect(same).toEqual(first);
      const second = await h.port.put(b, bytes('pack-2'), { contentType: 'text/plain' });
      expect(second.ok && second.value.sha256).toBe(sha256Hex('pack-2'));
      const g = await h.port.get(b, sha256Hex('pack-1'));
      expect(g.ok && text(g.value)).toBe('pack-1');
      await h.stop?.();
    });

    it('declaring is idempotent; declaring the other mode is bucket_mode_conflict', async () => {
      const h = await make();
      const b = h.bucket('mode');
      expect((await h.port.declareBucket(b, 'write_once')).ok).toBe(true);
      expect((await h.port.declareBucket(b, 'write_once')).ok).toBe(true);
      expect(failure(await h.port.declareBucket(b, 'normal')).code).toBe('bucket_mode_conflict');
      await h.stop?.();
    });

    it('an undeclared or malformed bucket, and a malformed key, are refused', async () => {
      const h = await make();
      const undeclared = h.bucket('never');
      expect(
        failure(await h.port.put(undeclared, bytes('x'), { contentType: 'text/plain' })).code,
      ).toBe('unknown_bucket');
      expect(failure(await h.port.get(undeclared, sha256Hex('x'))).code).toBe('unknown_bucket');
      expect(failure(await h.port.declareBucket('Bad_Bucket', 'normal')).code).toBe(
        'unknown_bucket',
      );
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      for (const key of ['abc', 'A'.repeat(64), '../etc/passwd', `${'a'.repeat(63)}/`]) {
        expect(failure(await h.port.get(b, key)).code).toBe('invalid_argument');
        expect(failure(await h.port.head(b, key)).code).toBe('invalid_argument');
        expect(failure(await h.port.delete(b, key)).code).toBe('invalid_argument');
      }
      await h.stop?.();
    });

    it('an object over the size limit is refused and not stored; one at the limit is accepted', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      const over = new Uint8Array(h.maxObjectBytes + 1).fill(7);
      expect(
        failure(await h.port.put(b, over, { contentType: 'application/octet-stream' })).code,
      ).toBe('too_large');
      expect(await h.port.head(b, sha256Hex(over))).toEqual({ ok: true, value: null });
      const at = new Uint8Array(h.maxObjectBytes).fill(9);
      expect((await h.port.put(b, at, { contentType: 'application/octet-stream' })).ok).toBe(true);
      await h.stop?.();
    });

    it('an unprintable content type is refused', async () => {
      const h = await make();
      const b = h.bucket('normal');
      await h.port.declareBucket(b, 'normal');
      expect(
        failure(await h.port.put(b, bytes('x'), { contentType: 'text/plain\r\nx-evil: 1' })).code,
      ).toBe('invalid_argument');
      await h.stop?.();
    });
  });
}
