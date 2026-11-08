import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRegistry, configPublish } from '@aisdlc/config';
import { migrateConfig } from '@aisdlc/config';
import { PrincipalId, ProjectId } from '@aisdlc/contracts';
import { createTestDatabase } from '@aisdlc/db/testing';
import { migrateDirectory } from '@aisdlc/directory';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import {
  bindProject,
  grantFleetRole,
  seedLinks,
  seedPrincipals,
  startIdentityStack,
} from '@aisdlc/identity/testing';
import { sha256Hex } from '@aisdlc/kernel';
import { buildBundle, proposeBundle, registerPdpConfig } from '@aisdlc/pdp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDevOidcProvider, type DevOidcProvider } from '../src/dev-oidc/provider.js';
import { PgProofStore, SignedStepUp } from '../src/stepup/index.js';
import { Browser, CLIENT, freePort, signIn } from '../src/testing.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = join(import.meta.dirname, '..', '..', '..');
const dist = join(root, 'services', 'bff', 'dist');
const bundle = join(dist, 'main.js');
const devOidc = join(dist, 'dev-oidc.js');

const runOnce = (file: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [file], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

const GOOD = {
  BFF_DATABASE_URL: 'postgres://localhost/db',
  BFF_PUBLIC_URL: 'http://127.0.0.1:1',
  BFF_OIDC_ISSUER: 'http://127.0.0.1:2',
  BFF_OIDC_CLIENT_ID: 'bff',
  BFF_OIDC_CLIENT_SECRET_REF: 'env:S',
  S: 'a'.repeat(32),
  KMS_URL: 'http://127.0.0.1:3',
  KMS_TOKEN_REF: 'env:K',
  K: 'b'.repeat(32),
};

describe('the bff bundle fails fast on bad configuration', () => {
  it('lists what is missing, one at a time, with exit 78', () => {
    const r = runOnce(bundle, {});
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/bff: configuration error: BFF_DATABASE_URL is required/);
    const pw = runOnce(bundle, { ...GOOD, BFF_DATABASE_URL: 'postgres://u:pw@localhost/db' });
    expect(pw.status).toBe(78);
    expect(pw.stderr).toMatch(/contains a password/);
    expect(pw.stderr).not.toMatch(/pw@/);
  });

  it('refuses a secret that is not a reference, a short secret, and unsafe cookie / mode settings', () => {
    const literal = runOnce(bundle, {
      ...GOOD,
      BFF_OIDC_CLIENT_SECRET_REF: 'literal-secret-value-123456',
    });
    expect(literal.status).toBe(78);
    expect(literal.stderr).toMatch(/env:NAME or file:PATH/);
    const short = runOnce(bundle, { ...GOOD, S: 'short' });
    expect(short.status).toBe(78);
    const cookie = runOnce(bundle, {
      ...GOOD,
      BFF_COOKIE_SECURE: 'false',
      BFF_PUBLIC_URL: 'https://factory.example',
    });
    expect(cookie.status).toBe(78);
    expect(cookie.stderr).toMatch(/only for a plain http/);
    const mode = runOnce(bundle, { ...GOOD, BFF_STEP_UP_MODE: 'sometimes' });
    expect(mode.status).toBe(78);
    const rate = runOnce(bundle, { ...GOOD, BFF_PDP_SAMPLE_RATE: '2' });
    expect(rate.status).toBe(78);
  });

  it('refuses to start against a database whose other schemas are not migrated', async () => {
    const empty = await createTestDatabase();
    try {
      const r = runOnce(bundle, { ...GOOD, BFF_DATABASE_URL: empty.url, BFF_PORT: '0' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/schema\(s\) are missing/);
    } finally {
      await empty.drop();
    }
  });
});

describe('the Cedar WebAssembly asset in the bundle', () => {
  it('is copied next to main.js, which is self-contained ESM with no node_modules at run time', () => {
    expect(existsSync(join(dist, 'cedar_wasm_bg.wasm'))).toBe(true);
    expect(existsSync(join(dist, 'migrations'))).toBe(false); // found at ../migrations, like the other services
    expect(existsSync(join(root, 'services', 'bff', 'migrations', '0001_bff.sql'))).toBe(true);
  });
});

describe('the bff bundle as a process (plain node, no TypeScript loader)', () => {
  let stack: Awaited<ReturnType<typeof startIdentityStack>>;
  let oidc: DevOidcProvider;
  let child: ChildProcess | undefined;
  let output = '';
  let dir: string;
  let base = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-bff-'));
    stack = await startIdentityStack();
    // The process runs on the real clock: what identity records now must already be in force for it.
    stack.clock.set(Date.now() - 60_000);
    const pool = stack.record.pool;
    await migrateDirectory(pool);
    await migrateConfig(pool);

    // The provider runs on the real clock: the process verifies ID tokens against its own.
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    oidc = await startDevOidcProvider({
      users: [
        { subject: 'sub-alice', name: 'alice', email: 'alice@example.test' },
        { subject: 'sub-root', name: 'root' },
      ],
      clients: [{ ...CLIENT, redirect_uris: [`${publicUrl}/auth/callback`] }],
      autoLogin: true,
    });
    await seedPrincipals(stack.deps, ['alice', 'root']);
    await seedLinks(stack.deps, [
      { principal: 'alice', issuer: oidc.issuer, subject: 'sub-alice' },
      { principal: 'root', issuer: oidc.issuer, subject: 'sub-root' },
    ]);
    await bindProject(stack, 'acme', { admin: ['alice'], kill: ['alice'] });
    await grantFleetRole(stack.deps, 'root', 'factory.admin');

    // Publish the policy bundle exactly as production does: config revision, M1 gate, config_publish.
    const elig = new FakeEligibility();
    elig.setPolicy(ProjectId.parse('factory'), { tier: 'T1' });
    for (const slot of [
      'admin',
      'requesters',
      'intent',
      'design',
      'g4',
      'g5',
      'x',
      'sec',
      'm4',
      'kill',
    ] as const) {
      elig.setHolders(
        ProjectId.parse('factory'),
        slot,
        slot === 'admin' ? [PrincipalId.parse('root')] : [],
      );
    }
    const cdeps = {
      pool,
      ledger: stack.ledger,
      eligibility: elig,
      stepUp: new FakeStepUp(),
      clock: stack.clock,
      registry: registerPdpConfig(new ConfigRegistry()),
    };
    const p = await proposeBundle(cdeps, buildBundle(), PrincipalId.parse('root'));
    if (!p.ok) throw new Error(`propose: ${JSON.stringify(p.error)}`);
    const pre = await prepare(cdeps, {
      gate_instance_id: p.value.gate_instance_id,
      principal: PrincipalId.parse('root'),
    });
    if (!pre.ok) throw new Error(`prepare: ${JSON.stringify(pre.error)}`);
    await recordEvidenceViewed(cdeps, {
      nonce: pre.value.nonce,
      evidence_hash: pre.value.evidence_hash,
    });
    const d = await decide(cdeps, { nonce: pre.value.nonce, decision: 'approve' });
    if (!d.ok) throw new Error(`decide: ${JSON.stringify(d.error)}`);
    const pub = await configPublish(cdeps, { rev_hash: p.value.rev_hash });
    if (!pub.ok) throw new Error(`publish: ${JSON.stringify(pub.error)}`);

    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        BFF_DATABASE_URL: stack.record.url,
        BFF_PUBLIC_URL: publicUrl,
        BFF_OIDC_ISSUER: oidc.issuer,
        BFF_OIDC_CLIENT_ID: CLIENT.client_id,
        BFF_OIDC_CLIENT_SECRET_REF: 'env:BFF_TEST_SECRET',
        BFF_TEST_SECRET: CLIENT.client_secret,
        KMS_URL: stack.kms.url,
        KMS_TOKEN_REF: 'env:BFF_TEST_KMS',
        BFF_TEST_KMS: stack.kms.tokens['bff'] as string,
        BFF_COOKIE_SECURE: 'false',
        BFF_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (x) => (output += x));
    child.stderr?.on('data', (x) => (output += x));
    base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bff did not start:\n${output}`)), 20_000);
      const poll = setInterval(() => {
        const m = /bff listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`bff exited ${code}:\n${output}`)));
    });
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await oidc?.stop();
    await stack?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('migrates its own schema, logs a principal in, and answers /api/me from the bundle published through config', async () => {
    const { browser } = await signIn({ base }, 'alice' as never);
    const me = await browser.request(`${base}/api/me`);
    expect(me.status).toBe(200);
    const body = (await me.json()) as Json;
    expect(body.principal.principal_id).toBe('alice');
    // The PDP in the process is Cedar from the wasm next to the bundle, on the published bundle.
    expect(body.actions.projects[0].project_id).toBe('acme');
    expect(body.actions.projects[0].actions).toEqual(
      expect.arrayContaining(['project.settings.edit', 'kill.request']),
    );
    expect(body.actions.fleet).toEqual([]);
    const root = new Browser();
    const idp = new URL(
      (await root.request(`${base}/auth/login`)).headers.get('location') as string,
    );
    idp.searchParams.set('login_hint', 'sub-root');
    await root.follow(idp.toString());
    const rme = (await (await root.request(`${base}/api/me`)).json()) as Json;
    expect(rme.actions.fleet).toEqual(
      expect.arrayContaining(['project.onboard', 'config.propose']),
    );
    // No token anywhere the browser looked.
    expect(browser.transcript.join('\n')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.|dev-at-|dev-rt-/);
  });

  it('runs the step-up through the process, and the proof it issued verifies with the real StepUpPort', async () => {
    const { browser } = await signIn({ base }, 'alice' as never);
    const csrf = ((await (await browser.request(`${base}/api/me`)).json()) as Json)
      .csrf_token as string;
    const H = sha256Hex('text on the card');
    const started = (await (
      await browser.request(`${base}/api/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ text_sha256: H }),
      })
    ).json()) as Json;
    expect(started.status).toBe('redirect');
    await browser.follow(started.authorize_url);
    const got = (await (
      await browser.request(`${base}/api/step-up/${started.attempt_id}`)
    ).json()) as Json;
    const verifier = new SignedStepUp({
      custody: stack.kms.custodyFor('witness'),
      store: new PgProofStore(stack.record.pool),
    });
    expect((await verifier.verify(got.proof, H as never, PrincipalId.parse('alice'))).ok).toBe(
      true,
    );
    expect((await verifier.verify(got.proof, H as never, PrincipalId.parse('alice'))).ok).toBe(
      false,
    ); // single use
  });

  it('stops on SIGTERM with exit 0', async () => {
    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child?.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toMatch(/bff: SIGTERM received, shutting down/);
  });
});

