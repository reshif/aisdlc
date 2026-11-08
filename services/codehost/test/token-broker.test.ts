import { inspect } from 'node:util';
import {
  CODEHOST_ROLE_PERMISSIONS,
  CodeHostRoleValues,
  GITHUB_FORBIDDEN_PERMS,
  forbiddenPermissionsIn,
} from '@aisdlc/contracts';
import { contractSeed } from '@aisdlc/ports/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { appJwt } from '../src/jwt.js';
import { startTestCodeHost, type TestCodeHost } from '../src/testing.js';
import { TokenBroker } from '../src/token-broker.js';
import { AppKey } from '../src/app-key.js';
import { createPrivateKey, createPublicKey, createVerify } from 'node:crypto';

let t: TestCodeHost | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

describe('role permissions', () => {
  it('no role asks for a forbidden permission, and read roles only read', () => {
    for (const role of CodeHostRoleValues) {
      expect(forbiddenPermissionsIn(CODEHOST_ROLE_PERMISSIONS[role]), role).toEqual([]);
    }
    expect(CODEHOST_ROLE_PERMISSIONS.hub).toEqual({ contents: 'read', metadata: 'read' });
    expect(CODEHOST_ROLE_PERMISSIONS.posture).toEqual({ metadata: 'read' });
    expect(CODEHOST_ROLE_PERMISSIONS.docs).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
    expect(CODEHOST_ROLE_PERMISSIONS.tracker).toEqual({ issues: 'write', metadata: 'read' });
  });

  it('forbiddenPermissionsIn names administration, workflows, statuses, secrets, actions:write, admin levels and unknown levels', () => {
    expect(
      forbiddenPermissionsIn({
        administration: 'read',
        workflows: 'write',
        statuses: 'write',
        secrets: 'read',
        environments: 'read',
        security_events: 'read',
        repository_hooks: 'read',
        actions: 'write',
        contents: 'admin',
        issues: 'weird',
        metadata: 'read',
        pull_requests: 'write',
      }),
    ).toEqual([
      'actions:write',
      'administration:read',
      'contents:admin',
      'environments:read',
      'issues:weird',
      'repository_hooks:read',
      'secrets:read',
      'security_events:read',
      'statuses:write',
      'workflows:write',
    ]);
    expect(forbiddenPermissionsIn({ actions: 'read' })).toEqual([]);
    for (const p of [
      'administration',
      'workflows',
      'secrets',
      'environments',
      'statuses',
      'security_events',
    ]) {
      expect(GITHUB_FORBIDDEN_PERMS).toContain(p);
    }
  });
});

describe('the App JWT', () => {
  it('is RS256, names the app, lives under ten minutes and verifies with the public key', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    const key = AppKey.fromRef(`file:${t.keyFile}`);
    const jwt = appJwt(key, '123456', new Date('2026-11-09T10:00:00Z'));
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
      string,
      number | string
    >;
    expect(claims['iss']).toBe('123456');
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBeLessThanOrEqual(10 * 60);
    expect(claims['iat']).toBe(Date.parse('2026-11-09T10:00:00Z') / 1000 - 60);
    const pub = createPublicKey(createPrivateKey(t.keyPem));
    expect(
      createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pub, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });
});

