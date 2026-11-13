import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ServiceConfigError,
  VaultClient,
  onSecretRefChange,
  primeSecretRefsFromEnv,
  refreshSecretRefs,
  resetSecretRefs,
  resolveSecretRef,
  secretRefVersion,
  setSecretRefVault,
  vaultRefsIn,
} from '@aisdlc/service-kit';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  AwsSecretsManagerStore,
  FakeSecretStore,
  FakeVault,
  VaultSecretStore,
  signV4,
  sha256Of,
} from '../src/index.js';
import { secretStoreContract } from '../src/secret-store-contract.js';

const run = randomBytes(4).toString('hex');
const pathFor = (label: string): string => `t${run}/${label}`;
const dir = mkdtempSync(join(tmpdir(), 'secret-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const VALUE = 'sk-ant-api03-THIS-IS-A-TEST-VALUE-0123456789';

// ---- the fake, the Vault adapter over the fake Vault, and over a real Vault -----------------------------------

secretStoreContract('FakeSecretStore', async () => ({
  port: new FakeSecretStore(),
  path: pathFor,
}));

secretStoreContract('VaultSecretStore (fake Vault)', async () => {
  const v = new FakeVault();
  const tok = v.token({ read: [''], write: [''], meta: [''], destroy: [''] });
  writeFileSync(join(dir, 'tok'), tok);
  return {
    port: new VaultSecretStore({
      addr: 'http://vault.test:8200',
      auth: { kind: 'token', tokenFile: join(dir, 'tok') },
      fetchImpl: v.fetch,
    }),
    path: pathFor,
  };
});

describe('VaultSecretStore and the Vault client', () => {
  const mk = (v: FakeVault, file: string) =>
    new VaultSecretStore({
      addr: 'http://vault.test:8200',
      auth: { kind: 'approle', file },
      fetchImpl: v.fetch,
    });

  it("a write-only policy (core's) can put and see metadata, and is denied the value", async () => {
    const v = new FakeVault();
    const file = join(dir, 'core-approle.json');
    writeFileSync(file, JSON.stringify(v.approle({ write: [''], meta: [''], destroy: [''] })));
    const s = mk(v, file);
    const ref = 'gateway/anthropic-api-key#value';
    expect((await s.put(ref, VALUE)).ok).toBe(true);
    const m = await s.meta(ref);
    expect(m.ok && m.value).toMatchObject({ set: true, version: 1 });
    const g = await s.get(ref);
    expect(!g.ok && g.error.code).toBe('denied');
    expect(JSON.stringify(g)).not.toContain(VALUE);
  });

  it("a reader's policy covers its own folder only", async () => {
    const v = new FakeVault();
    v.seed('gateway/anthropic-api-key', { value: VALUE });
    v.seed('codehost/github-app-key', { value: 'pem' });
    const file = join(dir, 'gw-approle.json');
    writeFileSync(file, JSON.stringify(v.approle({ read: ['gateway/'] })));
    const s = mk(v, file);
    expect(await s.get('gateway/anthropic-api-key#value')).toEqual({ ok: true, value: VALUE });
    const other = await s.get('codehost/github-app-key#value');
    expect(!other.ok && other.error.code).toBe('denied');
  });

  it('logs in again after its token is revoked; a sealed Vault is unavailable', async () => {
    const v = new FakeVault();
    v.seed('gateway/k', { value: VALUE });
    const file = join(dir, 'relogin.json');
    writeFileSync(file, JSON.stringify(v.approle({ read: [''] })));
    const s = mk(v, file);
    expect((await s.get('gateway/k#value')).ok).toBe(true);
    v.revokeAll();
    expect((await s.get('gateway/k#value')).ok).toBe(true);
    expect(v.log.filter((l) => l.path === '/v1/auth/approle/login')).toHaveLength(2);
    v.sealed = true;
    const r = await s.get('gateway/k#value');
    expect(!r.ok && r.error.code).toBe('unavailable');
  });

  it('a bad AppRole is denied, and the error names no secret', async () => {
    const v = new FakeVault();
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ role_id: 'nope', secret_id: VALUE }));
    const r = await mk(v, file).meta('gateway/x#value');
    expect(!r.ok && r.error.code).toBe('denied');
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it('an unreachable Vault is unavailable, never a value', async () => {
    const c = new VaultClient({
      addr: 'http://127.0.0.1:9',
      auth: { kind: 'token', tokenFile: join(dir, 'tok') },
      timeoutMs: 500,
    });
    const r = await new VaultSecretStore(c).meta('gateway/x#value');
    expect(!r.ok && r.error.code).toBe('unavailable');
  });
});

// ---- vault: references (service-kit's resolver over the fake Vault) -------------------------------------------

describe('vault: references', () => {
  afterEach(() => resetSecretRefs());

  it('finds the references in env values (plain and inside JSON)', () => {
    expect(
      vaultRefsIn(
        '["file:/run/secrets/a","vault:gateway/anthropic-api-key#value","vault:gateway/x#value"]',
      ),
    ).toEqual(['vault:gateway/anthropic-api-key#value', 'vault:gateway/x#value']);
    expect(vaultRefsIn('file:/run/secrets/x')).toEqual([]);
  });

  it('primes from the environment, resolves synchronously, remembers absence, refreshes and announces changes', async () => {
    const v = new FakeVault();
    v.seed('gateway/anthropic-api-key', { value: VALUE });
    const file = join(dir, 'refs.json');
    writeFileSync(file, JSON.stringify(v.approle({ read: ['gateway/'] })));
    const env = {
      VAULT_ADDR: 'http://vault.test:8200',
      VAULT_APPROLE_FILE: file,
      VAULT_REFRESH_SECONDS: '0',
      GATEWAY_SECRET_REFS: JSON.stringify([
        'vault:gateway/anthropic-api-key#value',
        'vault:gateway/openai-api-key#value',
      ]),
    };
    expect(await primeSecretRefsFromEnv(env, { fetchImpl: v.fetch })).toBe(2);
    expect(resolveSecretRef('vault:gateway/anthropic-api-key#value')).toBe(VALUE);
    expect(secretRefVersion('vault:gateway/anthropic-api-key#value')).toBe(1);
    expect(() => resolveSecretRef('vault:gateway/openai-api-key#value')).toThrow(
      ServiceConfigError,
    );
    expect(() => resolveSecretRef('vault:gateway/never-primed#value')).toThrow(/not loaded/);
    try {
      resolveSecretRef('vault:gateway/openai-api-key#value');
    } catch (e) {
      expect(String(e)).not.toContain(VALUE);
    }
    const seen: string[][] = [];
    onSecretRefChange((refs) => seen.push([...refs]));
    expect(await refreshSecretRefs()).toEqual([]);
    v.seed('gateway/openai-api-key', { value: 'sk-openai-TEST-0123456789' });
    v.seed('gateway/anthropic-api-key', { value: `${VALUE}-rotated` });
    const changed = await refreshSecretRefs();
    expect(changed.sort()).toEqual([
      'vault:gateway/anthropic-api-key#value',
      'vault:gateway/openai-api-key#value',
    ]);
    expect(seen).toHaveLength(1);
    expect(resolveSecretRef('vault:gateway/anthropic-api-key#value')).toBe(`${VALUE}-rotated`);
    expect(secretRefVersion('vault:gateway/anthropic-api-key#value')).toBe(2);
  });

  it('no reference in the environment needs no Vault; a reference without Vault settings is a config error', async () => {
    expect(await primeSecretRefsFromEnv({ X: 'file:/run/secrets/x' })).toBe(0);
    await expect(primeSecretRefsFromEnv({ X: 'vault:gateway/k#value' })).rejects.toThrow(
      /VAULT_ADDR/,
    );
  });

  it('a reference the policy denies fails the start (a configuration error), naming no value', async () => {
    const v = new FakeVault();
    v.seed('codehost/github-app-key', { value: VALUE });
    const file = join(dir, 'deny.json');
    writeFileSync(file, JSON.stringify(v.approle({ read: ['gateway/'] })));
    setSecretRefVault(null);
    await expect(
      primeSecretRefsFromEnv(
        {
          VAULT_ADDR: 'http://vault.test:8200',
          VAULT_APPROLE_FILE: file,
          VAULT_REFRESH_SECONDS: '0',
          K: 'vault:codehost/github-app-key#value',
        },
        { fetchImpl: v.fetch },
      ),
    ).rejects.toThrow(/denied/);
  });
});

// ---- the AWS Secrets Manager stub, against a fake JSON 1.1 server that checks every signature -----------------

interface AwsSecret {
  versions: Array<{ id: string; value: string }>;
}

async function fakeSecretsManager(access: string, secret: string) {
  const store = new Map<string, AwsSecret>();
  const bad: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      const h = req.headers;
      const target = String(h['x-amz-target'] ?? '').replace('secretsmanager.', '');
      // recompute the signature over what arrived, with the shared secret
      const date = String(h['x-amz-date']);
      const now = new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      );
      const expect = signV4(
        { accessKey: access, secretKey: secret },
        {
          method: 'POST',
          url: new URL(`http://${String(h.host)}/`),
          headers: {
            'content-type': String(h['content-type']),
            'x-amz-target': String(h['x-amz-target']),
          },
          payloadSha256: sha256Of(body),
          region: 'eu-west-1',
          now,
          service: 'secretsmanager',
        },
      );
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify(j));
      };
      if (expect['authorization'] !== h['authorization']) {
        bad.push(target);
        return send(400, { __type: 'InvalidSignatureException', message: 'signature' });
      }
      const b = JSON.parse(body) as Record<string, string>;
      const id = b['SecretId'] ?? b['Name'] ?? '';
      const s = store.get(id);
      const notFound = () => send(400, { __type: 'ResourceNotFoundException', message: 'no' });
      switch (target) {
        case 'CreateSecret':
          store.set(id, {
            versions: [{ id: b['ClientRequestToken'] ?? '', value: b['SecretString'] ?? '' }],
          });
          return send(200, { ARN: `arn:${id}`, Name: id });
        case 'PutSecretValue':
          if (!s) return notFound();
          s.versions.push({ id: b['ClientRequestToken'] ?? '', value: b['SecretString'] ?? '' });
          return send(200, { ARN: `arn:${id}` });
        case 'GetSecretValue':
          if (!s) return notFound();
          return send(200, { SecretString: s.versions.at(-1)?.value });
        case 'DescribeSecret':
          if (!s) return notFound();
          return send(200, {
            Name: id,
            LastChangedDate: 1_794_000_000 + s.versions.length,
            VersionIdsToStages: Object.fromEntries(
              s.versions.map((v, i) => [v.id, i === s.versions.length - 1 ? ['AWSCURRENT'] : []]),
            ),
          });
        case 'DeleteSecret':
          if (!s) return notFound();
          store.delete(id);
          return send(200, { Name: id });
        default:
          return send(400, { __type: 'UnknownOperationException' });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bad,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('AwsSecretsManagerStore (stub) against a fake Secrets Manager', async () => {
  const access = `AKIA${randomBytes(8).toString('hex').toUpperCase()}`;
  const secret = randomBytes(20).toString('hex');
  writeFileSync(join(dir, 'aws-access'), access);
  writeFileSync(join(dir, 'aws-secret'), secret);
  const fake = await fakeSecretsManager(access, secret);
  afterAll(() => fake.close());
  const mk = () =>
    new AwsSecretsManagerStore({
      region: 'eu-west-1',
      endpoint: fake.url,
      accessKeyRef: `file:${join(dir, 'aws-access')}`,
      secretKeyRef: `file:${join(dir, 'aws-secret')}`,
      prefix: 'aisdlc/',
    });

  secretStoreContract('AwsSecretsManagerStore (fake)', async () => ({ port: mk(), path: pathFor }));

  it('every request carried a valid SigV4 signature for secretsmanager', () => {
    expect(fake.bad).toEqual([]);
  });

  it('a wrong secret key is refused by the server, not mistaken for an absent secret', async () => {
    writeFileSync(join(dir, 'aws-wrong'), randomBytes(20).toString('hex'));
    const s = new AwsSecretsManagerStore({
      region: 'eu-west-1',
      endpoint: fake.url,
      accessKeyRef: `file:${join(dir, 'aws-access')}`,
      secretKeyRef: `file:${join(dir, 'aws-wrong')}`,
    });
    const r = await s.get('gateway/x#value');
    expect(r.ok).toBe(false);
    fake.bad.length = 0;
  });
});

// ---- the real Vault, only when Docker can start one -------------------------------------------------------------
// VAULT_TEST_ADDR + VAULT_TEST_TOKEN point at a running dev server; otherwise, when Docker answers, a throwaway dev
// server (the compose image, by digest) on a random loopback port; otherwise skipped with a message.

const VAULT_IMAGE =
  process.env['VAULT_IMAGE'] ??
  'hashicorp/vault@sha256:8f1ba670da547c6af67be55609bd285c3ee3d8b73f88021adbfc43c82ca409e8';
const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });

