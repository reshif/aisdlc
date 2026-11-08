import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readFileSync as read,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { migrateRecord } from '@aisdlc/record';
import { listen, newApp } from '@aisdlc/service-kit';
import { makeCanary } from '@aisdlc/secrets-rules';
import { FixtureRepo, scratchDir } from '../src/testing.js';
import { assertNoForbiddenEnv, knowledgeConfigFromEnv } from '../src/config.js';

const root = join(import.meta.dirname, '..', '..', '..');
const dist = join(root, 'services', 'knowledge', 'dist', 'main.js');
const scratch = scratchDir();
afterAll(() => scratch.dispose());

const runOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, [dist], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

const T = 'a'.repeat(32);
const good: Record<string, string> = {
  KNOWLEDGE_DATABASE_URL: 'postgres://127.0.0.1:1/none',
  KNOWLEDGE_CALLERS: JSON.stringify({ core: { token_ref: 'env:T', scopes: ['census'] } }),
  T,
  KNOWLEDGE_CODEHOST_URL: 'http://127.0.0.1:1',
  KNOWLEDGE_CODEHOST_TOKEN_REF: 'env:T',
  KNOWLEDGE_IDENTITY_URL: 'http://127.0.0.1:1',
  KNOWLEDGE_IDENTITY_TOKEN_REF: 'env:T',
  KMS_URL: 'http://127.0.0.1:1',
  KMS_TOKEN_REF: 'env:T',
};

describe('configuration', () => {
  it('every misconfiguration exits 78 with a clear message', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /KNOWLEDGE_CALLERS is required/],
      [
        { ...good, KNOWLEDGE_CALLERS: '{"x":{"token_ref":"env:T","scopes":["admin"]}}' },
        /KNOWLEDGE_CALLERS/,
      ],
      [{ ...good, KNOWLEDGE_DATABASE_URL: 'postgres://u:pw@h/db' }, /contains a password/],
      [{ ...good, KNOWLEDGE_CODEHOST_URL: 'ftp://x' }, /http\(s\) URL/],
      [{ ...good, KNOWLEDGE_COMMIT_CAP: '0' }, /KNOWLEDGE_COMMIT_CAP/],
      [{ ...good, KNOWLEDGE_JOB_TIMEOUT_MS: '5' }, /KNOWLEDGE_JOB_TIMEOUT_MS/],
      [{ ...good, KNOWLEDGE_BUNDLE_CAP_BYTES: 'big' }, /KNOWLEDGE_BUNDLE_CAP_BYTES/],
      [{ ...good, KNOWLEDGE_MAX_FILE_BYTES: '0' }, /KNOWLEDGE_MAX_FILE_BYTES/],
    ];
    for (const [env, re] of cases) {
      const r = runOnce(env);
      expect(r.status, JSON.stringify(Object.keys(env))).toBe(78);
      expect(r.stderr).toMatch(re);
    }
  });

  it('refuses to start with a code-host credential or an HMAC key in its environment (DEC-5 condition 1)', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'CODEHOST_GITHUB_APP_KEY_REF',
      'CODEHOST_GITHUB_APP_ID',
      'FINGERPRINT_HMAC_KEY',
      'KMS_HMAC_KEY',
      'GITHUB_APP_PRIVATE_KEY',
      'GIT_CONFIG_COUNT',
    ]) {
      const r = runOnce({ ...good, [name]: 'x'.repeat(40) });
      expect(r.status, name).toBe(78);
      expect(r.stderr, name).toMatch(/no code-host credential and no HMAC key/);
      expect(r.stderr).toContain(name);
      expect(r.stderr).not.toContain('x'.repeat(40));
    }
    expect(() => assertNoForbiddenEnv({ ...good })).not.toThrow();
    expect(() => assertNoForbiddenEnv({ GITHUB_TOKEN: '' })).not.toThrow();
    expect(knowledgeConfigFromEnv(good).commitCap).toBe(50_000);
    expect(knowledgeConfigFromEnv(good).maxFileBytes).toBe(5 * 1024 * 1024);
    expect(knowledgeConfigFromEnv(good).bundleCapBytes).toBe(256 * 1024 * 1024);
  });
});