describe('TokenBroker', () => {
  it('mints a token per role with exactly that role’s permissions, and never a forbidden one', async () => {
    t = await startTestCodeHost({
      seed: contractSeed(), // the installation holds statuses:write, as the testbed does
    });
    const hub = await t.broker.token('hub');
    const posture = await t.broker.token('posture');
    expect(hub.ok && hub.value.permissions).toEqual({ contents: 'read', metadata: 'read' });
    expect(posture.ok && posture.value.permissions).toEqual({ metadata: 'read' });
    for (const issued of t.server.issued) {
      expect(forbiddenPermissionsIn(issued.permissions)).toEqual([]);
      expect(Object.keys(issued.permissions)).not.toContain('statuses');
    }
    expect(t.server.issued).toHaveLength(2);
  });

  it('only the JWT-authenticated POST to the access_tokens URL is not a GET, and only mints are POSTs', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    await t.broker.token('hub');
    await t.rest.list_repos();
    const nonGet = t.server.requests.filter((r) => r.method !== 'GET');
    expect(nonGet.map((r) => `${r.method} ${r.path} ${r.auth}`)).toEqual([
      'POST /app/installations/4242/access_tokens jwt',
    ]);
  });

  it('list_repos carries GitHub’s owner type (User or Organization) as owner_type, for the readiness record', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    const r = await t.rest.list_repos();
    expect(r.state).toBe('ok');
    // the fake GitHub server answers `owner.type: "Organization"`
    expect(r.state === 'ok' && r.value.every((x) => x.owner_type === 'org')).toBe(true);
  });

  it('caches a token until shortly before it expires, then mints a new one', async () => {
    t = await startTestCodeHost({ seed: contractSeed(), tokenTtlMs: 60 * 60_000 });
    const a = await t.broker.token('hub');
    const b = await t.broker.token('hub');
    expect(t.broker.mintCount).toBe(1);
    expect(a.ok && b.ok && a.value.secret.reveal() === b.value.secret.reveal()).toBe(true);
    t.clock.advance(57 * 60_000); // 3 minutes left: still outside the 2 minute skew
    await t.broker.token('hub');
    expect(t.broker.mintCount).toBe(1);
    t.clock.advance(2 * 60_000); // 1 minute left: renew
    const c = await t.broker.token('hub');
    expect(t.broker.mintCount).toBe(2);
    expect(a.ok && c.ok && a.value.secret.reveal() !== c.value.secret.reveal()).toBe(true);
    await t.broker.token('posture');
    expect(t.broker.mintCount).toBe(3); // another role is another token
  });

  it('mints once for concurrent callers', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    const all = await Promise.all(Array.from({ length: 8 }, () => t!.broker.token('posture')));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(t.broker.mintCount).toBe(1);
  });

  it('does not mint write roles in Census mode: nothing is sent', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    for (const role of ['docs', 'tracker'] as const) {
      const r = await t.broker.token(role);
      expect(!r.ok && r.error).toMatchObject({ state: 'unreadable', reason: 'refused' });
    }
    expect(t.server.requests).toEqual([]);
  });

  it('refuses a token that carries more than was asked, and does not keep it', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    t.server.overshareOnMint({ administration: 'write' });
    const r = await t.broker.token('hub');
    expect(!r.ok && r.error).toMatchObject({ state: 'unreadable', reason: 'refused' });
    t.server.overshareOnMint({ statuses: 'write' });
    expect((await t.broker.token('posture')).ok).toBe(false);
    expect(t.broker.observedPermissions()).toEqual([]);
    t.server.overshareOnMint(null);
    expect((await t.broker.token('hub')).ok).toBe(true);
  });

  it('an installation that lacks a requested permission is permission_not_granted', async () => {
    const seed = contractSeed();
    seed.installation.permissions = { metadata: 'read' }; // no contents
    t = await startTestCodeHost({ seed });
    const r = await t.broker.token('hub');
    expect(!r.ok && r.error).toMatchObject({
      state: 'unreadable',
      reason: 'permission_not_granted',
    });
    expect(
      (await t.rest.read_at_sha({ repo: 'acme/app', sha: 'a'.repeat(40), path: 'x' })).state,
    ).not.toBe('ok');
    expect((await t.broker.token('posture')).ok).toBe(true);
  });

  it('a revoked token (401) is dropped and the next call mints a fresh one', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    expect((await t.rest.list_repos()).state).toBe('ok');
    t.server.revokeAllTokens();
    const failed = await t.rest.list_repos();
    expect(failed).toMatchObject({ state: 'unreadable', reason: 'unauthenticated' });
    expect((await t.rest.list_repos()).state).toBe('ok');
    expect(t.broker.mintCount).toBe(2);
  });

  it('records the permissions of the tokens GitHub returned (for B4a)', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    await t.broker.token('hub');
    expect(t.broker.observedPermissions()).toEqual([
      { role: 'hub', permissions: { contents: 'read', metadata: 'read' } },
    ]);
  });

  it('a token never prints: JSON, string and inspect all redact it', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    const r = await t.broker.token('hub');
    if (!r.ok) throw new Error('mint');
    const secret = r.value.secret.reveal();
    expect(secret).toMatch(/^ghs_/);
    for (const text of [
      JSON.stringify(r.value),
      String(r.value.secret),
      `${r.value.secret}`,
      inspect(r.value, { depth: 5 }),
      JSON.stringify(t.broker),
      inspect(t.broker, { depth: 5, showHidden: true }),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('static permissionsFor returns a copy', () => {
    const p = TokenBroker.permissionsFor('hub');
    p['administration'] = 'write';
    expect(CODEHOST_ROLE_PERMISSIONS.hub).toEqual({ contents: 'read', metadata: 'read' });
  });
});
