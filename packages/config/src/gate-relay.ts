import { FACTORY_SCOPE, RELEASE_CONFIG_KEY, ReleaseSetting } from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';
import { loadEffective } from './projection.js';
import type { ConfigRegistry } from './registry.js';

const ReleaseValue = ReleaseSetting.nullable();

/**
 * Registers a project's release choice (PLAN M15.3, §7a "G5 release"): `project.release`, `off` or a deploy target,
 * set by the project layer (card 4 at onboarding, or a settings change: either way an M1-gated revision). Default
 * `null`: not chosen, which keeps the gating profile's G5 and releases nothing (unknown is not released). Read by core
 * (the item's pinned profile, the G5 card, the S8b step) and gate-relay (the target, again, when it consumes a G5).
 * Idempotent.
 */
export function registerReleaseConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(RELEASE_CONFIG_KEY)) return registry;
  return registry.setting({
    key: RELEASE_CONFIG_KEY,
    schema: ReleaseValue,
    default: null,
    overridable: true,
    description:
      'G5 release: off (no S8b release, no G5) or a deploy target (a GitHub environment) that gate-relay deploys merged commits to after an approved G5. Not chosen: nothing is released. Per project, M1-gated',
  });
}

/** The release setting in force for a project: its value, or `unreadable` (a published value that fits no schema). */
export type ReleaseRead =
  | { readonly state: 'ok'; readonly value: ReleaseSetting | null }
  | { readonly state: 'unreadable' };

/**
 * Reads `project.release` for a project from the published layers (project over factory, as the config reader does),
 * through the `config.genuine_publish` view (any role that may read the published config may call it, in a transaction
 * too). A value that fails its schema is `unreadable`: callers treat it as "not released".
 */
export async function readReleaseSetting(db: Executor, project: string): Promise<ReleaseRead> {
  const factory = await loadEffective(db, { layer: 'factory', scope: FACTORY_SCOPE });
  const own = await loadEffective(db, {
    layer: 'project',
    scope: { kind: 'project', ref: project },
  });
  let raw: unknown = null;
  const f = factory?.doc as Record<string, unknown> | undefined;
  const p = own?.doc as Record<string, unknown> | undefined;
  if (f && RELEASE_CONFIG_KEY in f) raw = f[RELEASE_CONFIG_KEY];
  if (p && RELEASE_CONFIG_KEY in p) raw = p[RELEASE_CONFIG_KEY];
  const parsed = ReleaseValue.safeParse(raw);
  return parsed.success ? { state: 'ok', value: parsed.data } : { state: 'unreadable' };
}
