import { err, ok, sha256Hex, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// ObjectStorePort (PLAN M14.1; ADR-0003 §2): where large content lives (Evidence Packs from M14.4, big
// blobs). Content-addressed: the key of an object IS the sha256 of its bytes, so a `put` of the same bytes is
// the same key (idempotent) and a different object can never take an existing key. `get` re-hashes what the
// store returned and refuses a mismatch: a store is untrusted storage, not a source of truth.
//
// Buckets are declared with a mode. `write_once` is for evidence: delete is refused with a tagged error, and
// an adapter backed by a real store also asks the store to lock the objects (S3 Object Lock), so a bug here
// is not the only thing between the evidence and a delete. Adapters: `S3ObjectStore` (object-store-s3.ts, any
// S3-compatible server: MinIO locally) and `FakeObjectStore` below (deterministic, same rules).

export const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

export type BucketMode = 'normal' | 'write_once';

export const ObjectStoreError = taggedError('ObjectStoreError');
export type ObjectStoreError = TaggedError<
  'ObjectStoreError',
  {
    code:
      /** The bucket was not declared (or the name is not a valid bucket name). */
      | 'unknown_bucket'
      /** `declareBucket` named a mode other than the one the bucket already has. */
      | 'bucket_mode_conflict'
      | 'not_found'
      /** What the store returned does not hash to its key. Never returned as bytes. */
      | 'hash_mismatch'
      | 'too_large'
      /** Delete (or any change) of an object of a `write_once` bucket. */
      | 'write_once'
      | 'invalid_argument'
      /** The store did not answer, or answered with a server error. Unknown means unmet. */
      | 'unavailable'
      /** The store answered but refused (credentials, policy). */
      | 'refused';
    message: string;
  }
>;
export const objectStoreError = (
  code: ObjectStoreError['code'],
  message: string,
): ObjectStoreError => ObjectStoreError({ code, message });

export type ObjectStoreResult<T> = Result<T, ObjectStoreError>;

export interface PutOptions {
  readonly contentType: string;
}

export interface ObjectInfo {
  readonly sha256: string;
  readonly size: number;
}

export interface ObjectHead extends ObjectInfo {
  readonly contentType: string;
}

export interface ObjectStorePort {
  /** Idempotent. Declaring a bucket again with another mode is `bucket_mode_conflict`. */
  declareBucket(bucket: string, mode: BucketMode): Promise<ObjectStoreResult<void>>;
  put(bucket: string, bytes: Uint8Array, opts: PutOptions): Promise<ObjectStoreResult<ObjectInfo>>;
  /** The bytes, verified against `sha256`. Absent: `not_found`. A mismatch: `hash_mismatch`, never the bytes. */
  get(bucket: string, sha256: string): Promise<ObjectStoreResult<Uint8Array>>;
  /** `null` when the object is absent (absence is an answer, not an error). */
  head(bucket: string, sha256: string): Promise<ObjectStoreResult<ObjectHead | null>>;
  /** Idempotent in a `normal` bucket; always `write_once` in a `write_once` bucket. */
  delete(bucket: string, sha256: string): Promise<ObjectStoreResult<void>>;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const CONTENT_TYPE_RE = /^[\x21-\x7e][\x20-\x7e]{0,126}$/;

export const isBucketName = (s: string): boolean => BUCKET_RE.test(s);
export const isSha256Hex = (s: string): boolean => SHA_RE.test(s);

/** The checks every adapter makes first (one function for the fake and the real adapters). */
export function checkBucket(bucket: string): ObjectStoreError | null {
  return BUCKET_RE.test(bucket)
    ? null
    : objectStoreError('unknown_bucket', 'bucket names are 3 to 63 characters of a-z, 0-9 and -');
}
export function checkKey(sha256: string): ObjectStoreError | null {
  return SHA_RE.test(sha256)
    ? null
    : objectStoreError(
        'invalid_argument',
        'an object key is a lower-case sha256 hex (64 characters)',
      );
}
export function checkPut(
  bytes: Uint8Array,
  opts: PutOptions,
  maxObjectBytes: number,
): ObjectStoreError | null {
  if (!(bytes instanceof Uint8Array))
    return objectStoreError('invalid_argument', 'bytes must be a Uint8Array');
  if (bytes.byteLength > maxObjectBytes)
    return objectStoreError(
      'too_large',
      `object of ${bytes.byteLength} bytes is over the limit of ${maxObjectBytes}`,
    );
  if (!CONTENT_TYPE_RE.test(opts.contentType))
    return objectStoreError('invalid_argument', 'contentType is not a printable header value');
  return null;
}

/** `get`'s last step, shared: the bytes must hash to the key they were asked under. */
export function verifyBytes(sha256: string, bytes: Uint8Array): ObjectStoreResult<Uint8Array> {
  return sha256Hex(bytes) === sha256
    ? ok(bytes)
    : err(objectStoreError('hash_mismatch', `object ${sha256} does not hash to its key`));
}

export interface FakeObjectStoreOptions {
  /** Per-object limit; default 64 MiB. */
  readonly maxObjectBytes?: number;
}

/** In memory, deterministic, the same rules as a real adapter. */
export class FakeObjectStore implements ObjectStorePort {
  private readonly modes = new Map<string, BucketMode>();
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  private readonly max: number;

  constructor(opts: FakeObjectStoreOptions = {}) {
    this.max = opts.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  async declareBucket(bucket: string, mode: BucketMode): Promise<ObjectStoreResult<void>> {
    const bad = checkBucket(bucket);
    if (bad) return err(bad);
    const have = this.modes.get(bucket);
    if (have !== undefined && have !== mode)
      return err(
        objectStoreError('bucket_mode_conflict', `bucket ${bucket} is ${have}, not ${mode}`),
      );
    this.modes.set(bucket, mode);
    return ok(undefined);
  }

  async put(
    bucket: string,
    bytes: Uint8Array,
    opts: PutOptions,
  ): Promise<ObjectStoreResult<ObjectInfo>> {
    const bad = this.checkBucketDeclared(bucket) ?? checkPut(bytes, opts, this.max);
    if (bad) return err(bad);
    const sha256 = sha256Hex(bytes);
    const k = `${bucket}/${sha256}`;
    // write_once: the same bytes are a no-op (the first content type stays); normal: stored again.
    if (!(this.modes.get(bucket) === 'write_once' && this.objects.has(k)))
      this.objects.set(k, { bytes: Uint8Array.from(bytes), contentType: opts.contentType });
    return ok({ sha256, size: bytes.byteLength });
  }

  async get(bucket: string, sha256: string): Promise<ObjectStoreResult<Uint8Array>> {
    const bad = this.checkBucketDeclared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    const o = this.objects.get(`${bucket}/${sha256}`);
    if (!o) return err(objectStoreError('not_found', `no object ${sha256} in ${bucket}`));
    return verifyBytes(sha256, Uint8Array.from(o.bytes));
  }

  async head(bucket: string, sha256: string): Promise<ObjectStoreResult<ObjectHead | null>> {
    const bad = this.checkBucketDeclared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    const o = this.objects.get(`${bucket}/${sha256}`);
    return ok(o ? { sha256, size: o.bytes.byteLength, contentType: o.contentType } : null);
  }

  async delete(bucket: string, sha256: string): Promise<ObjectStoreResult<void>> {
    const bad = this.checkBucketDeclared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    if (this.modes.get(bucket) === 'write_once')
      return err(
        objectStoreError('write_once', `bucket ${bucket} is write-once: delete is refused`),
      );
    this.objects.delete(`${bucket}/${sha256}`);
    return ok(undefined);
  }

  /** TEST ONLY: replaces the stored bytes under a key without touching the key (a store that lost or changed data). */
  corrupt(bucket: string, sha256: string, bytes: Uint8Array): void {
    const k = `${bucket}/${sha256}`;
    const o = this.objects.get(k);
    this.objects.set(k, {
      bytes: Uint8Array.from(bytes),
      contentType: o?.contentType ?? 'application/octet-stream',
    });
  }

  private checkBucketDeclared(bucket: string): ObjectStoreError | null {
    const bad = checkBucket(bucket);
    if (bad) return bad;
    return this.modes.has(bucket)
      ? null
      : objectStoreError('unknown_bucket', `bucket ${bucket} was not declared`);
  }
}
