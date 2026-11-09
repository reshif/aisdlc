import {
  ADAPTER_KIND,
  INTEGRATION_FORBIDDEN,
  Integration,
  IntegrationHealth,
  IntegrationInstalls,
  INTEGRATION_HEALTH_STALE_MS,
  aggregateHealth,
  effectiveHealthState,
} from '@aisdlc/contracts';
import { makeCanary } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import {
  codeHostRow,
  diffRegistry,
  enabledFor,
  enabledOf,
  gatedChanges,
  integrationScope,
  modelProviderRow,
  modelsAllowedFor,
  registryDocOf,
} from '../src/index.js';

const KEY_REF = 'file:/run/secrets/anthropic-api-key';
const anthropic = (over = {}) =>
  modelProviderRow('anthropic', 'anthropic', {
    credentials: [{ credential_id: 'k', secret_ref: KEY_REF, kind: 'api_key' }],
    ...over,
  });

describe('Integration rows', () => {
  it('accepts a model provider and a code host, one registry for both', () => {
    expect(Integration.safeParse(anthropic()).success).toBe(true);
    const gh = codeHostRow(
      'github-app',
      'github_app',
      { app_id: '123456', installation_id: 7 },
      {
        credentials: [
          {
            credential_id: 'app-key',
            secret_ref: 'file:/run/secrets/github-app.pem',
            kind: 'app_key',
          },
        ],
      },
    );
    expect(Integration.safeParse(gh).success).toBe(true);
    expect(ADAPTER_KIND.github_app).toBe('code_host');
    expect(ADAPTER_KIND.openai_compat).toBe('model_provider');
  });

  it('holds references only: a credential that is a value, not a reference, is refused', () => {
    for (const bad of [
      'sk-live-0123456789abcdef',
      '/run/secrets/x',
      'file:relative/path',
      'env:lower',
      makeCanary('v'),
    ]) {
      const r = Integration.safeParse(
        anthropic({ credentials: [{ credential_id: 'k', secret_ref: bad, kind: 'api_key' }] }),
      );
      expect(r.success, bad).toBe(false);
    }
  });

  it('carries the D11 forbidden list on every scope, and a scope can never be one of the forbidden verbs', () => {
    expect(INTEGRATION_FORBIDDEN).toEqual([
      'merge',
      'enqueue',
      'approve',
      'auto_merge',
      'force',
      'delete',
      'dismiss',
      'admin',
    ]);
    for (const v of INTEGRATION_FORBIDDEN) {
      const missing = anthropic({
        scopes: [
          {
            scope: 'chat_complete',
            data_class_max: 'D2',
            forbidden: INTEGRATION_FORBIDDEN.filter((x) => x !== v),
          },
        ],
      });
      expect(Integration.safeParse(missing).success, `without ${v}`).toBe(false);
      const asScope = anthropic({
        scopes: [{ scope: v, data_class_max: 'D0', forbidden: [...INTEGRATION_FORBIDDEN] }],
      });
      expect(Integration.safeParse(asScope).success, `scope ${v}`).toBe(false);
    }
    expect(
      Integration.safeParse(anthropic({ scopes: [integrationScope('chat_complete', 'D2')] }))
        .success,
    ).toBe(true);
  });

  it('refuses D3 on a model provider, a scope the kind cannot carry, an adapter of the wrong kind, and an enabled row with nothing to use', () => {
    expect(
      Integration.safeParse(anthropic({ scopes: [integrationScope('chat_complete', 'D3')] }))
        .success,
    ).toBe(false);
    expect(
      Integration.safeParse(anthropic({ scopes: [integrationScope('read_repos', 'D1')] })).success,
    ).toBe(false);
    expect(Integration.safeParse({ ...anthropic(), kind: 'code_host' }).success).toBe(false);
    expect(Integration.safeParse(anthropic({ credentials: [] })).success).toBe(false); // enabled, no credential
    expect(Integration.safeParse(anthropic({ credentials: [], status: 'draft' })).success).toBe(
      true,
    );
    expect(Integration.safeParse(anthropic({ scopes: [] })).success).toBe(false);
    // settings are by adapter and strict
    expect(Integration.safeParse(anthropic({ config: { nonsense: 1 } })).success).toBe(false);
    expect(
      Integration.safeParse(
        modelProviderRow('codex', 'openai_compat', {
          credentials: [{ credential_id: 'k', secret_ref: KEY_REF, kind: 'api_key' }],
        }),
      ).success,
    ).toBe(false); // no base_url
    expect(
      Integration.safeParse(
        modelProviderRow('codex', 'openai_compat', {
          config: { base_url: 'https://user:pw@api.example.com/v1' },
          credentials: [{ credential_id: 'k', secret_ref: KEY_REF, kind: 'api_key' }],
        }),
      ).success,
    ).toBe(false); // credentials in a URL
  });

  it('installs are unique per project and integration', () => {
    const n = (id: string, project: string) => ({
      install_id: id,
      integration_id: 'anthropic',
      project_id: project,
      enabled: true,
      overrides: {},
    });
    expect(IntegrationInstalls.safeParse([n('a', 'p1'), n('b', 'p2')]).success).toBe(true);
    expect(IntegrationInstalls.safeParse([n('a', 'p1'), n('b', 'p1')]).success).toBe(false);
    expect(IntegrationInstalls.safeParse([n('a', 'p1'), n('a', 'p2')]).success).toBe(false);
  });
});

