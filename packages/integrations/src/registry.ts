import {
  ADAPTER_KIND,
  INTEGRATION_CONFIG_KEYS,
  GATED_INTEGRATION_CHANGES,
  GATEWAY_CONFIG_KEYS,
  Integration,
  IntegrationInstall,
  type GatewayRoutes,
  type IntegrationAdapter,
  type IntegrationEvent,
  type IntegrationEventKind,
  type IntegrationKind,
  type IntegrationRegistryView,
  type IntegrationScope,
} from '@aisdlc/contracts';

// The registry as its consumers read it (PLAN M10.4). One pure module: it takes what a config snapshot
// says and answers which integration serves what, for whom. Fail closed: a row that is not `enabled` is
// not served, an install that is not `enabled` (or whose integration is not) is not served, and a
// row that does not parse is dropped (a document that does not parse is no registry at all).

/** What a config snapshot exposes (`ConfigReader.current()` and the gateway's `ConfigSource` both do). */
export interface RegistrySnapshot {
  get<T = unknown>(key: string): T | undefined;
  readonly revisions: { readonly factory: string | null };
}

export function readRegistry(snap: RegistrySnapshot): IntegrationRegistryView {
  const rows = (snap.get<unknown[]>(INTEGRATION_CONFIG_KEYS.registry) ?? []).flatMap((r) => {
    const p = Integration.safeParse(r);
    return p.success ? [p.data] : [];
  });
  const installs = (snap.get<unknown[]>(INTEGRATION_CONFIG_KEYS.installs) ?? []).flatMap((r) => {
    const p = IntegrationInstall.safeParse(r);
    return p.success ? [p.data] : [];
  });
  return { revision: snap.revisions.factory, integrations: rows, installs };
}

/** The enabled integrations of one kind (and, if given, one adapter), in the registry's order. */
export function enabledOf(
  view: Pick<IntegrationRegistryView, 'integrations'>,
  kind: IntegrationKind,
  adapter?: IntegrationAdapter,
): Integration[] {
  return view.integrations.filter(
    (i) =>
      i.status === 'enabled' &&
      i.kind === kind &&
      ADAPTER_KIND[i.adapter] === kind &&
      (adapter === undefined || i.adapter === adapter),
  );
}

/**
 * Is `integration_id` enabled for `project_id`? Needs an `enabled` integration AND an `enabled` install
 * of it for that project: nothing else (no install row, a disabled one, a retired integration) is a yes.
 */
export function enabledFor(
  view: Pick<IntegrationRegistryView, 'integrations' | 'installs'>,
  integration_id: string,
  project_id: string,
): { enabled: boolean; install: IntegrationInstall | null } {
  const i = view.integrations.find((x) => x.integration_id === integration_id);
  const n =
    view.installs.find((x) => x.integration_id === integration_id && x.project_id === project_id) ??
    null;
  return { enabled: i?.status === 'enabled' && n !== null && n.enabled, install: n };
}

/** The models of a provider a project may use: the install's allow-list narrows the provider's models, never widens. */
export function modelsAllowedFor(
  install: IntegrationInstall | null,
  providerModels: readonly string[],
): string[] {
  const only = install?.overrides.models_allowed;
  return only === undefined ? [...providerModels] : providerModels.filter((m) => only.includes(m));
}

// ---------------------------------------------------------------- events (diff of two effective documents)

export interface RegistryDoc {
  readonly integrations: readonly Integration[];
  readonly installs: readonly IntegrationInstall[];
  readonly routes: GatewayRoutes;
  readonly models: ReadonlyArray<{ model_id: string; provider_id: string }>;
}

export const registryDocOf = (doc: Readonly<Record<string, unknown>> | undefined): RegistryDoc => ({
  integrations: (doc?.[INTEGRATION_CONFIG_KEYS.registry] ?? []) as Integration[],
  installs: (doc?.[INTEGRATION_CONFIG_KEYS.installs] ?? []) as IntegrationInstall[],
  routes: (doc?.[GATEWAY_CONFIG_KEYS.routes] ?? []) as GatewayRoutes,
  models: (doc?.[GATEWAY_CONFIG_KEYS.models] ?? []) as Array<{
    model_id: string;
    provider_id: string;
  }>,
});

const DC = { D0: 0, D1: 1, D2: 2, D3: 3 } as const;

