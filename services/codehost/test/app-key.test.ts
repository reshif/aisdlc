import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { FakeIdentityLinks } from '../src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppKey } from '../src/app-key.js';
import { generateTestAppKey } from '../src/testing.js';
import { TOKENS, seedWithOwners, startCodeHostApp, type CodeHostTestApp } from './stack.js';

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-appkey-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text, { mode: 0o600 });
  return `file:${p}`;
};

describe('AppKey', () => {
  it('loads PKCS#1 and PKCS#8 RSA keys from a file: reference and signs RS256', () => {
    const k = generateTestAppKey();
    const pkcs8 = createPrivateKey(k.privatePem)
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    for (const [name, pem] of [
      ['a.pem', k.privatePem],
      ['b.pem', pkcs8],
    ] as const) {
      const key = AppKey.fromRef(put(name, pem));
      expect(key.signRs256('x')).toHaveLength(256);
    }
  });

  it('refuses an env: reference, a missing file, a non-key, a non-RSA key and a short RSA key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    const cases: Array<[string, RegExp]> = [
      ['env:APP_KEY', /file: reference/],
      [`file:${join(dir, 'absent.pem')}`, /cannot read secret/],
      [put('junk.pem', 'SECRET-CONTENT-OF-A-FILE-THAT-IS-NOT-A-KEY'), /not a readable private key/],
      [put('ec.pem', ec), /not an RSA/],
      [put('short.pem', short), /shorter than 2048/],
    ];
    for (const [ref, re] of cases) {
      let thrown: unknown;
      try {
        AppKey.fromRef(ref, { env: { APP_KEY: generateTestAppKey().privatePem } });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, ref).toBeInstanceOf(ServiceConfigError);
      expect((thrown as Error).message).toMatch(re);
      expect((thrown as Error).message).not.toContain('SECRET-CONTENT');
      expect((thrown as Error).message).not.toContain('BEGIN');
    }
  });

  it('prints as a redaction everywhere and has no way to export the key', () => {
    const k = generateTestAppKey();
    const body = k.privatePem.replace(/-----[^-]+-----|\s/g, '');
    const key = AppKey.fromRef(put('c.pem', k.privatePem));
    for (const text of [
      JSON.stringify(key),
      JSON.stringify({ key }),
      String(key),
      `${key}`,
      inspect(key, { depth: 9, showHidden: true }),
      JSON.stringify(Object.getOwnPropertyNames(key)),
      JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(key))),
    ]) {
      expect(text).not.toContain(body.slice(40, 120));
      expect(text).not.toContain('BEGIN');
    }
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(key)).sort()).toEqual(
      ['constructor', 'signRs256', 'toJSON', 'toString'].sort(),
    );
  });
});

describe('the App key never appears in any output', () => {
  let s: CodeHostTestApp;
  beforeAll(async () => {
    s = await startCodeHostApp(new FakeIdentityLinks(), seedWithOwners('* @alice\n'));
  });
  afterAll(async () => {
    await s.stop();
  });

  it('greps every response, log line and server-side record for the key and every credential', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    console.error = console.log;
    console.warn = console.log;
    try {
      const sha = 'c'.repeat(40);
      const reqs: Array<[string | null, string, string, unknown?]> = [
        [TOKENS.census, 'GET', '/v1/repos'],
        [TOKENS.census, 'GET', `/v1/repos/acme/app/file?sha=${sha}&path=README.md`],
        [TOKENS.census, 'GET', `/v1/repos/acme/app/codeowners?sha=${sha}`],
        [TOKENS.posture, 'GET', '/v1/installation'],
        [TOKENS.posture, 'GET', '/v1/repos/acme/app/rules?branch=main'],
        [TOKENS.posture, 'GET', '/v1/repos/acme/app/b4'],
        [TOKENS.posture, 'GET', '/v1/repos/acme/lib/b4'],
        [
          TOKENS.sync,
          'POST',
          '/v1/projects/acme/codeowners/sync',
          { repos: [{ repo: 'acme/app' }] },
        ],
        // errors of every kind
        [null, 'GET', '/v1/repos'],
        [TOKENS.none, 'GET', '/v1/repos'],
        [TOKENS.census, 'GET', '/v1/nope'],
        [TOKENS.census, 'GET', '/v1/repos/acme/app/file?sha=bad'],
        [TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', '{not json'],
        [TOKENS.sync, 'POST', '/v1/projects/ACME!/codeowners/sync', { repos: [] }],
      ];
      for (const [t, m, p, b] of reqs) await s.call(t, m, p, b);
      // GitHub misbehaving.
      for (const status of [401, 403, 404, 422, 500, 502]) {
        s.gh.server.answerWith(status);
        await s.call(TOKENS.posture, 'GET', '/v1/installation');
        await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/rules?branch=main');
        await s.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'acme/app' }],
        });
      }
      s.gh.server.answerNormally();
      s.gh.server.revokeAllTokens();
      await s.call(TOKENS.census, 'GET', '/v1/repos');
      s.gh.server.overshareOnMint({ administration: 'write' });
      s.gh.clock.advance(2 * 60 * 60_000);
      await s.call(TOKENS.census, 'GET', '/v1/repos');
      s.gh.server.overshareOnMint(null);
      // An adapter error value, as text.
      const errs = [
        await s.gh.rest.read_at_sha({ repo: 'acme/app', sha: 'x', path: 'a' }),
        await s.gh.transport.request('POST', '/repos/acme/app/rulesets'),
      ];
      lines.push(JSON.stringify(errs));
    } finally {
      console.log = orig.log;
      console.error = orig.error;
      console.warn = orig.warn;
    }

    const pem = s.gh.keyPem;
    const pkcs8 = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
    const body = (p: string): string => p.replace(/-----[^-]+-----|\s/g, '');
    const needles = [
      body(pem).slice(0, 48),
      body(pem).slice(200, 260),
      body(pem).slice(-48),
      body(pkcs8).slice(60, 120),
      'BEGIN RSA PRIVATE KEY',
      'BEGIN PRIVATE KEY',
      ...s.gh.server.seenBearers, // the App JWTs and the installation tokens
      ...s.gh.server.issued.map((t) => t.token),
    ];
    expect(s.gh.server.issued.length).toBeGreaterThan(2);
    expect(s.gh.server.seenBearers.size).toBeGreaterThan(3);
    const haystack = [...s.outputs, ...s.gh.logs, ...lines].join('\n');
    expect(haystack.length).toBeGreaterThan(1000);
    for (const n of needles) {
      expect(haystack.includes(n), `output contains ${n.slice(0, 12)}...`).toBe(false);
    }
    // The service's own bearer tokens are not echoed either.
    for (const t of Object.values(TOKENS)) expect(haystack.includes(t)).toBe(false);
  });
});
