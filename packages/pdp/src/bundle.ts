import {
  FACTORY_SCOPE,
  PDP_CONFIG_KEY,
  PolicyBundle,
  policyBundleHash,
  type JsonObject,
  type PrincipalId,
} from '@aisdlc/contracts';
import {
  configProjection,
  loadEffective,
  proposeRevision,
  type ConfigDeps,
  type ConfigReader,
  type ConfigRegistry,
  type ProposeResult,
} from '@aisdlc/config';
import type { Written } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import { runProjection } from '@aisdlc/record';
import { validateBundleText } from './cedar.js';

// Policy bundles (PLAN M4.3). A bundle reaches an enforcement point only as the `pdp.bundle` key of
// the factory config layer, so it is published through `config_publish` behind an M1 gate like any
// other configuration, and the evaluator follows the effective revision without a restart.
//
// The evaluator never trusts what it is handed: it re-parses the bundle, recomputes the hash and
// validates the Cedar text against the schema, every time the bundle changes. Anything less than a
// fully verified bundle is "no bundle", and no bundle denies.

/** Why a bundle is refused. `no_bundle` is the absence of one. */
export type BundleRefusal =
  'no_bundle' | 'bundle_malformed' | 'bundle_hash_mismatch' | 'bundle_invalid';

export interface BundleProblem {
  readonly reason: BundleRefusal;
  readonly detail: string;
  /** Declared version and hash when they could be read, for the decision stamp. */
  readonly bundle_version: string | null;
  readonly bundle_hash: string | null;
}

export type VerifiedBundle = PolicyBundle;

const verified = new Map<string, VerifiedBundle>();

/** Verification result for whatever the source holds. Successful results are cached by hash. */
export function verifyBundle(raw: unknown): Result<VerifiedBundle, BundleProblem> {
  if (raw === null || raw === undefined) {
    return err({
      reason: 'no_bundle',
      detail: 'no policy bundle is published',
      bundle_version: null,
      bundle_hash: null,
    });
  }
  const parsed = PolicyBundle.safeParse(raw);
  if (!parsed.success) {
    return err({
      reason: 'bundle_malformed',
      detail: parsed.error.message,
      bundle_version: null,
      bundle_hash: null,
    });
  }
  const b = parsed.data;
  const actual = policyBundleHash(b);
  if (actual !== b.bundle_hash) {
    return err({
      reason: 'bundle_hash_mismatch',
      detail: `declared ${b.bundle_hash}, content hashes to ${actual}`,
      bundle_version: b.bundle_version,
      bundle_hash: b.bundle_hash,
    });
  }
  const hit = verified.get(b.bundle_hash);
  if (hit) return ok(hit);
  const problems = validateBundleText(b);
  if (problems.length > 0) {
    return err({
      reason: 'bundle_invalid',
      detail: problems.join('; '),
      bundle_version: b.bundle_version,
      bundle_hash: b.bundle_hash,
    });
  }
  verified.set(b.bundle_hash, b);
  return ok(b);
}

/** Where the evaluator reads the bundle on every decision. Synchronous: a decision never waits on I/O for it. */
export interface BundleSource {
  current(): unknown;
}

/** A bundle held in memory; `set` swaps it. For tests and for tools that build bundles themselves. */
export class StaticBundleSource implements BundleSource {
  constructor(private bundle: unknown = null) {}
  set(bundle: unknown): void {
    this.bundle = bundle;
  }
  current(): unknown {
    return this.bundle;
  }
}

/**
 * The effective bundle from a `ConfigReader`: the published factory revision's `pdp.bundle`, `null`
 * until one is published. A reader that fails to refresh keeps its last good snapshot (so a
 * database blip does not deny everything), and a revision change shows at the next `current()`.
 */
export class ConfigBundleSource implements BundleSource {
  constructor(private readonly reader: ConfigReader) {}
  current(): unknown {
    return this.reader.current().get(PDP_CONFIG_KEY) ?? null;
  }
}

/** Registers `pdp.bundle` (factory layer only, `null` by default: no bundle, deny). */
export function registerPdpConfig(registry: ConfigRegistry): ConfigRegistry {
  return registry.setting({
    key: PDP_CONFIG_KEY,
    schema: PolicyBundle.nullable(),
    default: null,
    overridable: false,
    description: 'the policy bundle every enforcement point evaluates (schema, policies, hash)',
  });
}

export interface ProposeBundleError {
  readonly reason: BundleRefusal | 'config_error';
  readonly detail: string;
}

/**
 * Proposes a bundle as a factory-layer config revision (which opens its M1 gate). Refuses a bundle
 * that does not verify, so a bad bundle never reaches an approver. The factory document is a full
 * document, so the other factory keys are carried over from the effective revision.
 */
export async function proposeBundle(
  deps: ConfigDeps,
  bundle: PolicyBundle,
  proposedBy: PrincipalId,
): Promise<Result<Written<ProposeResult>, ProposeBundleError>> {
  const v = verifyBundle(bundle);
  if (!v.ok) return err({ reason: v.error.reason, detail: v.error.detail });
  const caught = await runProjection(deps.pool, configProjection);
  if (!caught.ok) return err({ reason: 'config_error', detail: JSON.stringify(caught.error) });
  const current = await loadEffective(deps.pool, { layer: 'factory', scope: FACTORY_SCOPE });
  const doc: JsonObject = { ...(current?.doc ?? {}), [PDP_CONFIG_KEY]: v.value };
  const r = await proposeRevision(deps, {
    layer: 'factory',
    doc,
    proposed_by: proposedBy,
  });
  return r.ok ? ok(r.value) : err({ reason: 'config_error', detail: r.error.message });
}