/** A scope WIDENS when it is new, or its data class limit went up. */
const widened = (before: IntegrationScope[], after: IntegrationScope[]): string[] =>
  after.flatMap((s) => {
    const b = before.find((x) => x.scope === s.scope);
    return !b || DC[s.data_class_max] > DC[b.data_class_max] ? [`scope:${s.scope}`] : [];
  });
const narrowed = (before: IntegrationScope[], after: IntegrationScope[]): string[] =>
  before.flatMap((s) => {
    const a = after.find((x) => x.scope === s.scope);
    return !a || DC[a.data_class_max] < DC[s.data_class_max] ? [`scope:${s.scope}`] : [];
  });

export type EventDraft = Omit<IntegrationEvent, 'rev_hash' | 'ledger_entry_id' | 'at'>;

/** What changed between two effective registry documents, as events (the ledger entry and time are added by the caller). */
export function diffRegistry(prev: RegistryDoc | null, next: RegistryDoc): EventDraft[] {
  const out: EventDraft[] = [];
  const ev = (
    integration_id: string,
    event: IntegrationEventKind,
    detail: string | null = null,
    install_id: string | null = null,
  ) => out.push({ integration_id, install_id, event, detail });
  const before = new Map((prev?.integrations ?? []).map((i) => [i.integration_id, i]));
  for (const i of next.integrations) {
    const b = before.get(i.integration_id);
    if (!b) {
      ev(i.integration_id, 'created', i.adapter);
      if (i.status === 'enabled') ev(i.integration_id, 'enabled');
      for (const d of widened([], i.scopes)) ev(i.integration_id, 'scope_widened', d);
      continue;
    }
    if (b.status !== i.status) {
      const e: IntegrationEventKind =
        i.status === 'enabled' ? 'enabled' : i.status === 'retired' ? 'retired' : 'disabled';
      ev(i.integration_id, e, `${b.status}->${i.status}`);
    }
    for (const d of widened(b.scopes, i.scopes)) ev(i.integration_id, 'scope_widened', d);
    for (const d of narrowed(b.scopes, i.scopes)) ev(i.integration_id, 'scope_narrowed', d);
    if (JSON.stringify(b.credentials) !== JSON.stringify(i.credentials)) {
      ev(i.integration_id, 'credential_changed');
    }
    if (JSON.stringify(b.config) !== JSON.stringify(i.config)) {
      ev(i.integration_id, 'config_changed');
    }
  }
  const ib = new Map((prev?.installs ?? []).map((n) => [n.install_id, n]));
  const inext = new Map(next.installs.map((n) => [n.install_id, n]));
  for (const n of next.installs) {
    const b = ib.get(n.install_id);
    if (!b) {
      ev(n.integration_id, 'install_added', n.project_id, n.install_id);
      if (n.enabled) ev(n.integration_id, 'install_enabled', n.project_id, n.install_id);
    } else if (b.enabled !== n.enabled) {
      ev(
        n.integration_id,
        n.enabled ? 'install_enabled' : 'install_disabled',
        n.project_id,
        n.install_id,
      );
    }
  }
  for (const b of prev?.installs ?? []) {
    if (!inext.has(b.install_id)) {
      ev(b.integration_id, 'install_removed', b.project_id, b.install_id);
    }
  }
  const providerOf = (doc: RegistryDoc, model: string) =>
    doc.models.find((m) => m.model_id === model)?.provider_id ?? '(unknown)';
  const key = (r: { environment: string; data_class: string }) =>
    `${r.environment}/${r.data_class}`;
  const rb = new Map((prev?.routes ?? []).map((r) => [key(r), r]));
  for (const r of next.routes) {
    const b = rb.get(key(r));
    if (!b || b.model_id !== r.model_id) {
      ev(providerOf(next, r.model_id), 'route_added', `route:${key(r)}->${r.model_id}`);
    }
  }
  const rn = new Map(next.routes.map((r) => [key(r), r]));
  for (const b of prev?.routes ?? []) {
    const a = rn.get(key(b));
    if (!a || a.model_id !== b.model_id) {
      ev(
        providerOf(prev as RegistryDoc, b.model_id),
        'route_removed',
        `route:${key(b)}->${b.model_id}`,
      );
    }
  }
  return out;
}

/** The changes of a revision that an M1 approver must see named (the gate's evidence lists them in words). */
export function gatedChanges(drafts: readonly EventDraft[]): EventDraft[] {
  const gated = new Set<string>(GATED_INTEGRATION_CHANGES);
  return drafts.filter((d) => gated.has(d.event));
}
