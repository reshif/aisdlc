import {
  ConfigRegistry,
  registerGatewayConfig,
  configProjection,
  configPublish,
  loadEffective,
  proposeRevision,
} from '@aisdlc/config';
import type { ConfigDeps } from '@aisdlc/config';
import {
  ANTHROPIC_DEFAULT_MODELS,
  DEFAULT_LIGHT_TESTS,
  FACTORY_SCOPE,
  ONBOARDING_LIGHT_TESTS_KEY,
  ONBOARDING_SANDBOX_IMAGE_KEY,
  RepoFullName,
  SANDBOX_EXEC_ALLOWED_REPOS_KEY,
  SandboxImageRef,
  Sha256Hex,
  GATEWAY_CONFIG_KEYS,
  INTEGRATION_CONFIG_KEYS,
  PDP_CONFIG_KEY,
  type JsonObject,
  PrincipalId,
  ProjectId,
  type RoleSlot,
} from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import {
  PortError,
  decide,
  prepare,
  recordEvidenceViewed,
  type EligibilityPort,
  type StepUpPort,
} from '@aisdlc/decisions';
import { PERSONA_GROUPS } from '@aisdlc/bff/dev-oidc';
import { codeHostRow, modelProviderRow } from '@aisdlc/integrations';
import { canonicalJson, err, ok } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { buildBundle, registerPdpConfig, verifyBundle } from '@aisdlc/pdp';
import { runProjection } from '@aisdlc/record';
import {
  EXIT_CONFIG,
  ServiceConfigError,
  callJson,
  databaseUrl,
  httpUrlEnv,
  requiredEnv,
  resolveSecretRef,
  type Env,
} from '@aisdlc/service-kit';
import { registerCoreConfig } from './settings.js';

// aisdlc-seed: the first-run bootstrap of a LOCAL factory (PLAN M8.0). A factory with nobody who
// may do anything and no policy bundle denies every decision, and the bundle can only be published
// through an M1 gate that somebody must be eligible to decide. This one-shot job breaks that
// circle once, in the open:
//
//   1. identity: sync the identity provider seed (the dev principals), then put the factory admin
//      in the `grp-factory-admins` group bound to the `factory.admin` role at fleet scope. Every
//      step is a write through identity's own API and so a journal event; nothing is skipped
//      when it is already in place. With `SEED_PERSONAS=1` (compose), the design personas' IdP
//      groups (`PERSONA_GROUPS`, @aisdlc/bff/dev-oidc) are bound to their roles too: fleet and team
//      roles and the direct project viewers. Project slot roles come only from a published role
//      map, so they are not seeded here (`personaRoleMap` is what a design project would carry).
//   2. the policy bundle: proposed as the factory-layer `pdp.bundle` revision, decided at its M1
//      gate by that admin and published. The decision is a real ledger entry signed by the
//      Notary. The one thing not real is who clicked: the genesis eligibility below names the
//      admin as the sole `admin` of the `factory` pseudo-project and its step-up refuses everything,
//      so a gate that needed a step-up would fail the seed rather than pass it.
//
// It refuses to run unless FACTORY_ENV=local and is the local-prod stub of "the first admin is
// provisioned in the cloud account" (RV §7). Re-running it changes nothing once the admin has the
// role and the current bundle is the effective one.

const FACTORY = ProjectId.parse('factory');

/**
 * Local-prod's model routing table. Prices are placeholders to be reviewed before any real spend
 * (USD per million tokens); they only feed the budget meter.
 */
const claude = (model_id: string, usd_in_per_mtok: number, usd_out_per_mtok: number) => ({
  model_id,
  provider_id: 'anthropic',
  provider_model: model_id,
  tools_capable: true,
  max_tokens_cap: 32_000,
  usd_in_per_mtok,
  usd_out_per_mtok,
});

/** The GitHub App as the seed registers it (all from the compose settings; the KEY is a reference, never a value). */
export interface SeedGithub {
  readonly app_id: string;
  readonly installation_id: number;
  readonly api_url?: string;
  readonly git_url?: string;
  readonly key_ref: string;
}

