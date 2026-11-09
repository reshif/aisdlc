import {
  GATEWAY_CONFIG_KEYS,
  type DataClass,
  type GatewayEnvironment,
  type GatewayModel,
  type GatewayModels,
  type GatewayProviders,
  type GatewayRefusal,
  type GatewayRoutes,
} from '@aisdlc/contracts';
import type { ModelProviderPort } from '@aisdlc/ports';

// The routing table as the gateway uses it: read from the effective config on EVERY call, so a
// published revision is in force from the next call on, with no restart (PLAN M10.2). Anything that
// does not add up is a refusal, never a fallback: D3 has no route, a data class with no route is
// refused, a route to a model or provider that is gone, off, or not what the gateway holds is refused.

/** What the gateway needs of a config reader: a synchronous snapshot (`ConfigReader` is one). */
export interface ConfigSource {
  current(): {
    get<T = unknown>(key: string): T | undefined;
    readonly token: string;
    readonly revisions: { readonly factory: string | null };
  };
}

export type Resolved =
  | {
      readonly ok: true;
      readonly model: GatewayModel;
      readonly provider: ModelProviderPort;
      readonly provider_id: string;
      /** The revision of the factory config the answer came from. */
      readonly revision: string | null;
    }
  | { readonly ok: false; readonly refusal: GatewayRefusal; readonly message: string };

export function resolveRoute(
  source: ConfigSource,
  adapters: ReadonlyMap<string, ModelProviderPort>,
  environment: GatewayEnvironment,
  dataClass: DataClass,
): Resolved {
  // D3 never has a route. The registry schema cannot hold one either; this is the call-time half,
  // so a hand-edited or corrupted snapshot still cannot route it.
  if (dataClass === 'D3') {
    return { ok: false, refusal: 'd3_never_routed', message: 'D3 data is never sent to a model' };
  }
  const snap = source.current();
  const routes = snap.get<GatewayRoutes>(GATEWAY_CONFIG_KEYS.routes) ?? [];
  const route = routes.find((r) => r.environment === environment && r.data_class === dataClass);
  if (!route) {
    return {
      ok: false,
      refusal: 'no_route',
      message: `no route for ${dataClass} in ${environment}`,
    };
  }
  const models = snap.get<GatewayModels>(GATEWAY_CONFIG_KEYS.models) ?? [];
  const providers = snap.get<GatewayProviders>(GATEWAY_CONFIG_KEYS.providers) ?? [];
  const model = models.find((m) => m.model_id === route.model_id);
  const provider = model ? providers.find((p) => p.provider_id === model.provider_id) : undefined;
  const adapter = provider ? adapters.get(provider.provider_id) : undefined;
  if (!model || !provider || !provider.enabled || !adapter || adapter.kind !== provider.kind) {
    return {
      ok: false,
      refusal: 'route_broken',
      message: `the route for ${dataClass} in ${environment} does not lead to a usable model`,
    };
  }
  return {
    ok: true,
    model,
    provider: adapter,
    provider_id: provider.provider_id,
    revision: snap.revisions.factory,
  };
}
