import { randomBytes } from 'node:crypto';
import {
  STEP_UP_KEY_ID,
  STEP_UP_TTL_SECONDS,
  StepUpClaims,
  killActHash,
  type KillAct,
  type StepUpMethod,
} from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { newId, systemClock, type Clock } from '@aisdlc/kernel';
import {
  encodeStepUpToken,
  stepUpDigest,
  stepUpSigningInput,
  type KeyCustodyPort,
} from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { createKillswitchApp, type KillswitchScope } from './app.js';
import { HttpKillState, KillswitchClient } from './client.js';
import { migrateKillswitch } from './migrations.js';
import { PersonVerifier } from './person.js';
import { KillService } from './service.js';

/**
 * A caller of the kill switch in a test that names the person in each call, as the old API did: each
 * call mints that person's step-up proof for exactly that act (signed with the custody's
 * `dev:bff-stepup` key, as the bff would after a re-authentication) and sends it. The kill switch
 * still verifies every proof; only the minting is the test's.
 */
export interface TestKillswitchClient {
  readonly raw: KillswitchClient;
  kill(principal: string, scope: unknown, reason: string): ReturnType<KillswitchClient['kill']>;
  release(principal: string, kill_id: string): ReturnType<KillswitchClient['release']>;
  delegate(
    principal: string,
    delegate: string,
    scope: unknown,
  ): ReturnType<KillswitchClient['delegate']>;
  revoke(principal: string, delegation_id: string): ReturnType<KillswitchClient['revoke']>;
  capabilities: KillswitchClient['capabilities'];
  events: KillswitchClient['events'];
  syncHolders: KillswitchClient['syncHolders'];
}

export interface TestKillswitch {
  url: string;
  /** Its OWN database (not core's). */
  database: TestDatabase;
  service: KillService;
  tokens: Record<string, string>;
  /** A client as `caller` (`bff`, `core-worker` and `enforcer` exist) that mints proofs per call. */
  clientFor(caller: string): TestKillswitchClient;
  /** A person's step-up proof for `act`, as the bff issues it. */
  prove(principal: string, act: KillAct, o?: { method?: StepUpMethod }): Promise<string>;
  killState(caller?: string): HttpKillState;
  stop(): Promise<void>;
}

/** Signs a step-up proof with the custody's bff key: what `StepUpIssuer` does, for tests. */
export async function mintTestStepUpProof(
  custody: KeyCustodyPort,
  o: {
    principal: string;
    bound_hash: string;
    now: Date;
    method?: StepUpMethod;
    ttlSeconds?: number;
  },
): Promise<string> {
  const claims = StepUpClaims.parse({
    v: 1,
    proof_id: newId<'StepUpProof'>(o.now.getTime()),
    principal: o.principal,
    bound_hash: o.bound_hash,
    method: o.method ?? 'reauth',
    auth_time: o.now.toISOString(),
    issued_at: o.now.toISOString(),
    expires_at: new Date(
      o.now.getTime() + (o.ttlSeconds ?? STEP_UP_TTL_SECONDS) * 1000,
    ).toISOString(),
  });
  const sig = await custody.sign(STEP_UP_KEY_ID, stepUpDigest(stepUpSigningInput(claims)));
  if (!sig.ok) throw new Error(sig.error.message);
  return encodeStepUpToken(claims, sig.value);
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
  /** Who signs the test's step-up proofs (the bff's key custody). Default `custody`. */
  stepUpSigner?: KeyCustodyPort;
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
  const clock = opts.clock ?? systemClock;
  const service = new KillService({
    pool: database.pool,
    custody: opts.custody,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const persons = new PersonVerifier({
    pool: database.pool,
    custody: opts.custody,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const seeded = await service.seedFactoryAdmins(opts.admins ?? ['root']);
  if (!seeded.ok) throw new Error(seeded.error.message);
  const loaded = await persons.load();
  if (!loaded.ok) throw new Error(loaded.error.message);
  const app = createKillswitchApp({ service, persons, auth: new ServiceAuth(tokens), callers });
  const url = await listen(app);
  const prove = (principal: string, act: KillAct, o: { method?: StepUpMethod } = {}) =>
    mintTestStepUpProof(opts.stepUpSigner ?? opts.custody, {
      principal,
      bound_hash: killActHash(act),
      now: clock.now(),
      ...(o.method ? { method: o.method } : {}),
    });
  return {
    url,
    database,
    service,
    tokens,
    prove,
    clientFor: (caller) => {
      const raw = new KillswitchClient({ baseUrl: url, token: tokens[caller] as string });
      return {
        raw,
        kill: async (p, scope, reason) =>
          raw.kill(await prove(p, { action: 'kill.request', scope, reason }), scope, reason),
        release: async (p, kill_id) =>
          raw.release(await prove(p, { action: 'kill.release', kill_id }), kill_id),
        delegate: async (p, delegate, scope) =>
          raw.delegate(
            await prove(p, { action: 'kill.delegate', delegate, scope }),
            delegate,
            scope,
          ),
        revoke: async (p, delegation_id) =>
          raw.revoke(await prove(p, { action: 'kill.revoke', delegation_id }), delegation_id),
        capabilities: (...a) => raw.capabilities(...a),
        events: (...a) => raw.events(...a),
        syncHolders: (...a) => raw.syncHolders(...a),
      };
    },
    killState: (caller = 'enforcer') =>
      new HttpKillState({ baseUrl: url, token: tokens[caller] as string }),
    async stop() {
      await app.close();
      await database.drop();
    },
  };
}