/**
 * The first rows of the integration registry (PLAN M10.4): the model providers that were already
 * configured (the deterministic fake and Anthropic, whose key stays in the gateway's own file) and, when
 * the seed is told about one, the GitHub App (a code host, adapter `github_app`, key reference only).
 */
export function localIntegrationRegistry(
  github: SeedGithub | null,
  fixtures: 'planning' | 'testbed' = 'planning',
) {
  return [
    modelProviderRow('fake', 'fake', {
      display_name: 'Deterministic fake (local only)',
      // answers the planning steps with canned valid outputs, so a local stack can run S1 to S5 without a model;
      // `testbed` (the request-to-PR e2e) also scripts the coding sessions and the S7 reviews for the fake testbed
      config: { fixtures },
    }),
    modelProviderRow('anthropic', 'anthropic', {
      display_name: 'Anthropic',
      credentials: [
        {
          credential_id: 'anthropic-api-key',
          secret_ref: 'file:/run/secrets/anthropic-api-key',
          kind: 'api_key',
        },
      ],
    }),
    ...(github
      ? [
          codeHostRow(
            'github-app',
            'github_app',
            {
              app_id: github.app_id,
              installation_id: github.installation_id,
              ...(github.api_url ? { api_url: github.api_url } : {}),
              ...(github.git_url ? { git_url: github.git_url } : {}),
              mode: 'census',
            },
            {
              display_name: 'GitHub App',
              credentials: [
                { credential_id: 'app-key', secret_ref: github.key_ref, kind: 'app_key' },
              ],
            },
          ),
        ]
      : []),
  ];
}

export const localGatewayRouting = (
  github: SeedGithub | null,
  fixtures: 'planning' | 'testbed' = 'planning',
) => ({
  [INTEGRATION_CONFIG_KEYS.registry]: localIntegrationRegistry(github, fixtures),
  [GATEWAY_CONFIG_KEYS.models]: [
    {
      model_id: 'fake-model',
      provider_id: 'fake',
      provider_model: 'fake-model-1',
      tools_capable: true,
      max_tokens_cap: 4_096,
      usd_in_per_mtok: 1,
      usd_out_per_mtok: 2,
    },
    claude(ANTHROPIC_DEFAULT_MODELS.opus, 15, 75),
    claude(ANTHROPIC_DEFAULT_MODELS.sonnet, 3, 15),
    claude(ANTHROPIC_DEFAULT_MODELS.haiku, 1, 5),
  ],
  [GATEWAY_CONFIG_KEYS.routes]: (['D0', 'D1', 'D2'] as const).map((data_class) => ({
    environment: 'local',
    data_class,
    model_id: 'fake-model',
  })),
});
const SLOTS: readonly RoleSlot[] = [
  'admin',
  'requesters',
  'intent',
  'design',
  'g4',
  'g5',
  'x',
  'sec',
  'm4',
  'kill',
];

/** The admin is the only holder of any slot of the `factory` pseudo-project; everything else is unknown. */
class GenesisEligibility implements EligibilityPort {
  constructor(private readonly admin: PrincipalId) {}
  async holders(project: ProjectId, slot: RoleSlot) {
    if (project !== FACTORY || !SLOTS.includes(slot)) {
      return err(PortError({ message: `genesis eligibility knows only ${FACTORY}` }));
    }
    return ok(slot === 'admin' ? [this.admin] : ([] as readonly PrincipalId[]));
  }
  async policy(project: ProjectId) {
    if (project !== FACTORY) return err(PortError({ message: `unknown project ${project}` }));
    return ok({
      tier: 'T1' as const,
      two_person: { enabled: true, default: 'on_if_2plus' as const, locked_on: false },
    });
  }
}

class NoStepUp implements StepUpPort {
  async verify() {
    return err(PortError({ message: 'the seed has no step-up' }));
  }
}

