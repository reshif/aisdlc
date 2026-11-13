import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codeHostConfigFromEnv } from '../src/config.js';
import { generateTestAppKey } from '../src/testing.js';

// The legacy (environment) configuration's plain-http rule: credentials go over https, or plain http to loopback, or to a
// host the deployment names (the compose stack's fake GitHub on the Push Broker's own network), and to nothing else.

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-codehost-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const key = join(dir, 'app.pem');
writeFileSync(key, generateTestAppKey().privatePem, { mode: 0o600 });
const tok = join(dir, 'tok');
writeFileSync(tok, 'token-of-the-codehost-at-identity-0123456789');
const env = (over: Record<string, string>) => ({
  CODEHOST_GITHUB_APP_ID: '123',
  CODEHOST_GITHUB_INSTALLATION_ID: '5',
  CODEHOST_GITHUB_APP_KEY_REF: `file:${key}`,
  CODEHOST_CALLERS: JSON.stringify({ x: { token_ref: `file:${tok}`, scopes: ['push'] } }),
  CODEHOST_IDENTITY_URL: 'http://identity:8330',
  CODEHOST_IDENTITY_TOKEN_REF: `file:${tok}`,
  CODEHOST_CORE_URL: 'http://core:8380',
  CODEHOST_CORE_TOKEN_REF: `file:${tok}`,
  CODEHOST_MODE: 'push',
  ...over,
});

describe('the codehost configuration', () => {
  it('sends credentials over plain http only to loopback or a named host', () => {
    expect(() =>
      codeHostConfigFromEnv(env({ CODEHOST_GITHUB_API_URL: 'http://codehost:8358' })),
    ).toThrow(/must be https/);
    const ok = codeHostConfigFromEnv(
      env({
        CODEHOST_GITHUB_API_URL: 'http://codehost:8358',
        CODEHOST_GITHUB_PLAIN_HTTP_HOSTS: '["codehost"]',
      }),
    );
    expect(ok.apiUrl).toBe('http://codehost:8358');
    expect(ok.mode).toBe('push');
    expect(() =>
      codeHostConfigFromEnv(
        env({
          CODEHOST_GITHUB_API_URL: 'http://elsewhere:8358',
          CODEHOST_GITHUB_PLAIN_HTTP_HOSTS: '["codehost"]',
        }),
      ),
    ).toThrow(/must be https/);
    expect(() =>
      codeHostConfigFromEnv(env({ CODEHOST_GITHUB_PLAIN_HTTP_HOSTS: '["Not A Host"]' })),
    ).toThrow();
  });
});
