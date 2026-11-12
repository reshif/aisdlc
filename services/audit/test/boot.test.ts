import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_BUCKET, checkSignedAuditExport } from '@aisdlc/contracts';
import { S3ObjectStore } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootAudit, readExportBytes, writeExport } from '../src/index.js';
import { FROM, TO, startWorld, type World } from './fixture.js';

// The booted service (PLAN M19): from its environment, as its own role, with the real Notary over HTTP; and the
// write-once path against a real S3-compatible store (MinIO) when one is reachable (MINIO_ENDPOINT) or Docker can start
// one, as the object-store contract test does; otherwise that part is skipped with a message.

let w: World;
const dir = mkdtempSync(join(tmpdir(), 'audit-boot-'));

beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => {
  await w?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('bootAudit (PLAN M19)', () => {
  it('boots from its environment as its own role, answers health, and fails closed with no policy bundle', async () => {
    const tok = 'bff-at-audit-'.padEnd(32, 'y');
    writeFileSync(join(dir, 'tok'), tok);
    writeFileSync(join(dir, 'notary-tok'), w.notary.tokens['audit'] ?? '');
    writeFileSync(join(dir, 'notary.jwk'), JSON.stringify(w.keys.notary));
    writeFileSync(join(dir, 'witness.jwk'), JSON.stringify(w.keys.witness));
    writeFileSync(join(dir, 'db-url'), w.roleUrl);
    const svc = await bootAudit(
      {
        AUDIT_DATABASE_URL: `file:${join(dir, 'db-url')}`,
        AUDIT_CALLERS: JSON.stringify({
          bff: { token_ref: `file:${join(dir, 'tok')}`, scopes: ['read', 'export', 'govern'] },
        }),
        AUDIT_NOTARY_URL: w.notary.url,
        AUDIT_NOTARY_TOKEN_REF: `file:${join(dir, 'notary-tok')}`,
        AUDIT_NOTARY_KEY_REF: `file:${join(dir, 'notary.jwk')}`,
        AUDIT_WITNESS_KEY_REF: `file:${join(dir, 'witness.jwk')}`,
        AUDIT_CORE_URL: 'http://127.0.0.1:1',
        AUDIT_CORE_TOKEN_REF: `file:${join(dir, 'tok')}`,
        AUDIT_OBJECT_STORE_URL: 'http://127.0.0.1:1',
        AUDIT_OBJECT_STORE_ACCESS_KEY_REF: `file:${join(dir, 'tok')}`,
        AUDIT_OBJECT_STORE_SECRET_KEY_REF: `file:${join(dir, 'tok')}`,
        AUDIT_PORT: '0',
      },
      { log: () => undefined },
    );
    try {
      expect((await fetch(`${svc.url}/healthz`)).status).toBe(200);
      const noToken = await fetch(`${svc.url}/v1/holds?on_behalf_of=audrey`);
      expect(noToken.status).toBe(401);
      // no policy bundle is published in this database: the PDP denies everyone, the auditor too
      const r = await fetch(`${svc.url}/v1/holds?on_behalf_of=audrey`, {
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(r.status).toBe(403);
    } finally {
      await svc.close();
    }
  });

  it('refuses to start without its schema or with a private key where a public one is pinned', async () => {
    writeFileSync(join(dir, 'private.jwk'), JSON.stringify({ ...w.keys.notary, d: 'x' }));
    await expect(
      bootAudit({
        AUDIT_DATABASE_URL: `file:${join(dir, 'db-url')}`,
        AUDIT_CALLERS: '{}',
        AUDIT_NOTARY_URL: w.notary.url,
        AUDIT_NOTARY_TOKEN_REF: `file:${join(dir, 'notary-tok')}`,
        AUDIT_NOTARY_KEY_REF: `file:${join(dir, 'private.jwk')}`,
        AUDIT_WITNESS_KEY_REF: `file:${join(dir, 'witness.jwk')}`,
      }),
    ).rejects.toThrow(/public JWK/);
  });
});

// ---- the write-once path against MinIO -----------------------------------------------------------------------

const MINIO_IMAGE =
  process.env['MINIO_IMAGE'] ??
  'chainguard/minio@sha256:db3f583fa49121942168bd6383a773b2cde3384c9a99bf7193560b9a0f3a28fd';
const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });

async function live(endpoint: string): Promise<boolean> {
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

async function minio(): Promise<
  { endpoint: string; access: string; secret: string; stop(): void } | { skip: string }
> {
  const access = process.env['MINIO_ACCESS_KEY'] ?? `ak${randomBytes(10).toString('hex')}`;
  const secret = process.env['MINIO_SECRET_KEY'] ?? randomBytes(16).toString('hex');
  const env = process.env['MINIO_ENDPOINT'];
  if (env)
    return (await live(env))
      ? { endpoint: env, access, secret, stop() {} }
      : { skip: `${env} does not answer` };
  if (docker('version', '--format', '{{.Server.Version}}').status !== 0) {
    return { skip: 'no MinIO endpoint (MINIO_ENDPOINT) and no Docker daemon answers' };
  }
  if (
    docker('image', 'inspect', MINIO_IMAGE).status !== 0 &&
    docker('pull', MINIO_IMAGE).status !== 0
  ) {
    return { skip: `the image ${MINIO_IMAGE} is not available` };
  }
  const name = `aisdlc-minio-audit-${randomBytes(4).toString('hex')}`;
  const r = docker(
    'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::9000',
    '-e', `MINIO_ROOT_USER=${access}`, '-e', `MINIO_ROOT_PASSWORD=${secret}`, '-e', 'MINIO_BROWSER=off',
    MINIO_IMAGE, 'server', '/data', '--address', ':9000',
  ); // prettier-ignore
  if (r.status !== 0) return { skip: `could not start MinIO: ${r.stderr.trim().slice(0, 120)}` };
  const port = docker('port', name, '9000/tcp').stdout.trim().split('\n')[0]?.split(':').pop();
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = () => void docker('rm', '-f', name);
  if (!(await live(endpoint))) {
    stop();
    return { skip: 'the MinIO container did not become live' };
  }
  return { endpoint, access, secret, stop };
}

const m = await minio();
const reachable = !('skip' in m);
if (!reachable) console.warn(`audit MinIO tests SKIPPED: ${m.skip}`);
afterAll(() => {
  if (reachable) m.stop();
});

describe.skipIf(!reachable)('signed exports in a real write-once bucket (MinIO)', () => {
  it('an export goes into an Object Lock bucket under a legal hold, reads back to the same bytes, and cannot be removed', async () => {
    if (!reachable) return;
    writeFileSync(join(dir, 'ak'), m.access);
    writeFileSync(join(dir, 'sk'), m.secret);
    const s3 = new S3ObjectStore({
      endpoint: m.endpoint,
      accessKeyRef: `file:${join(dir, 'ak')}`,
      secretKeyRef: `file:${join(dir, 'sk')}`,
    });
    w.objects = s3;
    const r = await writeExport(
      w.exporter(),
      {
        scope: { kind: 'project', project_id: 'acme' as never },
        from: FROM,
        to: TO,
        reason: 'MinIO run',
      },
      'pam',
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const back = await readExportBytes({ pool: w.rolePool, objects: s3 }, r.value.export_id);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(
      (await checkSignedAuditExport(back.value.bytes, w.keys, { object_key: r.value.object_key }))
        .ok,
    ).toBe(true);
    const head = await s3.request('HEAD', AUDIT_BUCKET, r.value.object_key);
    expect(head.ok && head.value.headers.get('x-amz-object-lock-legal-hold')).toBe('ON');
    const del = await s3.delete(AUDIT_BUCKET, r.value.object_key);
    expect(!del.ok && del.error.code).toBe('write_once');
    const vid = head.ok ? head.value.headers.get('x-amz-version-id') : null;
    const raw = await s3.request('DELETE', AUDIT_BUCKET, r.value.object_key, {
      query: `versionId=${vid ?? ''}`,
    });
    expect(raw.ok && raw.value.status).toBe(400);
  });
});