describe('health: the 2-minute staleness rule', () => {
  const T = Date.parse('2026-11-09T10:00:00.000Z');
  const at = (ms: number) => new Date(T - ms).toISOString();
  it('a fresh report is what it says, an older one reads unknown, never green', () => {
    expect(INTEGRATION_HEALTH_STALE_MS).toBe(120_000);
    expect(effectiveHealthState({ state: 'ok', as_of: at(0) }, T)).toBe('ok');
    expect(effectiveHealthState({ state: 'ok', as_of: at(120_000) }, T)).toBe('ok');
    expect(effectiveHealthState({ state: 'ok', as_of: at(120_001) }, T)).toBe('unknown');
    expect(effectiveHealthState({ state: 'down', as_of: at(10 * 60_000) }, T)).toBe('unknown');
    // fail closed on what cannot be trusted: a report from the future, an unreadable time
    expect(effectiveHealthState({ state: 'ok', as_of: at(-5_000) }, T)).toBe('unknown');
    expect(effectiveHealthState({ state: 'ok', as_of: 'yesterday' }, T)).toBe('unknown');
  });
  it('the worst fresh reporter decides; no report is unknown; one stale reporter is unknown, not ok', () => {
    expect(aggregateHealth([], T)).toBe('unknown');
    expect(aggregateHealth([{ state: 'ok', as_of: at(1000) }], T)).toBe('ok');
    expect(
      aggregateHealth(
        [
          { state: 'ok', as_of: at(1000) },
          { state: 'degraded', as_of: at(1000) },
        ],
        T,
      ),
    ).toBe('degraded');
    expect(
      aggregateHealth(
        [
          { state: 'ok', as_of: at(1000) },
          { state: 'down', as_of: at(1000) },
        ],
        T,
      ),
    ).toBe('down');
    expect(
      aggregateHealth(
        [
          { state: 'ok', as_of: at(1000) },
          { state: 'ok', as_of: at(500_000) },
        ],
        T,
      ),
    ).toBe('unknown');
  });
  it('a health row has a code, never free text', () => {
    const ok = {
      integration_id: 'x',
      reporter: 'gateway',
      state: 'ok',
      detail_code: 'ok',
      as_of: at(0),
    };
    expect(IntegrationHealth.safeParse(ok).success).toBe(true);
    expect(
      IntegrationHealth.safeParse({ ...ok, detail_code: 'The vendor said: key sk-abc is bad' })
        .success,
    ).toBe(false);
  });
});

