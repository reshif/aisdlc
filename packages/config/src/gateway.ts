import {
  GATEWAY_CONFIG_KEYS,
  GatewayModels,
  GatewayRoutes,
  INTEGRATION_CONFIG_KEYS,
  type GatewayModels as GatewayModelRows,
  type GatewayRoutes as GatewayRouteRows,
  type IntegrationRegistry,
} from '@aisdlc/contracts';
import { registerIntegrationConfig } from './integrations.js';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the model gateway's routing table (PLAN M10.2): `gateway.models` and `gateway.routes`, both
 * factory layer only (a project cannot add a route) and empty by default, so a fresh factory routes
 * nothing and the gateway refuses every call (fail closed). The PROVIDERS of the table are rows of the
 * integration registry (`registerIntegrationConfig`), not a key of their own.
 *
 * The `gateway.routes` schema has no D3: a document that names a D3 route is refused by the registry,
 * and so by `proposeRevision`, before an approver ever sees it. Whatever a route to D2 or lower does,
 * adding or changing one is a revision, so it opens an M1 gate like every other config change.
 *
 * Across keys: a model must belong to a `model_provider` integration of the registry and a route must
 * name a model of the table; a document that leaves a dangling name is refused.
 */
export function registerGatewayConfig(registry: ConfigRegistry): ConfigRegistry {
  // The providers are registry rows: the registry's keys come with the table (once).
  if (!registry.get(INTEGRATION_CONFIG_KEYS.registry)) registerIntegrationConfig(registry);
  return registry
    .setting({
      key: GATEWAY_CONFIG_KEYS.models,
      schema: GatewayModels,
      default: [],
      overridable: false,
      description: 'models of the registry providers, with limits and prices (the cost table)',
    })
    .setting({
      key: GATEWAY_CONFIG_KEYS.routes,
      schema: GatewayRoutes,
      default: [],
      overridable: false,
      description: '(environment, data class) -> model; D3 never has a route',
    })
    .rule({
      name: 'gateway routing',
      check(values) {
        const models = (values[GATEWAY_CONFIG_KEYS.models] ?? []) as GatewayModelRows;
        const routes = (values[GATEWAY_CONFIG_KEYS.routes] ?? []) as GatewayRouteRows;
        const registryRows = (values[INTEGRATION_CONFIG_KEYS.registry] ??
          []) as IntegrationRegistry;
        const providers = new Set(
          registryRows.filter((i) => i.kind === 'model_provider').map((i) => i.integration_id),
        );
        const problems: string[] = [];
        for (const m of models) {
          if (!providers.has(m.provider_id)) {
            problems.push(
              `model ${m.model_id} names provider ${m.provider_id}, which is not a model_provider integration`,
            );
          }
        }
        const ids = new Set(models.map((m) => m.model_id));
        for (const r of routes) {
          if (!ids.has(r.model_id)) {
            problems.push(
              `route ${r.environment}/${r.data_class} names unknown model ${r.model_id}`,
            );
          }
        }
        return problems;
      },
    });
}
