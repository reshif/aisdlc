import {
  ADAPTER_CONFIG,
  type GatewayEnvironment,
  type Integration,
  type IntegrationHealthState,
} from '@aisdlc/contracts';
import { enabledOf, readRegistry } from '@aisdlc/integrations';
import { FakeProvider, planningFixtureReply, type ModelProviderPort } from '@aisdlc/ports';
import { resolveSecretRef, type Env } from '@aisdlc/service-kit';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAICompatProvider } from './openai-compat-provider.js';
import type { AdapterSource, ConfigSource } from './routes.js';

// The model adapters this process holds, selected by the integration registry (PLAN M10.4; RV §5: plugins
// in the key-holding process, image x config). The REGISTRY says which providers exist, with which adapter,
// base URL and credential reference; this process's own DEPLOYMENT says what it may do with them:
//
//   GATEWAY_SECRET_REFS    the secret references (its mounted key files) a registry row may name
//   GATEWAY_EGRESS_HOSTS   the hosts a vendor key may be sent to
//
// A row that names another reference or host is REFUSED (`secret_ref_not_allowed`, `egress_not_allowed`):
// a published revision can switch providers on and off and point routes at them, but it can never make the
// gateway read a file it was not given or send a key somewhere new. The secrets stay in their own files,
// read here once per build and held by the adapter alone; the registry holds references only.

export interface AdapterPolicy {
  readonly env: Env;
  readonly environment: GatewayEnvironment;
  readonly secretRefs: ReadonlySet<string>;
  readonly egressHosts: ReadonlySet<string>;
}

export type AdapterRefusal =
  | 'adapter_unknown'
  | 'fake_not_allowed'
  | 'credential_missing'
  | 'secret_ref_not_allowed'
  | 'secret_unreadable'
  | 'egress_not_allowed'
  | 'config_invalid';

export interface AdapterStatus {
  readonly integration_id: string;
  readonly adapter: string;
  readonly state: 'built' | 'refused';
  /** A code, never text from a file or a vendor. */
  readonly detail: AdapterRefusal | 'ok';
}

const DEFAULT_HOSTS: Record<string, string> = { anthropic: 'https://api.anthropic.com' };

interface Held {
  readonly fingerprint: string;
  readonly adapter: ModelProviderPort;
}

export class RegistryAdapters implements AdapterSource {
  private held = new Map<string, Held>();
  private statuses: AdapterStatus[] = [];
  private lastRevision: string | null = null;

  constructor(
    private readonly policy: AdapterPolicy,
    private readonly source: ConfigSource,
  ) {}

  get(id: string): ModelProviderPort | undefined {
    return this.held.get(id)?.adapter;
  }

  get revision(): string | null {
    return this.lastRevision;
  }

  /** What the last sync did, per enabled model provider of the registry. */
  status(): readonly AdapterStatus[] {
    return this.statuses;
  }

  /**
   * Reads the registry from the current config snapshot and (re)builds what changed. An unchanged row
   * keeps its adapter (and so its connection state); `force` rebuilds every one, which is how a rotated
   * key file is picked up. A row that is gone, disabled or no longer buildable is dropped at once.
   */
  sync(opts: { force?: boolean } = {}): readonly AdapterStatus[] {
    const view = readRegistry(this.source.current());
    const next = new Map<string, Held>();
    const statuses: AdapterStatus[] = [];
    for (const row of enabledOf(view, 'model_provider')) {
      const fingerprint = JSON.stringify([
        row.adapter,
        row.config,
        row.credentials.map((c) => c.secret_ref),
        row.provider,
      ]);
      const had = this.held.get(row.integration_id);
      if (had && had.fingerprint === fingerprint && opts.force !== true) {
        next.set(row.integration_id, had);
        statuses.push({
          integration_id: row.integration_id,
          adapter: row.adapter,
          state: 'built',
          detail: 'ok',
        });
        continue;
      }
      const built = this.build(row);
      if (typeof built === 'string') {
        statuses.push({
          integration_id: row.integration_id,
          adapter: row.adapter,
          state: 'refused',
          detail: built,
        });
      } else {
        next.set(row.integration_id, { fingerprint, adapter: built });
        statuses.push({
          integration_id: row.integration_id,
          adapter: row.adapter,
          state: 'built',
          detail: 'ok',
        });
      }
    }
    this.held = next;
    this.statuses = statuses;
    this.lastRevision = view.revision;
    return statuses;
  }

  private build(row: Integration): ModelProviderPort | AdapterRefusal {
    const p = this.policy;
    if (row.adapter === 'fake') {
      // A deterministic fake answering for a real route would be a silent downgrade in production.
      if (p.environment === 'prod') return 'fake_not_allowed';
      const cfg = ADAPTER_CONFIG.fake.safeParse(row.config);
      if (!cfg.success) return 'config_invalid';
      return new FakeProvider({
        tools_capable: cfg.data.tools_capable ?? row.provider?.tools_capable ?? true,
        ...(cfg.data.fixtures === 'planning' ? { respond: planningFixtureReply } : {}),
      });
    }
    if (row.adapter !== 'anthropic' && row.adapter !== 'openai_compat') return 'adapter_unknown';
    const cred = row.credentials.find((c) => c.kind === 'api_key');
    if (!cred) return 'credential_missing';
    if (!p.secretRefs.has(cred.secret_ref)) return 'secret_ref_not_allowed';
    const cfg = ADAPTER_CONFIG[row.adapter].safeParse(row.config);
    if (!cfg.success) return 'config_invalid';
    const baseUrl =
      (cfg.data as { base_url?: string }).base_url ?? DEFAULT_HOSTS[row.adapter] ?? '';
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return 'config_invalid';
    }
    if (!p.egressHosts.has(host)) return 'egress_not_allowed';
    let key: string;
    try {
      // A key that cannot be read (or is too short to be one) is a refusal of the row, never a fallback.
      key = resolveSecretRef(cred.secret_ref, { env: p.env });
    } catch {
      return 'secret_unreadable';
    }
    if (row.adapter === 'anthropic') {
      const c = cfg.data as {
        base_url?: string;
        models?: ConstructorParameters<typeof AnthropicProvider>[0]['models'];
      };
      return new AnthropicProvider({
        apiKey: key,
        ...(c.base_url ? { baseUrl: c.base_url } : {}),
        ...(c.models ? { models: c.models } : {}),
      });
    }
    const c = cfg.data as {
      base_url: string;
      request_timeout_ms?: number;
      max_tokens_param?: 'max_tokens' | 'max_completion_tokens';
    };
    return new OpenAICompatProvider({
      apiKey: key,
      baseUrl: c.base_url,
      toolsCapable: row.provider?.tools_capable ?? true,
      ...(c.request_timeout_ms ? { timeoutMs: c.request_timeout_ms } : {}),
      ...(c.max_tokens_param ? { maxTokensParam: c.max_tokens_param } : {}),
    });
  }
}

/** What a build status means for the shared health shape (before any call has been made). */
export const healthOfStatus = (
  s: AdapterStatus,
): { state: IntegrationHealthState; detail: string } =>
  s.state === 'built'
    ? { state: 'unknown', detail: 'no_recent_call' }
    : { state: 'down', detail: s.detail };
