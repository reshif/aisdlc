import { PDP_CONFIG_KEY, FACTORY_SCOPE } from '@aisdlc/contracts';
import { configProjection, loadEffective } from '@aisdlc/config';
import { startTestIdentityApi } from '@aisdlc/identity/testing';
import { Pdp, ConfigBundleSource, buildBundle, registerPdpConfig } from '@aisdlc/pdp';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { ConfigReader, ConfigRegistry } from '@aisdlc/config';
import { pdpResource } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrlRef } from '@aisdlc/db/testing';
import { localGatewayRouting, runSeed, seedConfigFromEnv, seedRoutingDoc } from '../src/seed.js';
import { registerCoreConfig } from '../src/settings.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';

// The first-run seed (PLAN M8.0) against a real identity service, Notary and kms-local: after it,
// the factory admin can ask for an onboarding (the PDP, reading the published bundle, allows it),
// a second run changes nothing, and it refuses to run outside a local factory.

let s: CoreStack;
let identity: Awaited<ReturnType<typeof startTestIdentityApi>>;
let env: Record<string, string>;
const logs: string[] = [];
const tok = 'seed-identity-token'.padEnd(32, 'x');

beforeAll(async () => {
  s = await startCoreStack();
  s.id.clock.set(new Date());
  s.id.idp.set({
    issuer: 'local-test',
    groups: [],
    subjects: [
      {
        issuer: 'local-test',
        subject: 'sub-root',
        principal_id: pr('root'),
        kind: 'human',
        status: 'active',
        upn: null,
        display_handle: 'root',
        display_name: 'Root Admin',
        logins: [],
        groups: [],
      },
    ],
  });
  identity = await startTestIdentityApi(
    s.id,
    { seed: { token: tok, scopes: ['read', 'write', 'sync'] } },
    { withIdp: true, withLedger: true },
  );
  const url = identity.url;
  env = {
    FACTORY_ENV: 'local',
    ...dbUrlRef('CORE_DATABASE_URL', s.record.url),
    CORE_NOTARY_URL: s.id.notary.url,
    CORE_NOTARY_TOKEN_REF: 'env:SEED_NOTARY',
    SEED_NOTARY: s.id.notary.tokens['core'] as string,
    KMS_URL: s.id.kms.url,
    KMS_TOKEN_REF: 'env:SEED_KMS',
    SEED_KMS: s.id.kms.tokens['witness'] as string,
    SEED_IDENTITY_URL: url,
    SEED_IDENTITY_TOKEN_REF: 'env:SEED_ID',
    SEED_ID: tok,
    SEED_FACTORY_ADMIN: 'root',
    // the GitHub App as the compose seed registers it: ids and a key REFERENCE
    SEED_GITHUB_APP_ID: '123456',
    SEED_GITHUB_INSTALLATION_ID: '1',
    SEED_GITHUB_APP_KEY_REF: 'file:/run/secrets/github-app.pem',
    SEED_GITHUB_API_URL: 'http://127.0.0.1:8353',
    SEED_GITHUB_GIT_URL: 'http://127.0.0.1:8354',
  };
}, 60_000);

afterAll(async () => {
  await identity?.stop();
  await s?.stop();
});

const ledgerCount = async () =>
  (await s.record.pool.query('SELECT count(*)::int AS n FROM ledger.ledger_entry')).rows[0].n;

