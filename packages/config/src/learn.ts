import {
  DEFAULT_FACTORY_M1_POLICY,
  DEFAULT_LEARN_CONFIG,
  FACTORY_M1_POLICY_KEY,
  FACTORY_SCOPE,
  FactoryM1Policy,
  LEARN_CONFIG_KEY,
  LearnConfig,
  PROJECT_DEFAULT_ENVELOPE_KEY,
  PROJECT_WIP_LIMIT_KEY,
  ProjectDefaultEnvelope,
  ProjectWipLimit,
  SANDBOX_CAPS_KEY,
  sandboxCapsFor,
  type SandboxCaps,
} from '@aisdlc/contracts';
import { runProjection, type Executor } from '@aisdlc/record';
import type pg from 'pg';
import type { z } from 'zod';
import { configProjection, loadEffective } from './projection.js';
import type { ConfigRegistry } from './registry.js';

// The governance settings of M15.5 (PLAN §7a, ADR-0003 §6): who decides a factory M1, when 9.4 Learn proposes, and a
// project's WIP limit and default envelope. Each is an ordinary registered key, so each change is itself M1-gated.

/** Registers `factory.m1_policy` and `factory.learn` (factory layer only). Idempotent. */
export function registerGovernanceConfig(registry: ConfigRegistry): ConfigRegistry {
  if (!registry.get(FACTORY_M1_POLICY_KEY)) {
    registry.setting({
      key: FACTORY_M1_POLICY_KEY,
      schema: FactoryM1Policy,
      default: { ...DEFAULT_FACTORY_M1_POLICY },
      overridable: false,
      description:
        'who decides a factory-layer revision (its M1): the holders of a fleet role, never the proposer, one or two of them. Default: one factory admin other than the proposer. Factory layer only, M1-gated under the rule in force',
    });
  }
  if (!registry.get(LEARN_CONFIG_KEY)) {
    registry.setting({
      key: LEARN_CONFIG_KEY,
      schema: LearnConfig,
      default: { ...DEFAULT_LEARN_CONFIG },
      overridable: false,
      description:
        '9.4 Learn: when the factory turns close-out evidence into a META proposal (M1 config, M2 variance, M3 catalogue, M5 autonomy, M6 approver). They decide nothing: a person decides each gate. Factory layer only, M1-gated',
    });
  }
  return registry;
}

/** Registers a project's admission limits (ADR-0003 §6: project admin, M1 on the project). Idempotent. */
export function registerAdmissionConfig(registry: ConfigRegistry): ConfigRegistry {
  if (!registry.get(PROJECT_WIP_LIMIT_KEY)) {
    registry.setting({
      key: PROJECT_WIP_LIMIT_KEY,
      schema: ProjectWipLimit,
      default: null,
      overridable: true,
      description:
        "the project's WIP limit: at most this many of its Units hold an admission grant at once (null: none beyond the sandbox caps). Per project, M1-gated",
    });
  }
  if (!registry.get(PROJECT_DEFAULT_ENVELOPE_KEY)) {
    registry.setting({
      key: PROJECT_DEFAULT_ENVELOPE_KEY,
      schema: ProjectDefaultEnvelope,
      default: null,
      overridable: true,
      description:
        "the project's default envelope: the envelope of an item with no plan, and the most one Unit reserves (null: the lane profile and the coder contract). Per project, M1-gated",
    });
  }
  return registry;
}

/**
 * Catches the config read model up first when `db` is a pool (a write that has just published is then visible); a
 * transaction's client reads what is projected. A projection error leaves what is there (never a default above it).
 */
async function fresh(db: Executor): Promise<void> {
  const pool = db as Partial<pg.Pool>;
  if (typeof pool.totalCount !== 'number' || typeof pool.connect !== 'function') return;
  try {
    await runProjection(db as pg.Pool, configProjection);
  } catch {
    // read what is projected
  }
}

/** A published value read for a key: its value (or the default when unset), or `unreadable` (fits no schema). */
export type SettingRead<T> =
  { readonly state: 'ok'; readonly value: T } | { readonly state: 'unreadable' };

async function readFactoryKey<T>(
  db: Executor,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<SettingRead<T>> {
  await fresh(db);
  const f = await loadEffective(db, { layer: 'factory', scope: FACTORY_SCOPE });
  const doc = f?.doc as Record<string, unknown> | undefined;
  if (!doc || !(key in doc)) return { state: 'ok', value: fallback };
  const p = schema.safeParse(doc[key]);
  return p.success ? { state: 'ok', value: p.data } : { state: 'unreadable' };
}

async function readProjectKey<T>(
  db: Executor,
  project: string,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<SettingRead<T>> {
  await fresh(db);
  const f = await loadEffective(db, { layer: 'factory', scope: FACTORY_SCOPE });
  const own = await loadEffective(db, {
    layer: 'project',
    scope: { kind: 'project', ref: project },
  });
  const fd = f?.doc as Record<string, unknown> | undefined;
  const pd = own?.doc as Record<string, unknown> | undefined;
  let raw: unknown = fallback;
  if (fd && key in fd) raw = fd[key];
  if (pd && key in pd) raw = pd[key];
  const p = schema.safeParse(raw);
  return p.success ? { state: 'ok', value: p.data } : { state: 'unreadable' };
}

/** The factory M1 rule in force (published factory layer). Unreadable is reported, never the default. */
export const readFactoryM1Policy = (db: Executor): Promise<SettingRead<FactoryM1Policy>> =>
  readFactoryKey(db, FACTORY_M1_POLICY_KEY, FactoryM1Policy, DEFAULT_FACTORY_M1_POLICY);

/** 9.4's thresholds in force. */
export const readLearnConfig = (db: Executor): Promise<SettingRead<LearnConfig>> =>
  readFactoryKey(db, LEARN_CONFIG_KEY, LearnConfig, DEFAULT_LEARN_CONFIG);

/** A project's admission limits in force (project over factory over the defaults). */
export async function readAdmissionSettings(
  db: Executor,
  project: string,
): Promise<SettingRead<{ wip_limit: ProjectWipLimit; default_envelope: ProjectDefaultEnvelope }>> {
  const wip = await readProjectKey(db, project, PROJECT_WIP_LIMIT_KEY, ProjectWipLimit, null);
  const env = await readProjectKey(
    db,
    project,
    PROJECT_DEFAULT_ENVELOPE_KEY,
    ProjectDefaultEnvelope,
    null,
  );
  if (wip.state !== 'ok' || env.state !== 'ok') return { state: 'unreadable' };
  return { state: 'ok', value: { wip_limit: wip.value, default_envelope: env.value } };
}

/**
 * The sandbox caps of a runner host as the published `sandbox.caps` says them: what the sandbox-controller of that host
 * enforces (`sandboxCapsFor`, the same reader). Anything unreadable is the defaults, never higher.
 */
export async function readSandboxCaps(db: Executor, host: string): Promise<SandboxCaps> {
  await fresh(db);
  const f = await loadEffective(db, { layer: 'factory', scope: FACTORY_SCOPE });
  const doc = f?.doc as Record<string, unknown> | undefined;
  return sandboxCapsFor(doc?.[SANDBOX_CAPS_KEY], host);
}
