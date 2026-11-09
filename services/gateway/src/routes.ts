import {
  GATEWAY_CONFIG_KEYS,
  type DataClass,
  type GatewayEnvironment,
  type GatewayModel,
  type GatewayModels,
  type GatewayRefusal,
  type GatewayRoutes,
} from '@aisdlc/contracts';
import { enabledFor, enabledOf, readRegistry } from '@aisdlc/integrations';
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

/** The adapters this process holds, by integration id (a `Map` is one; the registry-driven set is another). */
export type AdapterSource = Pick<ReadonlyMap<string, ModelProviderPort>, 'get'>;

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
  adapters: AdapterSource,
  environment: GatewayEnvironment,
  dataClass: DataClass,
  project?: string,
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
  // The providers are rows of the integration registry (one registry for code hosts and model
  // providers): enabled ones only, and the adapter this process holds for that row must be of its kind.
  const registry = readRegistry(snap);
  const providers = enabledOf(registry, 'model_provider');
  const model = models.find((m) => m.model_id === route.model_id);
  const provider = model
    ? providers.find((p) => p.integration_id === model.provider_id)
    : undefined;
  const adapter = provider ? adapters.get(provider.integration_id) : undefined;
  if (!model || !provider || !adapter || adapter.kind !== provider.adapter) {
    return {
      ok: false,
      refusal: 'route_broken',
      message: `the route for ${dataClass} in ${environment} does not lead to a usable model`,
    };
  }
  // An install row for the project can only NARROW what the fleet-wide provider offers: a disabled one,
  // or a models allow-list that leaves this model out, refuses the call. No row: the fleet-wide default.
  if (project !== undefined) {
    const { install } = enabledFor(registry, provider.integration_id, project);
    if (
      install &&
      (!install.enabled || install.overrides.models_allowed?.includes(model.model_id) === false)
    ) {
      return {
        ok: false,
        refusal: 'model_not_allowed',
        message: `project ${project} may not use ${model.model_id} through ${provider.integration_id}`,
      };
    }
  }
  return {
    ok: true,
    model,
    provider: adapter,
    provider_id: provider.integration_id,
    revision: snap.revisions.factory,
  };
}