interface SeedConfig {
  readonly admin: PrincipalId;
  readonly group: string;
  readonly identityUrl: string;
  readonly identityToken: string;
  /** `SEED_GITHUB_*`: the GitHub App row of the registry; null: no code host is registered. */
  readonly github: SeedGithub | null;
  /** The local stack's sandbox settings (`seedSandboxFromEnv`); `null`: the seed publishes none. */
  readonly sandbox: SeedSandbox | null;
  /** `SEED_FAKE_FIXTURES`: which canned answers the local fake provider gives (`planning`, the default, or `testbed`). */
  readonly fixtures: 'planning' | 'testbed';
  /** `SEED_PERSONAS=1`: bind the design personas' IdP groups to their roles (`PERSONA_GROUPS`). */
  readonly personas: boolean;
}

/**
 *   SEED_GITHUB_APP_ID, SEED_GITHUB_INSTALLATION_ID, SEED_GITHUB_APP_KEY_REF (a `file:` reference),
 *   SEED_GITHUB_API_URL, SEED_GITHUB_GIT_URL (empty: GitHub's own)
 * Without an app id the registry gets no code host row.
 */
function seedGithub(env: Env): SeedGithub | null {
  const id = env['SEED_GITHUB_APP_ID'];
  if (id === undefined || id === '') return null;
  const installation = Number(requiredEnv(env, 'SEED_GITHUB_INSTALLATION_ID'));
  if (!Number.isInteger(installation) || installation < 1) {
    throw new ServiceConfigError('SEED_GITHUB_INSTALLATION_ID must be a positive integer');
  }
  const ref = requiredEnv(env, 'SEED_GITHUB_APP_KEY_REF');
  const api = env['SEED_GITHUB_API_URL'];
  const git = env['SEED_GITHUB_GIT_URL'];
  return {
    app_id: id,
    installation_id: installation,
    key_ref: ref,
    ...(api ? { api_url: api } : {}),
    ...(git ? { git_url: git } : {}),
  };
}

export function seedConfigFromEnv(env: Env): SeedConfig {
  if (env['FACTORY_ENV'] !== 'local') {
    throw new ServiceConfigError('the seed runs only with FACTORY_ENV=local');
  }
  const admin = PrincipalId.safeParse(requiredEnv(env, 'SEED_FACTORY_ADMIN'));
  if (!admin.success) throw new ServiceConfigError('SEED_FACTORY_ADMIN is not a principal id');
  return {
    admin: admin.data,
    group: env['SEED_FACTORY_ADMIN_GROUP'] || 'grp-factory-admins',
    identityUrl: httpUrlEnv(env, 'SEED_IDENTITY_URL'),
    identityToken: resolveSecretRef(requiredEnv(env, 'SEED_IDENTITY_TOKEN_REF'), { env }),
    github: seedGithub(env),
    personas: env['SEED_PERSONAS'] === '1',
    sandbox: seedSandboxFromEnv(env),
    fixtures: fixturesOf(env['SEED_FAKE_FIXTURES']),
  };
}

