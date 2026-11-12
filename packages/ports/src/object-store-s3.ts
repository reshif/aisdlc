import { err, ok, sha256Hex } from '@aisdlc/kernel';
import { resolveSecretRef } from '@aisdlc/service-kit';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  checkBucket,
  checkKey,
  checkPut,
  objectStoreError,
  verifyBytes,
  type BucketMode,
  type ObjectHead,
  type ObjectInfo,
  type ObjectStoreError,
  type ObjectStorePort,
  type ObjectStoreResult,
  type PutOptions,
} from './object-store.js';
import { signV4, sha256Of, type SigV4Credentials } from './s3-sigv4.js';

// S3ObjectStore: `ObjectStorePort` over any S3-compatible server (MinIO in local-prod), with a minimal
// SigV4 signer over `fetch` (PutObject, GetObject, HeadObject, DeleteObject, CreateBucket, object-lock
// configuration). Path-style addressing. Credentials are `file:` references (`resolveSecretRef`): they are
// read once at construction, held only in the signer's closure and never put in an error or a log.
//
// write_once is defended in two layers: (1) the adapter refuses `delete` before it sends anything; (2) the
// bucket is created with Object Lock and every object is put under a legal hold, so the store itself refuses
// to remove the object's version. (A DELETE without a version id on a locked bucket only adds a delete
// marker, which hides the object: layer 1 is what stops that, so it is not optional.)