describe('the dev OIDC provider bundle', () => {
  it('refuses to run unless FACTORY_ENV=local, and serves discovery when it does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-devoidc-'));
    const users = join(dir, 'users.json');
    writeFileSync(users, JSON.stringify([{ subject: 'sub-1', name: 'One' }]));
    const env = {
      DEV_OIDC_USERS_FILE: users,
      DEV_OIDC_CLIENT_ID: 'bff',
      DEV_OIDC_CLIENT_SECRET_REF: 'env:DS',
      DS: 'c'.repeat(32),
      DEV_OIDC_REDIRECT_URIS: 'http://127.0.0.1:1/auth/callback',
      DEV_OIDC_PORT: '0',
    };
    try {
      const refused = runOnce(devOidc, env);
      expect(refused.status).toBe(78);
      expect(refused.stderr).toMatch(/FACTORY_ENV=local/);
      const child = spawn(process.execPath, [devOidc], {
        env: { PATH: process.env['PATH'] ?? '', ...env, FACTORY_ENV: 'local' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (x) => (out += x));
      child.stderr?.on('data', (x) => (out += x));
      const url = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`dev-oidc did not start:\n${out}`)), 15_000);
        const poll = setInterval(() => {
          const m = /dev-oidc listening on (http:\/\/\S+)/.exec(out);
          if (m) {
            clearTimeout(t);
            clearInterval(poll);
            resolve(m[1] as string);
          }
        }, 50);
      });
      try {
        const d = (await (await fetch(`${url}/.well-known/openid-configuration`)).json()) as Json;
        expect(d.issuer).toBe(url);
        expect(d.code_challenge_methods_supported).toEqual(['S256']);
      } finally {
        const exited = new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