/** The identity part of the seed (the IdP sync, the factory admin, the personas); idempotent. */
export async function seedIdentity(
  cfg: Pick<SeedConfig, 'admin' | 'group' | 'identityUrl' | 'identityToken' | 'personas'>,
  log: (l: string) => void,
  now: () => Date = () => new Date(),
): Promise<void> {
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    callJson({
      baseUrl: cfg.identityUrl,
      token: cfg.identityToken,
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
  const must = async (
    what: string,
    r: Awaited<ReturnType<typeof call>>,
    tolerate: number[] = [],
  ) => {
    if (!r.reached) throw new Error(`identity: ${what}: no answer`);
    if (r.status >= 200 && r.status < 300) return;
    if (tolerate.includes(r.status)) return;
    throw new Error(`identity: ${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  };

  await must('idp sync', await call('POST', '/v1/idp/sync', {}));
  const held = await call(
    'GET',
    `/v1/principals/${encodeURIComponent(cfg.admin)}/bindings?scope=${encodeURIComponent(`${FACTORY_SCOPE.kind}:${FACTORY_SCOPE.ref}`)}`,
  );
  await must('read bindings', held);
  const body = held.reached
    ? (held.json as { bindings?: Array<{ role_id?: string }> } | null)
    : null;
  const bindings = body?.bindings;
  if (bindings?.some((b) => b.role_id === 'factory.admin')) {
    log(`seed: ${cfg.admin} already holds factory.admin`);
  } else {
    await adminStepOf(cfg, call, must, log);
  }
  if (cfg.personas) await personaStep();

  async function personaStep() {
    // each group exists by now (the IdP sync made it with its members); its binding is the seed's. `already_exists` is
    // a binding in place from an earlier run (a guest's keeps the expiry that run set); any other refusal fails.
    for (const g of PERSONA_GROUPS) {
      const expiry =
        g.expires_in_days === null
          ? null
          : new Date(now().getTime() + g.expires_in_days * 86_400_000).toISOString();
      const r = await call('POST', '/v1/bindings', {
        group_id: g.group_id,
        role_id: g.role,
        scope: g.scope,
        ...(expiry === null ? {} : { expiry }),
      });
      const code = r.reached
        ? (r.json as { error?: { code?: unknown } } | null)?.error?.code
        : undefined;
      if (r.reached && r.status === 409 && code === 'already_exists') continue;
      await must(`bind ${g.group_id}`, r);
    }
    log(`seed: the design personas' groups are bound (${PERSONA_GROUPS.length})`);
  }
}

/** The local stack's sandbox settings the seed publishes (each optional). */
export interface SeedSandbox {
  readonly exec_allowed_repos: readonly string[] | null;
  readonly onboarding_image: { readonly image: string; readonly lock_sha256: string } | null;
  readonly worker_image: string | null;
}

function fixturesOf(v: string | undefined): 'planning' | 'testbed' {
  if (v === undefined || v === '' || v === 'planning') return 'planning';
  if (v === 'testbed') return 'testbed';
  throw new ServiceConfigError('SEED_FAKE_FIXTURES must be planning or testbed');
}

/**
 *   SEED_EXEC_ALLOWED_REPOS        comma-separated owner/name: `sandbox.exec_allowed_repos` (DEC-18's owner allow-list)
 *   SEED_ONBOARDING_SANDBOX_IMAGE, SEED_ONBOARDING_LOCK_SHA256   `onboarding.sandbox_image` (a digest and its pin lock)
 *   SEED_WORKER_IMAGE              `onboarding.light_tests.worker_image` (the W image by digest; thresholds the defaults)
 * All empty: `null` (nothing is published). A value that does not parse is a configuration error.
 */
export function seedSandboxFromEnv(env: Env): SeedSandbox | null {
  const repos = (env['SEED_EXEC_ALLOWED_REPOS'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  for (const r of repos) {
    if (!RepoFullName.safeParse(r).success)
      throw new ServiceConfigError(`SEED_EXEC_ALLOWED_REPOS: ${r} is not owner/name`);
  }
  const image = env['SEED_ONBOARDING_SANDBOX_IMAGE'] ?? '';
  const lock = env['SEED_ONBOARDING_LOCK_SHA256'] ?? '';
  if ((image === '') !== (lock === ''))
    throw new ServiceConfigError(
      'SEED_ONBOARDING_SANDBOX_IMAGE and SEED_ONBOARDING_LOCK_SHA256 go together',
    );
  if (image !== '' && !SandboxImageRef.safeParse(image).success)
    throw new ServiceConfigError('SEED_ONBOARDING_SANDBOX_IMAGE is not an image by digest');
  if (lock !== '' && !Sha256Hex.safeParse(lock).success)
    throw new ServiceConfigError('SEED_ONBOARDING_LOCK_SHA256 is not a sha256');
  const worker = env['SEED_WORKER_IMAGE'] ?? '';
  if (worker !== '' && !SandboxImageRef.safeParse(worker).success)
    throw new ServiceConfigError('SEED_WORKER_IMAGE is not an image by digest');
  if (repos.length === 0 && image === '' && worker === '') return null;
  return {
    exec_allowed_repos: repos.length > 0 ? repos : null,
    onboarding_image: image === '' ? null : { image, lock_sha256: lock },
    worker_image: worker === '' ? null : worker,
  };
}

/** The config keys a `SeedSandbox` sets (only the ones it names). */
export function sandboxDoc(s: SeedSandbox): Record<string, unknown> {
  return {
    ...(s.exec_allowed_repos
      ? { [SANDBOX_EXEC_ALLOWED_REPOS_KEY]: [...s.exec_allowed_repos] }
      : {}),
    ...(s.onboarding_image ? { [ONBOARDING_SANDBOX_IMAGE_KEY]: { ...s.onboarding_image } } : {}),
    ...(s.worker_image
      ? { [ONBOARDING_LIGHT_TESTS_KEY]: { ...DEFAULT_LIGHT_TESTS, worker_image: s.worker_image } }
      : {}),
  };
}

async function adminStepOf(
  cfg: Pick<SeedConfig, 'admin' | 'group'>,
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => ReturnType<typeof callJson>,
  must: (
    what: string,
    r: Awaited<ReturnType<typeof callJson>>,
    tolerate?: number[],
  ) => Promise<void>,
  log: (l: string) => void,
): Promise<void> {
  // 409: the group or the membership exists already (an earlier, interrupted run).
  await must(
    'create group',
    await call('POST', '/v1/groups', {
      group: {
        group_id: cfg.group,
        display: 'Factory admins',
        pim_managed: false,
        protected: false,
      },
    }),
    [409],
  );
  await must(
    'add member',
    await call('POST', `/v1/groups/${encodeURIComponent(cfg.group)}/members`, {
      principal_id: cfg.admin,
    }),
    [409],
  );
  await must(
    'bind role',
    await call('POST', '/v1/bindings', {
      group_id: cfg.group,
      role_id: 'factory.admin',
      scope: { kind: FACTORY_SCOPE.kind, ref: FACTORY_SCOPE.ref },
    }),
  );
  log(`seed: ${cfg.admin} is a factory.admin (group ${cfg.group})`);
}

async function bundleStep(env: Env, cfg: SeedConfig, log: (l: string) => void): Promise<void> {
  const pool = createPool(databaseUrl(env, 'CORE_DATABASE_URL'), 2);
  try {
    const custody = httpKeyCustodyFromEnv(env);
    const key = await custody.publicKey('dev:notary');
    if (!key.ok) throw new Error(`notary public key: ${key.error.message}`);
    const registry = registerGatewayConfig(
      registerCoreConfig(registerPdpConfig(new ConfigRegistry())),
    );
    const deps: ConfigDeps = {
      pool,
      ledger: {
        notary: new HttpNotary({
          baseUrl: httpUrlEnv(env, 'CORE_NOTARY_URL'),
          token: resolveSecretRef(requiredEnv(env, 'CORE_NOTARY_TOKEN_REF'), { env }),
        }),
        notaryKey: key.value,
      },
      eligibility: new GenesisEligibility(cfg.admin),
      stepUp: new NoStepUp(),
      registry,
    };
    const bundle = buildBundle();
    const mine = async () => {
      const caught = await runProjection(pool, configProjection);
      if (!caught.ok) throw new Error(`config projection: ${JSON.stringify(caught.error)}`);
      return loadEffective(pool, { layer: 'factory', scope: FACTORY_SCOPE });
    };
    // Each step proposes one factory revision (the other keys carried over), has the genesis admin decide
    // its M1 gate, and publishes it. The decision is a real ledger entry signed by the Notary.
    const publish = async (what: string, doc: JsonObject) => {
      const p = await proposeRevision(deps, { layer: 'factory', doc, proposed_by: cfg.admin });
      if (!p.ok) throw new Error(`propose ${what}: ${p.error.code}: ${p.error.message}`);
      const prep = await prepare(deps, {
        gate_instance_id: p.value.gate_instance_id,
        principal: cfg.admin,
      });
      if (!prep.ok) throw new Error(`prepare: ${JSON.stringify(prep.error)}`);
      const viewed = await recordEvidenceViewed(deps, {
        nonce: prep.value.nonce,
        evidence_hash: prep.value.evidence_hash,
      });
      if (!viewed.ok) throw new Error(`evidence: ${JSON.stringify(viewed.error)}`);
      const dec = await decide(deps, { nonce: prep.value.nonce, decision: 'approve' });
      if (!dec.ok) throw new Error(`decide: ${JSON.stringify(dec.error)}`);
      const pub = await configPublish(deps, { rev_hash: p.value.rev_hash });
      if (!pub.ok) throw new Error(`publish: ${pub.error.message}`);
      log(`seed: ${what} published (M1 gate ${p.value.gate_instance_id})`);
    };

    const current = await mine();
    const have = current?.doc[PDP_CONFIG_KEY] as { bundle_hash?: string } | undefined;
    if (have?.bundle_hash === bundle.bundle_hash) {
      log(`seed: policy bundle ${bundle.bundle_version} is already effective`);
    } else {
      const v = verifyBundle(bundle);
      if (!v.ok) throw new Error(`propose bundle: ${v.error.reason}: ${v.error.detail}`);
      await publish(`policy bundle ${bundle.bundle_version}`, {
        ...((current?.doc ?? {}) as JsonObject),
        [PDP_CONFIG_KEY]: v.value,
      });
    }

    // The model gateway's routing table (M10.2), local-prod only: the fake provider answers for D0-D2 in
    // `local`, and the Anthropic provider and its models are registered but unrouted. Pointing a route at
    // Claude is a later, gated revision (a human decides it like any other config change). D3 has no route.
    const routing = localGatewayRouting(cfg.github, cfg.fixtures) as unknown as JsonObject;
    const effective = await mine();
    const same = Object.entries(routing).every(
      ([k, v]) => canonicalJson(effective?.doc[k] ?? null) === canonicalJson(v),
    );
    if (same) {
      log('seed: the local gateway routing table is already effective');
    } else {
      await publish('local gateway routing table', {
        ...((effective?.doc ?? {}) as JsonObject),
        ...routing,
      });
    }

    // The local stack's sandbox settings (the compose e2e of request to PR): which repos' code may run (DEC-18), the
    // onboarding probe image and the W image LF4 is about. Each is an ordinary M1-gated factory revision, decided by the
    // genesis admin like the two above; a stack that sets none of SEED_EXEC_ALLOWED_REPOS, SEED_ONBOARDING_* and
    // SEED_WORKER_IMAGE gets none (the defaults: nothing runs).
    if (cfg.sandbox) {
      const sandbox = sandboxDoc(cfg.sandbox) as unknown as JsonObject;
      const now = await mine();
      if (
        Object.entries(sandbox).every(
          ([k, v]) => canonicalJson(now?.doc[k] ?? null) === canonicalJson(v),
        )
      ) {
        log('seed: the local sandbox settings are already effective');
      } else {
        await publish('local sandbox settings', {
          ...((now?.doc ?? {}) as JsonObject),
          ...sandbox,
        });
      }
    }
  } finally {
    await pool.end();
  }
}

/** Runs the seed; returns the process exit code. */
export async function runSeed(
  env: Env,
  log: (l: string) => void = console.log,
  error: (l: string) => void = console.error,
): Promise<number> {
  let cfg: SeedConfig;
  try {
    cfg = seedConfigFromEnv(env);
    databaseUrl(env, 'CORE_DATABASE_URL');
  } catch (e) {
    if (e instanceof ServiceConfigError) {
      error(`seed: configuration error: ${e.message}`);
      return EXIT_CONFIG;
    }
    throw e;
  }
  try {
    await seedIdentity(cfg, log);
    await bundleStep(env, cfg, log);
    return 0;
  } catch (e) {
    error(`seed: failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