export interface S3ObjectStoreConfig {
  /** `http://host:9000` (plain http only for loopback or an internal network name; never carries a key off-host). */
  readonly endpoint: string;
  readonly region?: string;
  /** `file:/run/secrets/...` references (or `env:NAME`). */
  readonly accessKeyRef: string;
  readonly secretKeyRef: string;
  readonly maxObjectBytes?: number;
  /** Per-request timeout. Default 30 s. */
  readonly timeoutMs?: number;
  /** For tests: a fetch and a clock. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface Raw {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const errorCodeOf = (body: Uint8Array): string => {
  const m = /<Code>([^<]*)<\/Code>/.exec(new TextDecoder().decode(body.subarray(0, 4096)));
  return m?.[1] ?? '';
};

export class S3ObjectStore implements ObjectStorePort {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly creds: SigV4Credentials;
  private readonly max: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly modes = new Map<string, BucketMode>();

  constructor(cfg: S3ObjectStoreConfig) {
    this.endpoint = new URL(cfg.endpoint);
    this.region = cfg.region ?? 'us-east-1';
    this.creds = {
      accessKey: resolveSecretRef(cfg.accessKeyRef),
      secretKey: resolveSecretRef(cfg.secretKeyRef),
    };
    this.max = cfg.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.doFetch = cfg.fetch ?? fetch;
    this.now = cfg.now ?? (() => new Date());
  }

  /** The signed request, for callers that need a call the port does not have (tests, bucket maintenance). Never throws. */
  async request(
    method: string,
    bucket: string,
    key: string | null,
    opts: { query?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<ObjectStoreResult<Raw>> {
    const path = key === null ? `/${bucket}` : `/${bucket}/${key}`;
    const url = new URL(path + (opts.query ? `?${opts.query}` : ''), this.endpoint);
    const body = opts.body ?? new Uint8Array(0);
    const signed = signV4(this.creds, {
      method,
      url,
      headers: opts.headers ?? {},
      payloadSha256: sha256Of(body),
      region: this.region,
      now: this.now(),
    });
    // fetch sets `host` itself, to the same value that was signed.
    delete signed['host'];
    try {
      const res = await this.doFetch(url, {
        method,
        headers: signed,
        ...(method === 'PUT' || method === 'POST' ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return ok({ status: res.status, headers: res.headers, body: buf });
    } catch (cause) {
      return err(
        objectStoreError('unavailable', `object store request failed: ${(cause as Error).name}`),
      );
    }
  }

  async declareBucket(bucket: string, mode: BucketMode): Promise<ObjectStoreResult<void>> {
    const bad = checkBucket(bucket);
    if (bad) return err(bad);
    const have = this.modes.get(bucket);
    if (have !== undefined && have !== mode)
      return err(
        objectStoreError('bucket_mode_conflict', `bucket ${bucket} is ${have}, not ${mode}`),
      );
    const created = await this.request('PUT', bucket, null, {
      headers: mode === 'write_once' ? { 'x-amz-bucket-object-lock-enabled': 'true' } : {},
    });
    if (!created.ok) return created;
    const c = errorCodeOf(created.value.body);
    const existed =
      created.value.status === 409 &&
      (c === 'BucketAlreadyOwnedByYou' || c === 'BucketAlreadyExists');
    if (!(created.value.status === 200 || existed)) return err(this.unexpected(created.value));
    // The mode of a bucket that already exists must be what it is declared to be.
    const lock = await this.request('GET', bucket, null, { query: 'object-lock=' });
    if (!lock.ok) return lock;
    const locked =
      lock.value.status === 200 &&
      /<ObjectLockEnabled>Enabled<\/ObjectLockEnabled>/.test(
        new TextDecoder().decode(lock.value.body),
      );
    if (!locked && lock.value.status !== 404 && lock.value.status !== 200)
      return err(this.unexpected(lock.value));
    if ((mode === 'write_once') !== locked)
      return err(
        objectStoreError(
          'bucket_mode_conflict',
          `bucket ${bucket} exists ${locked ? 'with' : 'without'} object lock, declared ${mode}`,
        ),
      );
    this.modes.set(bucket, mode);
    return ok(undefined);
  }

  async put(
    bucket: string,
    bytes: Uint8Array,
    opts: PutOptions,
  ): Promise<ObjectStoreResult<ObjectInfo>> {
    const bad = this.declared(bucket) ?? checkPut(bytes, opts, this.max);
    if (bad) return err(bad);
    const sha256 = sha256Hex(bytes);
    const mode = this.modes.get(bucket);
    if (mode === 'write_once') {
      // Same bytes, same key: nothing to write (and nothing a second put could change).
      const h = await this.head(bucket, sha256);
      if (!h.ok) return h;
      if (h.value && h.value.size === bytes.byteLength)
        return ok({ sha256, size: bytes.byteLength });
    }
    const r = await this.request('PUT', bucket, sha256, {
      headers: {
        'content-type': opts.contentType,
        ...(mode === 'write_once' ? { 'x-amz-object-lock-legal-hold': 'ON' } : {}),
      },
      body: bytes,
    });
    if (!r.ok) return r;
    if (r.value.status !== 200) return err(this.unexpected(r.value));
    return ok({ sha256, size: bytes.byteLength });
  }

  async get(bucket: string, sha256: string): Promise<ObjectStoreResult<Uint8Array>> {
    const bad = this.declared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    const r = await this.request('GET', bucket, sha256);
    if (!r.ok) return r;
    if (r.value.status === 404)
      return err(objectStoreError('not_found', `no object ${sha256} in ${bucket}`));
    if (r.value.status !== 200) return err(this.unexpected(r.value));
    if (r.value.body.byteLength > this.max)
      return err(
        objectStoreError('too_large', `object ${sha256} is over the limit of ${this.max}`),
      );
    return verifyBytes(sha256, r.value.body);
  }

  async head(bucket: string, sha256: string): Promise<ObjectStoreResult<ObjectHead | null>> {
    const bad = this.declared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    const r = await this.request('HEAD', bucket, sha256);
    if (!r.ok) return r;
    if (r.value.status === 404) return ok(null);
    if (r.value.status !== 200) return err(this.unexpected(r.value));
    const size = Number(r.value.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 0)
      return err(
        objectStoreError('unavailable', 'object store answered HEAD without a valid length'),
      );
    return ok({
      sha256,
      size,
      contentType: r.value.headers.get('content-type') ?? 'application/octet-stream',
    });
  }

  async delete(bucket: string, sha256: string): Promise<ObjectStoreResult<void>> {
    const bad = this.declared(bucket) ?? checkKey(sha256);
    if (bad) return err(bad);
    // Layer 1: refused here, before anything is sent. (Layer 2 is the store's own object lock.)
    if (this.modes.get(bucket) === 'write_once')
      return err(
        objectStoreError('write_once', `bucket ${bucket} is write-once: delete is refused`),
      );
    const r = await this.request('DELETE', bucket, sha256);
    if (!r.ok) return r;
    if (r.value.status !== 204 && r.value.status !== 200 && r.value.status !== 404)
      return err(this.unexpected(r.value));
    return ok(undefined);
  }

  private declared(bucket: string): ObjectStoreError | null {
    const bad = checkBucket(bucket);
    if (bad) return bad;
    return this.modes.has(bucket)
      ? null
      : objectStoreError('unknown_bucket', `bucket ${bucket} was not declared`);
  }

  /** Only the status and the S3 error code: a response body can echo request detail, so it is not copied. */
  private unexpected(r: Raw): ObjectStoreError {
    const code = errorCodeOf(r.body);
    const detail = `object store answered ${r.status}${code ? ` ${code}` : ''}`;
    if (code === 'ObjectLocked') return objectStoreError('write_once', detail);
    if (r.status === 401 || r.status === 403) return objectStoreError('refused', detail);
    return objectStoreError('unavailable', detail);
  }
}