describe('the bundle holds no key and no credential code', () => {
  it('kms-local key code and the GitHub App code are not in dist/main.js, and no source file reaches them', () => {
    const js = readFileSync(dist, 'utf8');
    for (const marker of [
      'loadOrCreateKeys',
      'KEY_REGISTRY',
      'createHmac',
      'x-access-token',
      'extraheader',
      'TokenBroker',
    ]) {
      expect(js.includes(marker), marker).toBe(false);
    }
    const src = join(root, 'services', 'knowledge', 'src');
    for (const f of readdirSync(src).filter((x) => x.endsWith('.ts') && x !== 'testing.ts')) {
      const text = read(join(src, f), 'utf8');
      expect(text, f).not.toMatch(/@aisdlc\/(codehost|identity)['"/]/);
      expect(text.replace(/@aisdlc\/kms-local\/client/g, ''), f).not.toMatch(/@aisdlc\/kms-local/);
      expect(text, f).not.toMatch(/createHmac|process\.env\[['"](GITHUB|GH_)/);
    }
  });
});

describe('the knowledge bundle as a process', () => {
  let db: TestDatabase;
  let kms: TestKms;
  let codehost: Awaited<ReturnType<typeof listen>>;
  const stubs: Array<{ close(): Promise<unknown> }> = [];
  let child: ChildProcess | undefined;
  let output = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrateRecord(db.pool);
    kms = await startTestKms();
  });
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const s of stubs) await s.close();
    await db?.drop();
    await kms?.stop();
  });

  it('starts, runs a census-intake job end to end over HTTP, finds a planted canary, stops on SIGTERM and leaves nothing', async () => {
    const canary = makeCanary('process-level');
    const r = new FixtureRepo(scratch.dir, 'proc');
    r.write('a.txt', 'a\n').commit('1');
    r.write('k.txt', `K=${canary}\n`).commit('2');
    r.remove('k.txt').commit('3');
    const b = r.bundle(join(scratch.dir, 'proc.bundle'));

    // A stand-in codehost: serves the bundle on the route knowledge calls, for its own token only.
    const CH = 'codehost-token-'.padEnd(32, 'x');
    const ch = newApp();
    const asked: string[] = [];
    ch.get('/v1/repos/:owner/:name/bundle', async (req, reply) => {
      asked.push(req.url);
      if (req.headers.authorization !== `Bearer ${CH}`) return reply.code(401).send({});
      return reply
        .header('content-type', 'application/x-git-bundle')
        .header('x-base-sha', b.manifest.head_sha)
        .header('x-bundle-manifest', JSON.stringify(b.manifest))
        .send(createReadStream(b.file));
    });
    codehost = await listen(ch);
    stubs.push(ch);
    // A stand-in identity that knows one human.
    const id = newApp();
    id.get('/v1/principals/:id', async (req, reply) => {
      const p = (req.params as { id: string }).id;
      return p === 'alice'
        ? { principal_id: 'alice', kind: 'human', status: 'active' }
        : reply.code(404).send({});
    });
    const identity = await listen(id);
    stubs.push(id);

    const work = join(scratch.dir, 'proc-work');
    mkdirSync(work);
    const SEC = 'security-token-'.padEnd(32, 'x');
    const CEN = 'census-token-'.padEnd(32, 'x');
    child = spawn(process.execPath, ['--enable-source-maps', dist], {
      env: {
        PATH: process.env['PATH'] ?? '',
        KNOWLEDGE_DATABASE_URL: db.url,
        KNOWLEDGE_CALLERS: JSON.stringify({
          core: { token_ref: 'env:CEN', scopes: ['census'] },
          bff: { token_ref: 'env:SEC', scopes: ['security'] },
        }),
        CEN,
        SEC,
        KNOWLEDGE_CODEHOST_URL: codehost,
        KNOWLEDGE_CODEHOST_TOKEN_REF: 'env:CH',
        CH,
        KNOWLEDGE_IDENTITY_URL: identity,
        KNOWLEDGE_IDENTITY_TOKEN_REF: 'env:CH',
        KMS_URL: kms.url,
        KMS_TOKEN_REF: 'env:KT',
        KT: kms.tokens['knowledge'] as string,
        KNOWLEDGE_WORK_DIR: work,
        KNOWLEDGE_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`knowledge did not start:\n${output}`)), 30_000);
      const poll = setInterval(() => {
        const m = /knowledge listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`knowledge exited ${code}:\n${output}`)));
    });
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect((await fetch(new URL('/healthz', base))).status).toBe(200);
    const start = await call(CEN, 'POST', '/v1/jobs/census-intake', { repo: 'acme/app' });
    expect(start.status).toBe(202);
    let job: Record<string, unknown> = start.json;
    for (let i = 0; i < 200 && job['state'] !== 'done' && job['state'] !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await call(CEN, 'GET', `/v1/jobs/${start.json['job_id']}`)).json;
    }
    expect(job['state'], output).toBe('done');
    const summary = (await call(CEN, 'GET', '/v1/repos/acme/app/security-summary')).json;
    expect(summary).toMatchObject({
      scanned: true,
      b1_blocked: true,
      b2_reasons: [],
      finding_counts: { open: 1 },
    });
    const findings = (await call(SEC, 'GET', '/v1/security/findings')).json as {
      findings: Array<{ finding_id: string; first_commit: string }>;
    };
    expect(findings.findings).toHaveLength(1);
    expect(findings.findings[0]?.first_commit).toBe(
      r.git('rev-list', '--max-parents=1', '--reverse', 'HEAD').split('\n')[1],
    );
    // The human check goes to identity: alice is a human, the service is not.
    const fid = findings.findings[0]?.finding_id;
    expect(
      (
        await call(SEC, 'POST', `/v1/security/findings/${fid}/state`, {
          state: 'rotated',
          principal_id: 'svc',
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(SEC, 'POST', `/v1/security/findings/${fid}/state`, {
          state: 'rotated',
          principal_id: 'alice',
          reason: 'rotated',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await call(CEN, 'GET', '/v1/repos/acme/app/security-summary')).json as {
          b1_blocked: boolean;
        }
      ).b1_blocked,
    ).toBe(false);
    expect(asked[0]).toContain('/v1/repos/acme/app/bundle?refs=all');

    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    // Nothing the process printed holds the value, a token, or a key; no workspace is left.
    for (const secret of [canary, CH, CEN, SEC, kms.tokens['knowledge'] as string]) {
      expect(output.includes(secret)).toBe(false);
    }
    expect(readdirSync(work)).toEqual([]);
    expect(existsSync(work)).toBe(true);
  }, 90_000);
});
