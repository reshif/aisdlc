import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { type Clock } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createKillswitchApp, type KillswitchScope } from './app.js';
import { HttpKillState, KillswitchClient } from './client.js';
import { migrateKillswitch } from './migrations.js';
import { KillService } from './service.js';

export interface TestKillswitch {
  url: string;
  /** Its OWN database (not core's). */
  database: TestDatabase;
  service: KillService;
  tokens: Record<string, string>;
  /** A client as `caller` (`bff`, `core-worker` and `enforcer` exist). */
  clientFor(caller: string): KillswitchClient;
  killState(caller?: string): HttpKillState;
  stop(): Promise<void>;
}

/**
 * A real kill switch service on a random loopback port with its own throwaway database and nothing of
 * core's. `admins` are the factory admins it is configured with.
 */
export async function startTestKillswitch(opts: {
  custody: KeyCustodyPort;
  clock?: Clock;
  admins?: string[];
  callers?: Record<string, readonly KillswitchScope[]>;
}): Promise<TestKillswitch> {
  const database = await createTestDatabase();
  await migrateKillswitch(database.pool);
  const callers = opts.callers ?? {
    bff: ['act', 'read'],
    'core-worker': ['read', 'sync'],
    enforcer: ['read'],
  };
  const tokens = Object.fromEntries(
    Object.keys(callers).map((c) => [c, randomBytes(24).toString('hex')]),
  );
  const service = new KillService({
    pool: database.pool,
    custody: opts.custody,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const seeded = await service.seedFactoryAdmins(opts.admins ?? ['root']);
  if (!seeded.ok) throw new Error(seeded.error.message);
  const app = createKillswitchApp({ service, auth: new ServiceAuth(tokens), callers });
  const url = await listen(app);
  return {
    url,
    database,
    service,
    tokens,
    clientFor: (caller) => new KillswitchClient({ baseUrl: url, token: tokens[caller] as string }),
    killState: (caller = 'enforcer') =>
      new HttpKillState({ baseUrl: url, token: tokens[caller] as string }),
    async stop() {
      await app.close();
      await database.drop();
    },
  };
}