async function startVault(): Promise<
  { addr: string; token: string; stop(): void } | { skip: string }
> {
  const token = process.env['VAULT_TEST_TOKEN'] ?? `root-${randomBytes(8).toString('hex')}`;
  if (process.env['VAULT_TEST_ADDR'])
    return { addr: process.env['VAULT_TEST_ADDR'], token, stop() {} };
  if (docker('version', '--format', '{{.Server.Version}}').status !== 0)
    return { skip: 'no Docker daemon answers' };
  if (
    docker('image', 'inspect', VAULT_IMAGE).status !== 0 &&
    docker('pull', VAULT_IMAGE).status !== 0
  ) {
    return { skip: `the image ${VAULT_IMAGE} is not available` };
  }
  const name = `aisdlc-vault-test-${run}`;
  const r = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    '127.0.0.1::8200',
    '--cap-add',
    'IPC_LOCK',
    '-e',
    `VAULT_DEV_ROOT_TOKEN_ID=${token}`,
    '-e',
    'VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200',
    VAULT_IMAGE,
    'server',
    '-dev',
  );
  if (r.status !== 0) return { skip: `could not start Vault: ${r.stderr.trim().slice(0, 120)}` };
  const port = docker('port', name, '8200/tcp').stdout.trim().split('\n')[0]?.split(':').pop();
  const addr = `http://127.0.0.1:${port}`;
  const stop = () => void docker('rm', '-f', name);
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(1000) });
      if (h.status === 200) {
        // the factory's mount: KV version 2 at `aisdlc`
        const m = await fetch(`${addr}/v1/sys/mounts/aisdlc`, {
          method: 'POST',
          headers: { 'x-vault-token': token },
          body: JSON.stringify({ type: 'kv', options: { version: '2' } }),
        });
        if (m.status !== 204) break;
        return { addr, token, stop };
      }
    } catch {
      /* not yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  stop();
  return { skip: 'the Vault container did not become ready' };
}

const real = await startVault();
const reachable = !('skip' in real);
if (!reachable) console.warn(`SecretStore Vault tests SKIPPED: ${real.skip}`);
afterAll(() => {
  if (reachable) real.stop();
});

describe.skipIf(!reachable)('VaultSecretStore against a real Vault', () => {
  const r = reachable ? real : { addr: '', token: '', stop() {} };
  writeFileSync(join(dir, 'root'), r.token);
  secretStoreContract('VaultSecretStore (Vault)', async () => ({
    port: new VaultSecretStore({
      addr: r.addr,
      auth: { kind: 'token', tokenFile: join(dir, 'root') },
    }),
    path: pathFor,
  }));
});
