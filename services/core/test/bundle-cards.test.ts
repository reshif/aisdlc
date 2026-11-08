import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dbUrlRef } from '@aisdlc/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// The core bundle with the Notary, the key lookup and the cards' remotes configured (PLAN M8.0):
// it boots with the signed step-up (kms-local's public key for the bff proofs) and the onboarding
// card routes are switched on, where without the remotes they answer `unavailable` (503).

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'core', 'dist', 'main.js');
const tok = (n: string) => `${n}-token-`.padEnd(32, 'x');

let s: CoreStack;
let child: ChildProcess | undefined;
let output = '';
let base = '';

beforeAll(async () => {
  s = await startCoreStack();
  child = spawn(process.execPath, ['--enable-source-maps', bundle], {
    env: {
      PATH: process.env['PATH'] ?? '',
      ...dbUrlRef('CORE_DATABASE_URL', s.record.url),
      CORE_CALLERS: JSON.stringify({ bff: { token_ref: 'env:BFF_T', scopes: ['read'] } }),
      BFF_T: tok('bff'),
      CORE_NOTARY_URL: s.id.notary.url,
      CORE_NOTARY_TOKEN_REF: 'env:N_T',
      N_T: s.id.notary.tokens['core'] as string,
      KMS_URL: s.id.kms.url,
      KMS_TOKEN_REF: 'env:K_T',
      K_T: s.id.kms.tokens['witness'] as string,
      CORE_KNOWLEDGE_URL: 'http://127.0.0.1:9',
      CORE_KNOWLEDGE_TOKEN_REF: 'env:KN_T',
      KN_T: tok('knowledge'),
      CORE_CODEHOST_URL: 'http://127.0.0.1:9',
      CORE_CODEHOST_TOKEN_REF: 'env:CH_T',
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
  await s?.stop();
});

describe('the core bundle with the cards wired', () => {
  it('serves the card routes (an unknown record is a 404, not "unavailable")', async () => {
    const res = await fetch(new URL(`/v1/s0/${randomUUID()}/cards`, base), {
      headers: { authorization: `Bearer ${tok('bff')}` },
    });
    expect(res.status, output).toBe(404);
    expect(output.includes(tok('knowledge'))).toBe(false);
  });
});
