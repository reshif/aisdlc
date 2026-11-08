import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode, sha256Hex, verifyEs256 } from '@aisdlc/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpKeyCustody } from '../src/client.js';
import { KeyStoreError, loadOrCreateKeys } from '../src/keys.js';
import { startTestKms, type TestKms } from '../src/testing.js';
import { kmsOptionsFromEnv } from '../src/main-config.js';

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

describe('kms-local (local mode)', () => {
  let kms: TestKms;
  beforeAll(async () => {
    kms = await startTestKms();
  });
  afterAll(async () => {
    await kms.stop();
  });

  it('signs a digest; the signature verifies with WebCrypto from the JWK alone', async () => {
    const notary = kms.custodyFor('notary');
    const jwk = await notary.publicKey('dev:notary');
    expect(jwk.ok).toBe(true);
    if (!jwk.ok) return;
    expect(jwk.value).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'dev:notary', alg: 'ES256' });
    expect(jwk.value).not.toHaveProperty('d');

    const message = new TextEncoder().encode('canonical message');
    const sig = await notary.sign('dev:notary', hex(sha256Hex(message)));
    expect(sig.ok).toBe(true);
    if (!sig.ok) return;
    expect(sig.value).toHaveLength(64);
    expect(await verifyEs256(jwk.value, message, b64urlEncode(sig.value))).toBe(true);
    expect(
      await verifyEs256(jwk.value, new TextEncoder().encode('other'), b64urlEncode(sig.value)),
    ).toBe(false);
  });

  it('serves the HMAC without exporting the key, and the MAC is stable', async () => {
    const knowledge = kms.custodyFor('knowledge');
    const a = await knowledge.hmac(
      'dev:fingerprint-hmac',
      new TextEncoder().encode('secret value'),
    );
    const b = await knowledge.hmac(
      'dev:fingerprint-hmac',
      new TextEncoder().encode('secret value'),
    );
    const c = await knowledge.hmac('dev:fingerprint-hmac', new TextEncoder().encode('another'));
    expect(a).toEqual(b);
    expect(a.ok && c.ok && a.value !== c.value).toBe(true);
    expect(a.ok && a.value).toMatch(/^[0-9a-f]{64}$/);
    // Recompute from the key file to prove it is HMAC-SHA-256 with that key.
    const file = readdirSync(kms.dir).find((f) => f.includes('fingerprint'));
    const k = JSON.parse(readFileSync(join(kms.dir, file as string), 'utf8')) as { k: string };
    expect(
      createHmac('sha256', Buffer.from(k.k, 'base64url')).update('secret value').digest('hex'),
    ).toBe(a.ok && a.value);
    // There is no route that returns key material.
    for (const path of [
      '/v1/keys/dev%3Afingerprint-hmac',
      '/v1/keys/dev%3Anotary/private',
      '/v1/keys',
    ]) {
      const r = await fetch(new URL(path, kms.url), {
        headers: { authorization: `Bearer ${kms.tokens['knowledge']}` },
      });
      expect(r.status).toBe(404);
    }
  });

  it('refuses a caller that is not on the key allow-list', async () => {
    const witness = kms.custodyFor('witness');
    const digest = new Uint8Array(32);
    const r = await witness.sign('dev:notary', digest);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('forbidden');
    const n = await kms.custodyFor('notary').hmac('dev:fingerprint-hmac', new Uint8Array(1));
    expect(!n.ok && n.error.kind).toBe('forbidden');
    const k = await kms.custodyFor('knowledge').sign('dev:witness', digest);
    expect(!k.ok && k.error.kind).toBe('forbidden');
    // An unknown key id is refused the same way for a caller that has no right to ask.
    const u = await witness.sign('dev:nothing', digest);
    expect(!u.ok && u.error.kind).toBe('forbidden');
  });

  it('refuses a missing or wrong service token', async () => {
    const bad = new HttpKeyCustody({ baseUrl: kms.url, token: 'x'.repeat(40) });
    const r = await bad.sign('dev:notary', new Uint8Array(32));
    expect(!r.ok && r.error.kind).toBe('unauthenticated');
    const none = await fetch(new URL('/v1/keys/dev%3Anotary/public', kms.url));
    expect(none.status).toBe(401);
  });

  it('refuses a malformed digest, the wrong key type and unknown keys', async () => {
    const notary = kms.custodyFor('notary');
    const short = await notary.sign('dev:notary', new Uint8Array(31));
    expect(!short.ok && short.error.kind).toBe('invalid_request');
    const wrong = await notary.hmac('dev:notary', new Uint8Array(1));
    expect(!wrong.ok && wrong.error.kind).toBe('wrong_key_type');
    const pub = await kms.custodyFor('knowledge').publicKey('dev:fingerprint-hmac');
    expect(!pub.ok && pub.error.kind).toBe('wrong_key_type');
    const unknown = await notary.publicKey('dev:nope');
    expect(!unknown.ok && unknown.error.kind).toBe('unknown_key');
  });

  it('is unavailable (an error, not a signature) when the service is down', async () => {
    const down = new HttpKeyCustody({ baseUrl: 'http://127.0.0.1:1', token: 'x'.repeat(40) });
    const r = await down.sign('dev:notary', new Uint8Array(32));
    expect(!r.ok && r.error.kind).toBe('unavailable');
  });
});

