import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { type Clock } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createNotaryApp, type NotaryScope } from './app.js';
import { HttpNotary } from './client.js';
import { migrateNotary } from './migrations.js';
import { NotaryService } from './service.js';

export interface TestNotary {
  url: string;
  /** The Notary's own database. */
  database: TestDatabase;
  service: NotaryService;
  tokens: Record<string, string>;
  /** A client authenticated as `caller` (`core`, `checkpointer` and `tester` exist). */
  clientFor(caller: string): HttpNotary;
  stop(): Promise<void>;
}

/** A real Notary service on a random loopback port with its own throwaway database. */
export async function startTestNotary(opts: {
  custody: KeyCustodyPort;
  clock?: Clock;
  callers?: Record<string, readonly NotaryScope[]>;
}): Promise<TestNotary> {
  const database = await createTestDatabase();
  await migrateNotary(database.pool);
  const callers = opts.callers ?? {
    core: ['ledger', 'read', 'evidence'],
    checkpointer: ['checkpoint', 'read'],
    audit: ['ledger', 'read', 'audit_export'],
    /** Every scope, for conformance tests only. */
    tester: ['ledger', 'checkpoint', 'read', 'evidence', 'audit_export'],
  };
  const tokens = Object.fromEntries(
    Object.keys(callers).map((c) => [c, randomBytes(24).toString('hex')]),
  );
  const service = new NotaryService({
    pool: database.pool,
    custody: opts.custody,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const app = createNotaryApp({ service, auth: new ServiceAuth(tokens), callers });
  const url = await listen(app);
  return {
    url,
    database,
    service,
    tokens,
    clientFor: (caller) => new HttpNotary({ baseUrl: url, token: tokens[caller] as string }),
    async stop() {
      await app.close();
      await database.drop();
    },
  };
}
