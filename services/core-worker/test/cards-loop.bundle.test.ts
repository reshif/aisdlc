import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { startCoreStack, type CoreStack } from '@aisdlc/core/testing';
import { dbUrlRef } from '@aisdlc/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The onboarding cards loop in the core-worker bundle (PLAN M8.0): switched on by the Notary, the
// key lookup and knowledge together, and refused (exit 78) when the Notary is given without
// knowledge, so a half-wired worker never starts. No S0 record exists here, so the loop has nothing
// to open; what is proved is that the process wires the Notary client and the card dependencies
// (the public key of the Notary is fetched from a real kms-local at start) and supervises the loop.

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'core-worker', 'dist', 'main.js');
const tok = (n: string) => `${n}-token-`.padEnd(32, 'x');

let s: CoreStack;
let child: ChildProcess | undefined;
let output = '';

beforeAll(async () => {
  s = await startCoreStack();
}, 60_000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await s?.stop();
});

const wired = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  ...dbUrlRef('CORE_WORKER_DATABASE_URL', s.record.url),
  CORE_WORKER_CODEHOST_URL: 'http://127.0.0.1:9',
  CORE_WORKER_CODEHOST_TOKEN_REF: 'env:CW_CODEHOST',
  CW_CODEHOST: tok('codehost'),
  CORE_WORKER_KNOWLEDGE_URL: 'http://127.0.0.1:9',
  CORE_WORKER_KNOWLEDGE_TOKEN_REF: 'env:CW_KNOWLEDGE',
  CW_KNOWLEDGE: tok('knowledge'),
  CORE_WORKER_NOTARY_URL: s.id.notary.url,
  CORE_WORKER_NOTARY_TOKEN_REF: 'env:CW_NOTARY',
  CW_NOTARY: s.id.notary.tokens['core'] as string,
  KMS_URL: s.id.kms.url,
  KMS_TOKEN_REF: 'env:CW_KMS',
  // Reading a public key needs any authenticated caller.
  CW_KMS: s.id.kms.tokens['witness'] as string,
  // The ledger loops (M8.0b): nothing listens here, so their rounds fail and back off; what is
  // proved is that the worker wires and supervises them.
  CORE_WORKER_WITNESS_URL: 'http://127.0.0.1:9',
  CORE_WORKER_WITNESS_TOKEN_REF: 'env:CW_WITNESS',
  CW_WITNESS: tok('witness'),
  CORE_WORKER_PORT: '0',
});

describe('core-worker: the onboarding cards loop', () => {
  it('refuses a Notary without knowledge (the cards need both)', () => {
    const env = wired();
    delete env['CORE_WORKER_KNOWLEDGE_URL'];
    const r = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/CORE_WORKER_NOTARY_URL is for the onboarding cards/);
  });

  it('refuses a Witness without a Notary (the checkpointer needs both)', () => {
    const env: Record<string, string> = {
      ...wired(),
      CORE_WORKER_WITNESS_URL: 'http://127.0.0.1:9',
      CORE_WORKER_WITNESS_TOKEN_REF: 'env:CW_WITNESS',
      CW_WITNESS: tok('witness'),
    };
    delete env['CORE_WORKER_NOTARY_URL'];
    delete env['CORE_WORKER_KNOWLEDGE_URL'];
    const r = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/CORE_WORKER_WITNESS_URL checkpoints the Notary ledger/);
  });

  it('runs the loop when the Notary, the key lookup and knowledge are configured', async () => {
    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: wired(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`did not start:\n${output}`)), 20_000);
      const poll = setInterval(() => {
        const m = /core-worker listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`exited ${code}:\n${output}`)));
    });
    const body = (await (await fetch(new URL('/healthz', base))).json()) as {
      loops: Array<{ name: string }>;
    };
    expect(body.loops.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        'onboarding_cards',
        's0_driver',
        'ledger_reconciler',
        'checkpointer',
      ]),
    );
    expect(output.includes(wired()['CW_NOTARY'] as string)).toBe(false);
    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 60_000);
});
