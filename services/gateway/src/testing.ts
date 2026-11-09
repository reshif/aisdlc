import { randomBytes } from 'node:crypto';
import {
  GATEWAY_CONFIG_KEYS,
  INTEGRATION_CONFIG_KEYS,
  type GatewayEnvironment,
  type GatewayModel,
  type GatewayRoute,
  type Integration,
  type IntegrationInstall,
  type VKeyMint,
  type VKeyView,
} from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { modelProviderRow } from '@aisdlc/integrations';
import { manualClock, type ManualClock } from '@aisdlc/kernel';
import {
  FakeKillState,
  FakeProvider,
  type KillStatePort,
  type ModelProviderPort,
} from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { GatewayAdminClient } from './client.js';
import { createGatewayApp, type GatewayScope } from './app.js';
import { migrateGateway } from './migrations.js';
import type { ConfigSource } from './routes.js';
import { GatewayService } from './service.js';

/** A `ConfigSource` a test sets by hand: the routing document as a published revision would give it. */
export class StaticConfig implements ConfigSource {
  private values: Record<string, unknown> = {};
  private rev = 0;

  constructor(doc: Partial<RoutingDoc> = {}) {
    this.set(doc);
  }

  /** Replaces the routing table, as a newly published revision does. */
  set(doc: Partial<RoutingDoc>): void {
    this.rev += 1;
    this.values = {
      [INTEGRATION_CONFIG_KEYS.registry]: doc.providers ?? [],
      [INTEGRATION_CONFIG_KEYS.installs]: doc.installs ?? [],
      [GATEWAY_CONFIG_KEYS.models]: doc.models ?? [],
      [GATEWAY_CONFIG_KEYS.routes]: doc.routes ?? [],
    };
  }

  current() {
    const values = this.values;
    return {
      get: <T = unknown>(key: string) => values[key] as T | undefined,
      token: `static-${this.rev}`,
      revisions: { factory: `rev-${this.rev}` },
    };
  }
}

export interface RoutingDoc {
  /** The model providers, as rows of the integration registry. */
  providers: Integration[];
  installs: IntegrationInstall[];
  models: GatewayModel[];
  routes: GatewayRoute[];
}

/** The fake model of the test routing table: priced 1 micro-USD an input token and 2 an output token. */
export const FAKE_MODEL: GatewayModel = {
  model_id: 'fake-model',
  provider_id: 'fake',
  provider_model: 'fake-model-1',
  tools_capable: true,
  max_tokens_cap: 4096,
  usd_in_per_mtok: 1,
  usd_out_per_mtok: 2,
};

/** A routing table with the fake provider and routes for D0, D1 and D2 in `environment`. */
export function fakeRouting(environment: GatewayEnvironment = 'local'): RoutingDoc {
  return {
    providers: [modelProviderRow('fake', 'fake')],
    installs: [],
    models: [FAKE_MODEL],
    routes: (['D0', 'D1', 'D2'] as const).map((data_class) => ({
      environment,
      data_class,
      model_id: FAKE_MODEL.model_id,
    })),
  };
}

/** A parsed response body of a test call, indexed freely by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test helper: the shape under test is what the test asserts
export type Wire = Record<string, any>;

export interface TestGateway {
  /** The gateway's HTTP address. */
  url: string;
  /** The record database the gateway shares (record and gateway schemas). */
  database: TestDatabase;
  service: GatewayService;
  config: StaticConfig;
  provider: FakeProvider;
  kill: FakeKillState;
  clock: ManualClock;
  /** Service tokens by caller: `core` (admin, read) and `observer` (read). */
  tokens: Record<string, string>;
  admin(caller?: string): GatewayAdminClient;
  /** Creates a budget group (unless it exists) and mints a key on it. The secret is in `key`. */
  mint(
    over?: Partial<VKeyMint> & { budget?: { max_tokens: number; max_cost_micro_usd: number } },
  ): Promise<{
    key: string;
    vkey: VKeyView;
  }>;
  /** `POST /v1/messages` as the holder of `key`. */
  messages(
    key: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Wire }>;
  stop(): Promise<void>;
}

