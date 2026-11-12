import { DEFAULT_SANDBOX_CAPS, SANDBOX_CAPS_KEY, SandboxCapsConfig } from '@aisdlc/contracts';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the sandbox caps (PLAN M14.2; ADR-0003 §6, §7): `sandbox.caps`, factory layer only (a project cannot
 * raise a runner host's caps), M1-gated like every revision. Default: a total of 4 sessions and 1 coding (W)
 * session per runner host. Read by the sandbox-controller (which enforces them) and registered by core (whose
 * revisions must validate a document that sets them). Idempotent: a registry that has the key keeps it.
 */
export function registerSandboxConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(SANDBOX_CAPS_KEY)) return registry;
  return registry.setting({
    key: SANDBOX_CAPS_KEY,
    schema: SandboxCapsConfig,
    default: { ...DEFAULT_SANDBOX_CAPS },
    overridable: false,
    description:
      'the two sandbox caps of a runner host (a total and the coding W cap), with optional per-host rows. Factory layer only, M1-gated',
  });
}
