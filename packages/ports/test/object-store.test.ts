import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@aisdlc/kernel';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeObjectStore, S3ObjectStore, signV4 } from '../src/index.js';
import { objectStoreContract, type ObjectStoreHarness } from '../src/object-store-contract.js';

const MAX = 1024 * 1024;
const run = randomBytes(4).toString('hex');
const nameFor = (label: string): string => `t-${run}-${label}`;

objectStoreContract('FakeObjectStore', async () => {
  const fake = new FakeObjectStore({ maxObjectBytes: MAX });
  const h: ObjectStoreHarness = {
    port: fake,
    maxObjectBytes: MAX,
    bucket: nameFor,
    corrupt: async (bucket, sha, bytes) => fake.corrupt(bucket, sha, bytes),
  };
  return h;
});

describe('FakeObjectStore defaults', () => {
  it('the default limit is 64 MiB', async () => {
    const f = new FakeObjectStore();
    await f.declareBucket('big-bucket', 'normal');
    const r = await f.put('big-bucket', new Uint8Array(64 * 1024 * 1024 + 1), {
      contentType: 'x/y',
    });
    expect(r.ok).toBe(false);
  });
});

describe('SigV4', () => {
  it('matches the AWS documented GET Object example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object, Range)
    const out = signV4(
      {
        accessKey: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadSha256: sha256Hex(''),
        region: 'us-east-1',
        now: new Date('2013-05-24T00:00:00Z'),
      },
    );
    expect(out['authorization']).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

// ---- the real adapter, against MinIO, only when one is reachable ---------------------------------------------
// MINIO_ENDPOINT points at a running server (with MINIO_ACCESS_KEY / MINIO_SECRET_KEY); otherwise, when Docker
// answers, the test starts a throwaway MinIO container on a random loopback port; otherwise it is skipped
// with a message (like the sandbox-driver tests).

const MINIO_IMAGE =
  process.env['MINIO_IMAGE'] ??
  'chainguard/minio@sha256:db3f583fa49121942168bd6383a773b2cde3384c9a99bf7193560b9a0f3a28fd';
const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });

async function waitLive(endpoint: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface Minio {
  endpoint: string;
  access: string;
  secret: string;
  stop(): void;
}

async function startMinio(): Promise<Minio | { skip: string }> {
  const env = process.env['MINIO_ENDPOINT'];
  const access = process.env['MINIO_ACCESS_KEY'] ?? `ak${randomBytes(10).toString('hex')}`;
  const secret = process.env['MINIO_SECRET_KEY'] ?? randomBytes(16).toString('hex');
  if (env) {
    return (await waitLive(env))
      ? { endpoint: env, access, secret, stop() {} }
      : { skip: `MINIO_ENDPOINT ${env} does not answer` };
  }
  const v = docker('version', '--format', '{{.Server.Version}}');
  if (v.status !== 0)
    return { skip: 'no MinIO endpoint (MINIO_ENDPOINT) and no Docker daemon answers' };
  if (
    docker('image', 'inspect', MINIO_IMAGE).status !== 0 &&
    docker('pull', MINIO_IMAGE).status !== 0
  )
    return { skip: `no MinIO endpoint and the image ${MINIO_IMAGE} is not available` };
  const name = `aisdlc-minio-test-${run}`;
  const r = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    '127.0.0.1::9000',
    '-e',
    `MINIO_ROOT_USER=${access}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secret}`,
    '-e',
    'MINIO_BROWSER=off',
    MINIO_IMAGE,
    'server',
    '/data',
    '--address',
    ':9000',
  );
  if (r.status !== 0) return { skip: `could not start MinIO: ${r.stderr.trim().slice(0, 120)}` };
  const port = docker('port', name, '9000/tcp').stdout.trim().split('\n')[0]?.split(':').pop();
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = () => void docker('rm', '-f', name);
  if (!(await waitLive(endpoint))) {
    stop();
    return { skip: 'the MinIO container did not become live' };
  }
  return { endpoint, access, secret, stop };
}

const minio = await startMinio();
const reachable = !('skip' in minio);
if (!reachable) console.warn(`ObjectStore MinIO tests SKIPPED: ${minio.skip}`);
afterAll(() => {
  if (reachable) minio.stop();
});

const dir = mkdtempSync(join(tmpdir(), 'objstore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!reachable)('S3ObjectStore against MinIO', () => {
  const m = reachable ? minio : { endpoint: '', access: '', secret: '', stop() {} };
  writeFileSync(join(dir, 'access'), m.access);
  writeFileSync(join(dir, 'secret'), m.secret);
  const mk = (): S3ObjectStore =>
    new S3ObjectStore({
      endpoint: m.endpoint,
      accessKeyRef: `file:${join(dir, 'access')}`,
      secretKeyRef: `file:${join(dir, 'secret')}`,
      maxObjectBytes: MAX,
    });

  objectStoreContract('S3ObjectStore (MinIO)', async () => {
    const s3 = mk();
    const h: ObjectStoreHarness = {
      port: s3,
      maxObjectBytes: MAX,
      bucket: nameFor,
      corrupt: async (bucket, sha, bytes) => {
        const r = await s3.request('PUT', bucket, sha, { body: bytes });
        if (!r.ok || r.value.status !== 200) throw new Error('could not plant corrupt bytes');
      },
    };
    return h;
  });

  it('write_once: the store itself locks the object (layer 2), not only the adapter', async () => {
    const s3 = mk();
    const b = nameFor('lock');
    await s3.declareBucket(b, 'write_once');
    const put = await s3.put(b, new TextEncoder().encode('locked'), { contentType: 'text/plain' });
    if (!put.ok) throw new Error('put failed');
    // Bypass the adapter: a versioned DELETE (the real removal) is refused by the legal hold.
    const head = await s3.request('HEAD', b, put.value.sha256);
    expect(head.ok && head.value.headers.get('x-amz-object-lock-legal-hold')).toBe('ON');
    const vid = head.ok ? head.value.headers.get('x-amz-version-id') : null;
    const del = await s3.request('DELETE', b, put.value.sha256, {
      query: `versionId=${vid ?? ''}`,
    });
    // MinIO: 400 InvalidRequest "Object is WORM protected"
    expect(del.ok && del.value.status).toBe(400);
    expect(del.ok && new TextDecoder().decode(del.value.body)).toContain('WORM protected');
    expect((await s3.get(b, put.value.sha256)).ok).toBe(true);
  });

  it('knownBuckets: an adapter that sends no bucket request purges what another adapter stored (the deletion)', async () => {
    const b = nameFor('known');
    const writer = mk();
    await writer.declareBucket(b, 'write_once');
    const put = await writer.put(b, new TextEncoder().encode('held'), {
      contentType: 'text/plain',
    });
    if (!put.ok) throw new Error('put failed');
    const seen: string[] = [];
    const purger = new S3ObjectStore({
      endpoint: m.endpoint,
      accessKeyRef: `file:${join(dir, 'access')}`,
      secretKeyRef: `file:${join(dir, 'secret')}`,
      knownBuckets: { [b]: 'write_once' },
      fetch: (input, init) => {
        seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).search}`);
        return fetch(input, init);
      },
    });
    expect((await purger.purge(b, put.value.sha256)).ok).toBe(true);
    expect((await writer.get(b, put.value.sha256)).ok).toBe(false);
    // list versions, lift the hold, delete the version: no CreateBucket, no object-lock read
    expect(seen.map((s) => s.split(/[=&]/)[0])).toEqual([
      'GET ?versions',
      'PUT ?legal-hold',
      'DELETE ?versionId',
    ]);
  });

  it('an existing bucket with the wrong mode is a conflict across adapter instances', async () => {
    const b = nameFor('xmode');
    expect((await mk().declareBucket(b, 'normal')).ok).toBe(true);
    const r = await mk().declareBucket(b, 'write_once');
    expect(!r.ok && r.error.code).toBe('bucket_mode_conflict');
  });

  it('wrong credentials are refused, and the secret is not in the error', async () => {
    writeFileSync(join(dir, 'bad'), 'x'.repeat(24));
    const s3 = new S3ObjectStore({
      endpoint: m.endpoint,
      accessKeyRef: `file:${join(dir, 'access')}`,
      secretKeyRef: `file:${join(dir, 'bad')}`,
    });
    const r = await s3.declareBucket(nameFor('badcred'), 'normal');
    expect(!r.ok && r.error.code).toBe('refused');
    expect(JSON.stringify(r)).not.toContain(m.secret);
  });

  it('an unreachable store is unavailable, never a success', async () => {
    const s3 = new S3ObjectStore({
      endpoint: 'http://127.0.0.1:1',
      accessKeyRef: `file:${join(dir, 'access')}`,
      secretKeyRef: `file:${join(dir, 'secret')}`,
      timeoutMs: 2000,
    });
    const r = await s3.declareBucket(nameFor('down'), 'normal');
    expect(!r.ok && r.error.code).toBe('unavailable');
  });
});