describe('kms-local (FACTORY_ENV=prod)', () => {
  it('refuses every dev: key and creates no key material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-kms-prod-'));
    const kms = await startTestKms({ factoryEnv: 'prod', dir });
    try {
      const notary = kms.custodyFor('notary');
      const s = await notary.sign('dev:notary', new Uint8Array(32));
      expect(!s.ok && s.error.kind).toBe('dev_key_refused');
      const p = await notary.publicKey('dev:notary');
      expect(!p.ok && p.error.kind).toBe('dev_key_refused');
      const h = await kms.custodyFor('knowledge').hmac('dev:fingerprint-hmac', new Uint8Array(1));
      expect(!h.ok && h.error.kind).toBe('dev_key_refused');
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      await kms.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unset FACTORY_ENV as not local', async () => {
    const kms = await startTestKms({ factoryEnv: '' });
    try {
      const r = await kms.custodyFor('notary').sign('dev:notary', new Uint8Array(32));
      expect(!r.ok && r.error.kind).toBe('dev_key_refused');
    } finally {
      await kms.stop();
    }
  });
});

describe('key files', () => {
  it('are created 0600 in a 0700 directory, kept across restarts, and refused when loosened', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aisdlc-kms-files-')), 'vol');
    try {
      const first = loadOrCreateKeys(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const files = readdirSync(dir);
      expect(files).toHaveLength(4);
      for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);

      const second = loadOrCreateKeys(dir);
      expect(second.get('dev:notary')?.publicJwk).toEqual(first.get('dev:notary')?.publicJwk);
      expect(second.get('dev:notary')?.publicJwk).not.toEqual(second.get('dev:witness')?.publicJwk);

      chmodSync(join(dir, 'dev_notary.key.json'), 0o644);
      expect(() => loadOrCreateKeys(dir)).toThrow(KeyStoreError);
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

describe('configuration', () => {
  it('reads callers and token references and applies the default allow-list', () => {
    const opts = kmsOptionsFromEnv({
      FACTORY_ENV: 'local',
      KMS_DIR: '/tmp/x',
      KMS_CALLERS: JSON.stringify({
        notary: { token_ref: 'env:T_NOTARY' },
        knowledge: { token_ref: 'env:T_KNOW' },
      }),
      T_NOTARY: 'n'.repeat(32),
      T_KNOW: 'k'.repeat(32),
    });
    expect(opts.allow).toEqual({ notary: ['dev:notary'], knowledge: ['dev:fingerprint-hmac'] });
    expect(opts.auth.authenticate(`Bearer ${'n'.repeat(32)}`)).toBe('notary');
    expect(opts.auth.authenticate(`Bearer ${'z'.repeat(32)}`)).toBeNull();
  });

  it('rejects a short token, an unknown caller without keys, and a missing reference', () => {
    const base = { FACTORY_ENV: 'local', KMS_DIR: '/tmp/x' };
    expect(() =>
      kmsOptionsFromEnv({ ...base, KMS_CALLERS: '{"notary":{"token_ref":"env:T"}}', T: 'short' }),
    ).toThrow();
    expect(() =>
      kmsOptionsFromEnv({
        ...base,
        KMS_CALLERS: '{"mallory":{"token_ref":"env:T"}}',
        T: 'm'.repeat(32),
      }),
    ).toThrow(/no default keys/);
    expect(() =>
      kmsOptionsFromEnv({ ...base, KMS_CALLERS: '{"notary":{"token_ref":"env:MISSING"}}' }),
    ).toThrow();
  });
});
