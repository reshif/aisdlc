import { MERGE_BYPASS_CONFIG_KEY, MergeBypassConfig } from '@aisdlc/contracts';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the per-repo merge bypass list (PLAN M14.5; DEC-10 as refined 2026-11-11): `codehost.merge_bypass`,
 * factory layer only, M1-gated like every revision. Default: empty, so nobody may merge without `aisdlc/gate`. The
 * schema takes GitHub USER logins with the person's principal id: an App or a bot is not a login of that shape, so the
 * list can never hold one. Read by gate-check (which records every bypass merge for X4) and registered by core (whose
 * revisions must validate a document that sets it). Idempotent.
 */
export function registerGateCheckConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(MERGE_BYPASS_CONFIG_KEY)) return registry;
  return registry.setting({
    key: MERGE_BYPASS_CONFIG_KEY,
    schema: MergeBypassConfig,
    default: {},
    overridable: false,
    description:
      'DEC-10: per repo, the named people who may merge a PR whose aisdlc/gate check did not pass (never an App). Every such merge is recorded and gets an X4 review. Empty: nobody. Factory layer only, M1-gated',
  });
}
