import {
  DEFAULT_SANDBOX_CAPS,
  ONBOARDING_SANDBOX_IMAGE_KEY,
  OnboardingSandboxImage,
  SANDBOX_CAPS_KEY,
  SandboxCapsConfig,
} from '@aisdlc/contracts';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the sandbox caps (PLAN M14.2; ADR-0003 §6, §7): `sandbox.caps`, factory layer only (a project cannot
 * raise a runner host's caps), M1-gated like every revision. Default: a total of 4 sessions and 1 coding (W)
 * session per runner host. Read by the sandbox-controller (which enforces them) and registered by core (whose
 * revisions must validate a document that sets them). Idempotent: a registry that has the key keeps it.
 */
export function registerSandboxConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(SANDBOX_CAPS_KEY)) return registry;
  return registry
    .setting({
      key: SANDBOX_CAPS_KEY,
      schema: SandboxCapsConfig,
      default: { ...DEFAULT_SANDBOX_CAPS },
      overridable: false,
      description:
        'the two sandbox caps of a runner host (a total and the coding W cap), with optional per-host rows. Factory layer only, M1-gated',
    })
    .setting({
      key: ONBOARDING_SANDBOX_IMAGE_KEY,
      schema: OnboardingSandboxImage,
      default: null,
      overridable: false,
      description:
        'DEC-17 (refined): the dedicated onboarding probe image, by digest only, with the sha256 of the pin lock it was built from. Null: no probe runs. An image update is a reviewed config change. Factory layer only, M1-gated',
    });
}

/**
 * The approved onboarding probe image from a config reader's snapshot (M16). `null`: none approved, or the published
 * value does not read (unknown: no probe runs, never a default image).
 */
export function onboardingImageFrom(c: {
  rejected: readonly string[];
  get(key: string): unknown;
}): OnboardingSandboxImage {
  if (c.rejected.includes(ONBOARDING_SANDBOX_IMAGE_KEY)) return null;
  const p = OnboardingSandboxImage.safeParse(c.get(ONBOARDING_SANDBOX_IMAGE_KEY) ?? null);
  return p.success ? p.data : null;
}
