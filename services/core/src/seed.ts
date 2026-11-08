import { ConfigRegistry, configProjection, configPublish, loadEffective } from '@aisdlc/config';
import type { ConfigDeps } from '@aisdlc/config';
import {
  FACTORY_SCOPE,
  PDP_CONFIG_KEY,
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
import { err, ok } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { buildBundle, proposeBundle, registerPdpConfig } from '@aisdlc/pdp';
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
//      when it is already in place.
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
  };
}

async function identityStep(cfg: SeedConfig, log: (l: string) => void): Promise<void> {
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
    return;
  }
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
    const registry = registerCoreConfig(registerPdpConfig(new ConfigRegistry()));
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
    const caught = await runProjection(pool, configProjection);
    if (!caught.ok) throw new Error(`config projection: ${JSON.stringify(caught.error)}`);
    const current = await loadEffective(pool, { layer: 'factory', scope: FACTORY_SCOPE });
    const have = current?.doc[PDP_CONFIG_KEY] as { bundle_hash?: string } | undefined;
    if (have?.bundle_hash === bundle.bundle_hash) {
      log(`seed: policy bundle ${bundle.bundle_version} is already effective`);
      return;
    }
    const p = await proposeBundle(deps, bundle, cfg.admin);
    if (!p.ok) throw new Error(`propose bundle: ${p.error.reason}: ${p.error.detail}`);
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
    log(
      `seed: policy bundle ${bundle.bundle_version} published (M1 gate ${p.value.gate_instance_id})`,
    );
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
    await identityStep(cfg, log);
    await bundleStep(env, cfg, log);
    return 0;
  } catch (e) {
    error(`seed: failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
