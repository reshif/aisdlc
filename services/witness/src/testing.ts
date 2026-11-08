import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import type { Clock } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createWitnessApp } from './app.js';
import { HttpWitness } from './client.js';
import { migrateWitness } from './migrations.js';
import { WitnessService } from './service.js';

export interface TestWitness {
  url: string;
  /** The Witness's own database. */
  database: TestDatabase;
  service: WitnessService;
  tokens: Record<string, string>;
  /** A client authenticated as `caller` (`checkpointer` is allowed, `core` is not). */
  clientFor(caller: string): HttpWitness;
  stop(): Promise<void>;
}

/** A real Witness service on a random loopback port with its own throwaway database. */
export async function startTestWitness(opts: {
  custody: KeyCustodyPort;
  clock?: Clock;
}): Promise<TestWitness> {
  const database = await createTestDatabase();
  await migrateWitness(database.pool);
  const tokens = {
    checkpointer: randomBytes(24).toString('hex'),
    core: randomBytes(24).toString('hex'),
  };
  const service = new WitnessService({
    pool: database.pool,
    custody: opts.custody,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const app = createWitnessApp({
    service,
    auth: new ServiceAuth(tokens),
    callers: ['checkpointer'],
  });
  const url = await listen(app);
  return {
    url,
    database,
    service,
    tokens,
    clientFor: (caller) =>
      new HttpWitness({ baseUrl: url, token: tokens[caller as keyof typeof tokens] as string }),
    async stop() {
      await app.close();
      await database.drop();
    },
  };
}