export const T0 = '2026-11-09T10:00:00.000Z';

/**
 * A real gateway on a random loopback port with its own throwaway database (record and gateway
 * schemas, real Postgres), the fake provider behind the `fake` provider id, a hand-set routing table
 * and a fake kill switch. Nothing leaves the process.
 */
export async function startTestGateway(
  opts: {
    environment?: GatewayEnvironment;
    routing?: Partial<RoutingDoc>;
    maxProviderCalls?: number;
    reservationMaxAgeMs?: number;
    adapters?: Record<string, ModelProviderPort>;
    config?: ConfigSource;
    callers?: Record<string, readonly GatewayScope[]>;
    /** Share an existing record database (the caller drops it) instead of making one. */
    database?: TestDatabase;
    /** A kill switch other than the in-memory fake (a real service over HTTP). */
    kill?: KillStatePort;
  } = {},
): Promise<TestGateway> {
  const environment = opts.environment ?? 'local';
  const database = opts.database ?? (await createTestDatabase());
  try {
    await migrateRecord(database.pool);
    await migrateGateway(database.pool);
  } catch (e) {
    if (!opts.database) await database.drop();
    throw e;
  }
  const clock = manualClock(T0);
  const config = new StaticConfig(opts.routing ?? fakeRouting(environment));
  const provider = new FakeProvider();
  const kill = new FakeKillState(() => clock.now());
  const adapters = new Map<string, ModelProviderPort>([
    ['fake', provider],
    ...Object.entries(opts.adapters ?? {}),
  ]);
  const service = new GatewayService({
    pool: database.pool,
    config: opts.config ?? config,
    adapters,
    kill: opts.kill ?? kill,
    environment,
    maxProviderCalls: opts.maxProviderCalls ?? 1000,
    ...(opts.reservationMaxAgeMs ? { reservationMaxAgeMs: opts.reservationMaxAgeMs } : {}),
    clock,
  });
  const callers = opts.callers ?? { core: ['admin', 'read'], observer: ['read'] };
  const tokens = Object.fromEntries(
    Object.keys(callers).map((c) => [c, randomBytes(24).toString('hex')]),
  );
  const app = createGatewayApp({ service, auth: new ServiceAuth(tokens), callers });
  const url = await listen(app);
  let n = 0;
  const gw: TestGateway = {
    url,
    database,
    service,
    config,
    provider,
    kill,
    clock,
    tokens,
    admin: (caller = 'core') =>
      new GatewayAdminClient({ baseUrl: url, token: tokens[caller] as string }),
    async mint(over = {}) {
      n += 1;
      const { budget, ...rest } = over;
      const group = rest.budget_group ?? `group-${n}`;
      const g = await service.createBudgetGroup({
        group_id: group,
        max_tokens: budget?.max_tokens ?? 100_000,
        max_cost_micro_usd: budget?.max_cost_micro_usd ?? 10_000_000,
      });
      if (!g.ok) throw new Error(g.error.message);
      const r = await service.mintVKey(
        {
          scope: { kind: 'unit', ref: `unit-${n}` },
          project_id: 'testbed',
          data_class_max: 'D2',
          models: [FAKE_MODEL.model_id],
          tools: ['read_file'],
          budget_group: group,
          expires_at: new Date(clock.nowMs() + 3_600_000).toISOString(),
          item_id: `item-${n}`,
          unit_id: `unit-${n}`,
          step: '6.4',
          ...rest,
        },
        'core',
      );
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
    async messages(key, body, headers = {}) {
      const res = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Wire };
    },
    async stop() {
      await app.close();
      if (!opts.database) await database.drop();
    },
  };
  return gw;
}

/** A minimal valid Messages body. */
export const hello = (over: Record<string, unknown> = {}) => ({
  model: 'anything',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'say hello' }],
  ...over,
});