describe('aisdlc-seed', () => {
  it('refuses to run outside a local factory, and without an admin', () => {
    expect(() => seedConfigFromEnv({ ...env, FACTORY_ENV: 'prod' })).toThrow(/FACTORY_ENV=local/);
    expect(() => seedConfigFromEnv({ ...env, SEED_FACTORY_ADMIN: '' })).toThrow(
      /SEED_FACTORY_ADMIN/,
    );
  });

  it('makes the admin a factory.admin and publishes the policy bundle, once', async () => {
    expect(
      await runSeed(
        env,
        (l) => logs.push(l),
        (l) => logs.push(`ERR ${l}`),
      ),
    ).toBe(0);
    expect(logs.join('\n')).toMatch(/root is a factory.admin/);
    expect(logs.join('\n')).toMatch(/policy bundle .* published/);

    await runProjection(s.record.pool, configProjection);
    const eff = await loadEffective(s.record.pool, { layer: 'factory', scope: FACTORY_SCOPE });
    expect((eff?.doc[PDP_CONFIG_KEY] as { bundle_hash: string }).bundle_hash).toBe(
      buildBundle().bundle_hash,
    );

    // The model gateway's local routing table went through its M1 gate too: D0-D2 in local, no D3.
    expect(logs.join('\n')).toMatch(/local gateway routing table published/);
    const routes = eff?.doc['gateway.routes'] as Array<{ environment: string; data_class: string }>;
    expect(routes.map((r) => `${r.environment}/${r.data_class}`)).toEqual([
      'local/D0',
      'local/D1',
      'local/D2',
    ]);

    // And the first rows of the integration registry: the model providers that were already configured and
    // the GitHub App (a code host, adapter github_app), with key REFERENCES only.
    const rows = eff?.doc['integrations.registry'] as Array<{
      integration_id: string;
      kind: string;
      adapter: string;
      status: string;
      credentials: Array<{ secret_ref: string }>;
    }>;
    expect(rows.map((r) => `${r.integration_id}:${r.kind}:${r.adapter}:${r.status}`)).toEqual([
      'fake:model_provider:fake:enabled',
      'anthropic:model_provider:anthropic:enabled',
      'github-app:code_host:github_app:enabled',
    ]);
    expect(rows.flatMap((r) => r.credentials.map((c) => c.secret_ref))).toEqual([
      'file:/run/secrets/anthropic-api-key',
      'file:/run/secrets/github-app.pem',
    ]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE KEY');
    expect(() => seedConfigFromEnv({ ...env, SEED_GITHUB_INSTALLATION_ID: 'x' })).toThrow(
      /INSTALLATION_ID/,
    );

    // The PDP, reading what the seed published, lets the admin ask for an onboarding and nobody else.
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: registerCoreConfig(registerPdpConfig(new ConfigRegistry())),
    });
    try {
      await reader.start();
      const pdp = new Pdp({
        source: new ConfigBundleSource(reader),
        entities: new IdentityPdpEntities({ pool: s.record.pool }),
      });
      const can = async (who: string) =>
        (
          await pdp.decide(
            { principal: who, action: 'project.onboard', resource: pdpResource.fleet() },
            { log: false },
          )
        ).decision;
      expect(await can('root')).toBe('allow');
      expect(await can('nobody')).toBe('deny');
    } finally {
      await reader.stop();
    }
  });

  it('changes nothing the second time', async () => {
    const before = await ledgerCount();
    const again: string[] = [];
    expect(
      await runSeed(
        env,
        (l) => again.push(l),
        (l) => again.push(`ERR ${l}`),
      ),
    ).toBe(0);
    expect(again.join('\n')).toMatch(/already holds factory.admin/);
    expect(again.join('\n')).toMatch(/already effective/);
    expect(again.join('\n')).toMatch(/routing table is already effective/);
    expect(await ledgerCount()).toBe(before);
  });
});

describe("the seed and the owner's routing decision", () => {
  it('seeds the models and the routes only while none are effective, and always reconciles the registry', () => {
    const seeded = localGatewayRouting(null) as unknown as Parameters<typeof seedRoutingDoc>[1];
    // first run: nothing effective, everything seeded
    expect(seedRoutingDoc({}, seeded)).toEqual(seeded);
    // a later run, after the owner pointed D2 at Claude through M1: the routes (and models) stay as decided
    const decided = [{ environment: 'local', data_class: 'D2', model_id: 'claude-sonnet-5-5' }];
    const models = [{ model_id: 'claude-sonnet-5-5' }];
    const next = seedRoutingDoc(
      { 'gateway.routes': decided, 'gateway.models': models, 'integrations.registry': [] },
      seeded,
    );
    expect(next['gateway.routes']).toEqual(decided);
    expect(next['gateway.models']).toEqual(models);
    expect(next['integrations.registry']).toEqual(seeded['integrations.registry']);
  });
});
