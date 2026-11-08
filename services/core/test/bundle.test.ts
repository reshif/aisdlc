import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { ConfigRegistry, configPublish, migrateConfig, type ConfigDeps } from '@aisdlc/config';
import { createTestDatabase, dbUrlRef } from '@aisdlc/db/testing';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import {
  grantFleetRole,
  seedPrincipals,
  startIdentityStack,
  type IdentityStack,
} from '@aisdlc/identity/testing';
import { buildBundle, proposeBundle, registerPdpConfig } from '@aisdlc/pdp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pid, pr } from '../src/testing.js';
import { readS0 } from '../src/index.js';

// The core bundle as a process (plain node, no TypeScript loader). Every database URL reaches the
// child as an `env:` reference (`dbUrlRef`): a literal URL with a password is refused, and CI's
// Postgres has one.

// The responses are asserted field by field; typing every body would only repeat the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'core', 'dist', 'main.js');

const runOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, [bundle], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

const tok = (n: string) => `${n}-token-`.padEnd(32, 'x');

describe('the core bundle fails fast on bad configuration', () => {
  it('missing database, a password in the URL, bad callers, a bad port, a half-configured ledger', () => {
    expect(runOnce({}).status).toBe(78);
    expect(runOnce({}).stderr).toMatch(/core: configuration error: CORE_DATABASE_URL is required/);
    const secret = runOnce({ CORE_DATABASE_URL: 'postgres://u:pw@localhost/db' });
    expect(secret.status).toBe(78);
    expect(secret.stderr).toMatch(/contains a password/);
    expect(secret.stderr).not.toMatch(/pw@/);
    const callers = JSON.stringify({ bff: { token_ref: 'env:T', scopes: ['read'] } });
    expect(runOnce({ CORE_DATABASE_URL: 'postgres://localhost/db' }).stderr).toMatch(
      /CORE_CALLERS is required/,
    );
    const port = runOnce({
      CORE_DATABASE_URL: 'postgres://localhost/db',
      CORE_CALLERS: callers,
      T: 'a'.repeat(32),
      CORE_PORT: '99999',
    });
    expect(port.status).toBe(78);
    expect(port.stderr).toMatch(/CORE_PORT must be an integer/);
    const scope = runOnce({
      CORE_DATABASE_URL: 'postgres://localhost/db',
      CORE_CALLERS: JSON.stringify({ bff: { token_ref: 'env:T', scopes: ['admin'] } }),
      T: 'a'.repeat(32),
    });
    expect(scope.status).toBe(78);
    const notary = runOnce({
      CORE_DATABASE_URL: 'postgres://localhost/db',
      CORE_CALLERS: callers,
      T: 'a'.repeat(32),
      CORE_NOTARY_URL: 'http://127.0.0.1:1',
    });
    expect(notary.status).toBe(78);
    expect(notary.stderr).toMatch(/CORE_NOTARY_TOKEN_REF is required/);
  });

  it('refuses to start against a database whose record schemas are not migrated', async () => {
    const empty = await createTestDatabase();
    try {
      const r = runOnce({
        ...dbUrlRef('CORE_DATABASE_URL', empty.url),
        CORE_CALLERS: JSON.stringify({ bff: { token_ref: 'env:T', scopes: ['read'] } }),
        T: 'a'.repeat(32),
        CORE_PORT: '0',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/schema\(s\) are missing: migrate the record database first/);
    } finally {
      await empty.drop();
    }
  });
});

describe('the core bundle as a process', () => {
  let id: IdentityStack;
  let child: ChildProcess | undefined;
  let output = '';
  let base = '';

  beforeAll(async () => {
    id = await startIdentityStack();
    await migrateConfig(id.record.pool); // NOT the core schema: the process migrates it
    // The identity journal is written at the real time, so the memberships are in force for the child.
    id.clock.set(new Date(Date.now() - 24 * 3600_000));
    await seedPrincipals(id.deps, ['alice', 'bob']);
    await grantFleetRole(id.deps, 'alice', 'factory.admin');

    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        ...dbUrlRef('CORE_DATABASE_URL', id.record.url),
        CORE_CALLERS: JSON.stringify({
          bff: { token_ref: 'env:BFF_T', scopes: ['read', 'onboard'] },
          codehost: { token_ref: 'env:CH_T', scopes: ['registry'] },
        }),
        BFF_T: tok('bff'),
        CH_T: tok('codehost'),
        CORE_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`core did not start:\n${output}`)), 30_000);
      const poll = setInterval(() => {
        const m = /core listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`core exited ${code}:\n${output}`)));
    });
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await id?.stop();
  });

  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
  };
  const onboard = { project_id: 'proc', repo: 'acme/proc', level: 'light', on_behalf_of: 'alice' };

  it('migrated its own schema, serves healthz, and checks tokens and scopes', async () => {
    const have = await id.record.pool.query("SELECT to_regclass('core.s0_record')::text AS t");
    expect(have.rows[0].t).toBe('core.s0_record');
    expect((await call(null, 'GET', '/healthz')).status).toBe(200);
    expect((await call(null, 'GET', '/v1/projects/proc')).status).toBe(401);
    expect((await call(tok('codehost'), 'GET', '/v1/projects/proc')).status).toBe(403);
    expect((await call(tok('bff'), 'GET', '/v1/projects/proc/settings')).status).toBe(404);
    expect((await call(tok('bff'), 'GET', '/v1/registered-repos')).status).toBe(403);
    expect((await call(tok('codehost'), 'GET', '/v1/registered-repos')).json).toEqual([]);
  });

  it('with no policy bundle published every decision is a deny; once one is published, the admin is allowed', async () => {
    const denied = await call(tok('bff'), 'POST', '/v1/onboard', onboard);
    expect(denied.status).toBe(403);
    expect(denied.json?.['error'].reasons).toEqual(['no_bundle']);

    // Publish the PDP bundle through config (M1), as a factory admin.
    id.clock.set(new Date());
    const elig = new FakeEligibility();
    elig.setPolicy(pid('factory'), { tier: 'T1' });
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
      elig.setHolders(pid('factory'), slot, slot === 'admin' ? [pr('root')] : []);
    }
    const deps: ConfigDeps = {
      pool: id.record.pool,
      ledger: id.ledger,
      eligibility: elig,
      stepUp: new FakeStepUp(),
      clock: id.clock,
      registry: registerPdpConfig(new ConfigRegistry()),
    };
    const p = await proposeBundle(deps, buildBundle(), pr('root'));
    if (!p.ok) throw new Error(p.error.detail);
    const prep = await prepare(deps, {
      gate_instance_id: p.value.gate_instance_id,
      principal: pr('root'),
    });
    if (!prep.ok) throw new Error(JSON.stringify(prep.error));
    await recordEvidenceViewed(deps, {
      nonce: prep.value.nonce,
      evidence_hash: prep.value.evidence_hash,
    });
    const dec = await decide(deps, { nonce: prep.value.nonce, decision: 'approve' });
    if (!dec.ok) throw new Error(JSON.stringify(dec.error));
    const pub = await configPublish(deps, { rev_hash: p.value.rev_hash });
    if (!pub.ok) throw new Error(pub.error.message);

    // The child's config reader sees the publish (LISTEN, or its poll).
    const end = Date.now() + 20_000;
    let r = await call(tok('bff'), 'POST', '/v1/onboard', { ...onboard, on_behalf_of: 'bob' });
    expect(r.status).toBe(403);
    do {
      r = await call(tok('bff'), 'POST', '/v1/onboard', onboard);
      if (r.status === 201) break;
      await new Promise((res) => setTimeout(res, 200));
    } while (Date.now() < end);
    expect(r.status, JSON.stringify(r.json) + output.slice(-500)).toBe(201);
    expect(r.json?.['s0_ref']).toMatch(/^record:/);

    // The registry the codehost reads now has the repo; the record is in `app`.
    expect((await call(tok('codehost'), 'GET', '/v1/registered-repos')).json).toEqual([
      { project_id: 'proc', repo: 'acme/proc' },
    ]);
    const o = await call(tok('bff'), 'GET', `/v1/s0/${r.json?.['s0_id']}`);
    expect(o.json?.['record']).toMatchObject({ status: 'app', requested_level: 'light' });
    // A second process or test writer sees the same record: it is on the record, not in memory.
    expect((await readS0(id.record.pool, r.json?.['s0_id']))?.record.status).toBe('app');
  }, 90_000);

  it('stops on SIGTERM with exit 0 and never prints a token', async () => {
    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child?.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toMatch(/core: SIGTERM received, shutting down/);
    for (const t of [tok('bff'), tok('codehost')]) expect(output.includes(t)).toBe(false);
  });
});
