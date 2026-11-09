import {
  GATEWAY_CONFIG_KEYS,
  GatewayModels,
  GatewayProviders,
  GatewayRoutes,
} from '@aisdlc/contracts';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the model gateway's routing table (PLAN M10.2): `gateway.providers`, `gateway.models` and
 * `gateway.routes`, all factory layer only (a project cannot add a route) and empty by default, so a
 * fresh factory routes nothing and the gateway refuses every call (fail closed).
 *
 * The `gateway.routes` schema has no D3: a document that names a D3 route is refused by the registry,
 * and so by `proposeRevision`, before an approver ever sees it. Whatever a route to D2 or lower does,
 * adding or changing one is a revision, so it opens an M1 gate like every other config change.
 */
export function registerGatewayConfig(registry: ConfigRegistry): ConfigRegistry {
  return registry
    .setting({
      key: GATEWAY_CONFIG_KEYS.providers,
      schema: GatewayProviders,
      default: [],
      overridable: false,
      description: 'model providers the gateway may use (no keys and no URLs: those are its own)',
    })
    .setting({
      key: GATEWAY_CONFIG_KEYS.models,
      schema: GatewayModels,
      default: [],
      overridable: false,
      description: 'models of those providers, with limits and prices (the cost table)',
    })
    .setting({
      key: GATEWAY_CONFIG_KEYS.routes,
      schema: GatewayRoutes,
      default: [],
      overridable: false,
      description: '(environment, data class) -> model; D3 never has a route',
    });
}
