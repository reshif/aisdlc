import {
  INTEGRATION_CONFIG_KEYS,
  IntegrationInstalls,
  IntegrationRegistry,
  type IntegrationInstalls as InstallRows,
  type IntegrationRegistry as RegistryRows,
} from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';
import type { z } from 'zod';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the Integration registry (PLAN M10.4; DM §4.1): `integrations.registry` and
 * `integrations.installs`, factory layer only, empty by default (a fresh factory has no integration, so
 * the codehost and the gateway have nothing to select and refuse to serve).
 *
 * Rules the registry keeps on every write:
 *   - credentials are REFERENCES (`file:` or `env:`, checked by shape in the contract) and the whole
 *     document is run through the shared secret ruleset, so a pasted key anywhere in a row (a
 *     `config` value, a display name) is refused before an approver sees it, and the finding names the
 *     rule, never the value (as `AssistantTurn` does);
 *   - every scope row carries the D11 forbidden list (the contract);
 *   - an install names an integration of the registry, an enabled install an ENABLED one;
 *   - enabling, widening a scope, a new route and a new install are all revisions of these keys, so each
 *     one opens an M1 gate: nothing here takes effect without a decided, ledgered `config_publish`.
 */
export function registerIntegrationConfig(registry: ConfigRegistry): ConfigRegistry {
  const noSecrets = (label: string) => (value: unknown, ctx: z.RefinementCtx) => {
    for (const f of findSecrets(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `${label} holds something that looks like a secret (rule ${f}): store a reference, never the value`,
      });
    }
  };
  return registry
    .setting({
      key: INTEGRATION_CONFIG_KEYS.registry,
      schema: IntegrationRegistry.superRefine(noSecrets('the registry')),
      default: [],
      overridable: false,
      description:
        'integrations (code hosts, model providers) with credential references and scopes',
    })
    .setting({
      key: INTEGRATION_CONFIG_KEYS.installs,
      schema: IntegrationInstalls.superRefine(noSecrets('the installs')),
      default: [],
      overridable: false,
      description: 'integrations enabled per project, with repo and model overrides',
    })
    .rule({
      name: 'integration installs',
      check(values) {
        const rows = (values[INTEGRATION_CONFIG_KEYS.registry] ?? []) as RegistryRows;
        const installs = (values[INTEGRATION_CONFIG_KEYS.installs] ?? []) as InstallRows;
        const byId = new Map(rows.map((i) => [i.integration_id, i]));
        const problems: string[] = [];
        for (const n of installs) {
          const i = byId.get(n.integration_id);
          if (!i)
            problems.push(`install ${n.install_id} names unknown integration ${n.integration_id}`);
          else if (n.enabled && i.status !== 'enabled') {
            problems.push(
              `install ${n.install_id} is enabled but ${i.integration_id} is ${i.status}`,
            );
          }
        }
        return problems;
      },
    });
}

/** Rule ids the secret ruleset finds in a document (never the values). */
export function findSecrets(doc: unknown): string[] {
  const texts = [JSON.stringify(doc, null, 1)];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(doc);
  return [...new Set(texts.flatMap((t) => scanText(t).map((m) => m.rule_id)))].sort();
}