describe('reading the registry', () => {
  const view: Parameters<typeof enabledFor>[0] = {
    integrations: [
      anthropic(),
      anthropic({ integration_id: 'old', status: 'retired' }),
      modelProviderRow('fake', 'fake'),
    ],
    installs: [
      {
        install_id: 'i1',
        integration_id: 'anthropic',
        project_id: 'p1' as never,
        enabled: true,
        overrides: { models_allowed: ['m-a'] },
      },
      {
        install_id: 'i2',
        integration_id: 'anthropic',
        project_id: 'p2' as never,
        enabled: false,
        overrides: {},
      },
    ],
  };
  it('enabled rows only, by kind and adapter', () => {
    expect(enabledOf(view, 'model_provider').map((i) => i.integration_id)).toEqual([
      'anthropic',
      'fake',
    ]);
    expect(enabledOf(view, 'model_provider', 'fake').map((i) => i.integration_id)).toEqual([
      'fake',
    ]);
    expect(enabledOf(view, 'code_host')).toEqual([]);
  });
  it('an install enables a project; no row, a disabled row, or a retired integration is not a yes; overrides only narrow', () => {
    expect(enabledFor(view, 'anthropic', 'p1').enabled).toBe(true);
    expect(enabledFor(view, 'anthropic', 'p2').enabled).toBe(false);
    expect(enabledFor(view, 'anthropic', 'p3').enabled).toBe(false);
    expect(enabledFor(view, 'old', 'p1').enabled).toBe(false);
    expect(modelsAllowedFor(view.installs[0] ?? null, ['m-a', 'm-b'])).toEqual(['m-a']);
    expect(modelsAllowedFor(null, ['m-a', 'm-b'])).toEqual(['m-a', 'm-b']);
    expect(
      modelsAllowedFor({ ...view.installs[0]!, overrides: { models_allowed: ['m-z'] } }, ['m-a']),
    ).toEqual([]);
  });
});

describe('IntegrationEvent: what a revision did', () => {
  const doc = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    registryDocOf({ 'integrations.registry': rows, ...extra });
  it('names creation, enabling, widening, narrowing, credential and install changes, and a new route', () => {
    const v1 = doc([
      anthropic({ status: 'draft', scopes: [integrationScope('chat_complete', 'D1')] }),
    ]);
    const first = diffRegistry(null, v1);
    expect(first.map((e) => e.event)).toEqual(['created', 'scope_widened']);
    const v2 = doc([anthropic({ scopes: [integrationScope('chat_complete', 'D2')] })], {
      'integrations.installs': [
        {
          install_id: 'i1',
          integration_id: 'anthropic',
          project_id: 'p1' as never,
          enabled: true,
          overrides: {},
        },
      ],
      'gateway.models': [{ model_id: 'm', provider_id: 'anthropic' }],
      'gateway.routes': [{ environment: 'local', data_class: 'D2', model_id: 'm' }],
    });
    const second = diffRegistry(v1, v2);
    expect(second.map((e) => `${e.event}${e.detail ? `:${e.detail}` : ''}`)).toEqual([
      'enabled:draft->enabled',
      'scope_widened:scope:chat_complete',
      'install_added:p1',
      'install_enabled:p1',
      'route_added:route:local/D2->m',
    ]);
    // each of those is one an M1 approver must see named
    expect(gatedChanges(second)).toHaveLength(5);
    const v3 = doc([
      anthropic({
        scopes: [integrationScope('chat_complete', 'D0')],
        credentials: [{ credential_id: 'k2', secret_ref: KEY_REF, kind: 'api_key' }],
        status: 'disabled',
      }),
    ]);
    const third = diffRegistry(v2, v3);
    expect(third.map((e) => e.event)).toEqual([
      'disabled',
      'scope_narrowed',
      'credential_changed',
      'install_removed',
      'route_removed',
    ]);
    expect(gatedChanges(third)).toEqual([]); // narrowing and switching off are never the gated direction
    expect(diffRegistry(v3, v3)).toEqual([]);
  });
});
