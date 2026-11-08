import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createKmsApp } from './app.js';
import { HttpKeyCustody } from './client.js';
import { DEFAULT_KEY_ALLOW_LIST } from './keys.js';

export interface TestKms {
  url: string;
  dir: string;
  /** Service token per caller: notary, witness, knowledge. */
  tokens: Record<string, string>;
  /** A key-custody client authenticated as `caller`. */
  custodyFor(caller: string): HttpKeyCustody;
  stop(): Promise<void>;
}

/** A real kms-local on a random loopback port with a throwaway key directory. */
export async function startTestKms(
  opts: { factoryEnv?: string; dir?: string } = {},
): Promise<TestKms> {
  const ownDir = opts.dir === undefined;
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'aisdlc-kms-'));
  const tokens = Object.fromEntries(
    Object.keys(DEFAULT_KEY_ALLOW_LIST).map((c) => [c, randomBytes(24).toString('hex')]),
  );
  const app = createKmsApp({
    dir,
    factoryEnv: opts.factoryEnv ?? 'local',
    auth: new ServiceAuth(tokens),
    allow: DEFAULT_KEY_ALLOW_LIST,
  });
  const url = await listen(app);
  return {
    url,
    dir,
    tokens,
    custodyFor: (caller) => new HttpKeyCustody({ baseUrl: url, token: tokens[caller] as string }),
    async stop() {
      await app.close();
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
