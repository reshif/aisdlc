import {
  ADAPTER_CONFIG,
  IntegrationRegistryView,
  type Integration,
  type IntegrationHealthReport,
  type IntegrationHealthState,
  type RegisteredRepo,
} from '@aisdlc/contracts';
import { enabledOf } from '@aisdlc/integrations';
import { ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import {
  CODEHOST_PORT_METHODS,
  readUnknown,
  repoKey,
  type RegisteredReposError,
  type RegisteredReposPort,
} from '@aisdlc/ports';
import { callJson, type Env } from '@aisdlc/service-kit';
import { GitHubRestCodeHost } from './adapter.js';
import { AppKey } from './app-key.js';
import { AllowListedCodeHost } from './repo-allow-list.js';
import { TokenBroker } from './token-broker.js';
import { GitHubTransport } from './transport.js';

// The codehost's adapter, selected by the integration registry (PLAN M10.4; RV §5.1: a plugin class in the
// key-holding process, chosen by a row). The codehost has no database: it reads the effective registry from
// core's API (`GET /v1/integrations?kind=code_host`), follows it by config revision with a poll and a reload
// endpoint (`POST /v1/admin/reload`), and rebuilds its GitHub adapter when its row changes, without a
// restart. The REGISTRY names the row (adapter, app id, installation, URLs, the credential REFERENCE); this
// process's DEPLOYMENT says what it may do with it, exactly as in the gateway:
//
//   CODEHOST_SECRET_REFS   the key references (its mounted files) a row may name
//   CODEHOST_EGRESS_HOSTS  the hosts the App's credentials may be sent to
//
// The App key stays in its own file, read here once per build and held by `AppKey` alone. Until the row is
// readable and enabled the codehost serves nothing: every read answers `unknown` (fail closed).

export interface HostRuntime {
  readonly host: AllowListedCodeHost;
  readonly broker: TokenBroker;
  readonly integration_id: string;
  /** The config revision the runtime was built from. */
  readonly revision: string | null;
}

export interface SelectorPolicy {
  readonly env: Env;
  readonly secretRefs: ReadonlySet<string>;
  readonly egressHosts: ReadonlySet<string>;
}

export type SelectorDetail =
  | 'ok'
  | 'registry_unreachable'
  | 'registry_malformed'
  | 'integration_missing'
  | 'integration_not_enabled'
  | 'adapter_unknown'
  | 'credential_missing'
  | 'secret_ref_not_allowed'
  | 'secret_unreadable'
  | 'egress_not_allowed'
  | 'config_invalid';

export interface SelectorStatus {
  readonly integration_id: string;
  readonly state: 'serving' | 'unavailable';
  readonly detail: SelectorDetail;
  readonly revision: string | null;
}

export interface SelectorOptions {
  readonly integrationId: string;
  readonly core: { readonly url: string; readonly token: string };
  readonly policy: SelectorPolicy;
  /** The registered repos (core's), which the row's installs then narrow. */
  readonly registered: RegisteredReposPort;
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly bundleCapBytes: number;
  readonly bundleTimeoutMs: number;
  readonly requestLog?: (e: { method: string; path: string; status: number; auth: string }) => void;
}

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_GIT = 'https://github.com';
/** How long a GitHub answer counts as evidence of health. */
const EVIDENCE_MS = 900_000;

/**
 * An `AllowListedCodeHost` that answers `unknown` to everything (the codehost before its row is
 * readable). Built from the port's own method list so a new method cannot be forgotten.
 */
function unavailableHost(): AllowListedCodeHost {
  const answer = async () =>
    readUnknown('registry_unavailable', 'the code host integration is not available');
  const o: Record<string, unknown> = { projectOf: answer };
  for (const m of CODEHOST_PORT_METHODS) o[m] = answer;
  return o as unknown as AllowListedCodeHost;
}

/** Registered repos narrowed by the project installs of this integration (disabled, or a repos allow-list). */
export class NarrowedRegisteredRepos implements RegisteredReposPort {
  constructor(
    private readonly inner: RegisteredReposPort,
    private readonly view: Pick<IntegrationRegistryView, 'installs'>,
    private readonly integration_id: string,
  ) {}

  async list(): Promise<Result<RegisteredRepo[], RegisteredReposError>> {
    const r = await this.inner.list();
    if (!r.ok) return r;
    return ok(
      r.value.filter((row) => {
        const n = this.view.installs.find(
          (x) => x.integration_id === this.integration_id && x.project_id === row.project_id,
        );
        if (!n) return true; // no install row: the fleet-wide integration, every registered repo
        if (!n.enabled) return false;
        const only = n.overrides.repos_allowed;
        return only === undefined || only.some((x) => repoKey(x) === repoKey(row.repo));
      }),
    );
  }
}

export class RegistryHostSelector {
  private runtime: HostRuntime | null = null;
  private fingerprint = '';
  private status: SelectorStatus;
  private readonly unavailable = unavailableHost();
  private evidence: { code: 'ok' | 'auth' | 'rate_limited' | 'unavailable'; at: number } | null =
    null;
  private readonly clock: Clock;

  constructor(private readonly o: SelectorOptions) {
    this.clock = o.clock ?? systemClock;
    this.status = {
      integration_id: o.integrationId,
      state: 'unavailable',
      detail: 'registry_unreachable',
      revision: null,
    };
  }

  /** The host to serve with now: the row's, or one that answers `unknown`. */
  get host(): AllowListedCodeHost {
    return this.runtime?.host ?? this.unavailable;
  }

  get broker(): TokenBroker | undefined {
    return this.runtime?.broker;
  }

  get current(): SelectorStatus {
    return this.status;
  }

  private fail(detail: SelectorDetail, revision: string | null): SelectorStatus {
    this.runtime = null;
    this.fingerprint = '';
    this.status = {
      integration_id: this.o.integrationId,
      state: 'unavailable',
      detail,
      revision,
    };
    return this.status;
  }

  /**
   * Reads the registry and (re)builds if the row changed (`force`: always, which picks up a rotated key
   * file). A failure to read leaves what is serving in place (a core restart is not an outage of the
   * code host), but a row that is now disabled, gone or no longer allowed stops serving at once.
   */
  async sync(opts: { force?: boolean } = {}): Promise<SelectorStatus> {
    const r = await callJson({
      baseUrl: this.o.core.url,
      token: this.o.core.token,
      method: 'GET',
      path: '/v1/integrations?kind=code_host',
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      timeoutMs: 5_000,
    });
    if (!r.reached || r.status < 200 || r.status > 299) {
      if (this.runtime) return this.status; // keep serving the last good row
      return this.fail('registry_unreachable', null);
    }
    const parsed = IntegrationRegistryView.safeParse(r.json);
    if (!parsed.success) return this.fail('registry_malformed', null);
    const view = parsed.data;
    const row = enabledOf(view, 'code_host').find((i) => i.integration_id === this.o.integrationId);
    if (!row) {
      const exists = view.integrations.some((i) => i.integration_id === this.o.integrationId);
      return this.fail(exists ? 'integration_not_enabled' : 'integration_missing', view.revision);
    }
    const fingerprint = JSON.stringify([
      row,
      view.installs.filter((n) => n.integration_id === row.integration_id),
    ]);
    if (this.runtime && fingerprint === this.fingerprint && opts.force !== true) {
      this.status = { ...this.status, revision: view.revision };
      return this.status;
    }
    const built = this.build(row, view);
    if (typeof built === 'string') return this.fail(built, view.revision);
    this.runtime = { ...built, integration_id: row.integration_id, revision: view.revision };
    this.fingerprint = fingerprint;
    this.status = {
      integration_id: row.integration_id,
      state: 'serving',
      detail: 'ok',
      revision: view.revision,
    };
    this.o.log?.(
      `integration ${row.integration_id} (${row.adapter}) serving from registry revision ${view.revision?.slice(0, 12) ?? 'none'}`,
    );
    return this.status;
  }

  private build(
    row: Integration,
    view: IntegrationRegistryView,
  ): { host: AllowListedCodeHost; broker: TokenBroker } | SelectorDetail {
    const p = this.o.policy;
    if (row.adapter !== 'github_app' && row.adapter !== 'fake_github') return 'adapter_unknown';
    const cred = row.credentials.find((c) => c.kind === 'app_key');
    if (!cred) return 'credential_missing';
    if (!p.secretRefs.has(cred.secret_ref)) return 'secret_ref_not_allowed';
    const cfg = ADAPTER_CONFIG[row.adapter].safeParse(row.config);
    if (!cfg.success) return 'config_invalid';
    const apiUrl = cfg.data.api_url ?? DEFAULT_API;
    const gitUrl = (cfg.data.git_url ?? DEFAULT_GIT).replace(/\/+$/, '');
    try {
      if (
        !p.egressHosts.has(new URL(apiUrl).hostname) ||
        !p.egressHosts.has(new URL(gitUrl).hostname)
      ) {
        return 'egress_not_allowed';
      }
    } catch {
      return 'config_invalid';
    }
    let appKey: AppKey;
    try {
      appKey = AppKey.fromRef(cred.secret_ref, { env: p.env });
    } catch {
      return 'secret_unreadable';
    }
    const mode = cfg.data.mode ?? 'census';
    const note = (status: number) => {
      const code =
        status >= 200 && status < 400
          ? 'ok'
          : status === 401 || status === 403
            ? 'auth'
            : status === 429
              ? 'rate_limited'
              : status >= 500
                ? 'unavailable'
                : null;
      // a 404 or another 4xx is about the repo asked for, not about the integration
      if (code !== null) this.evidence = { code, at: this.clock.nowMs() };
    };
    const clock = this.clock;
    const broker = new TokenBroker({
      appKey,
      appId: cfg.data.app_id,
      installationId: cfg.data.installation_id,
      baseUrl: apiUrl,
      mode,
      clock,
      onMint: (e) => {
        note(e.status);
        this.o.requestLog?.(e);
      },
    });
    const transport = new GitHubTransport({
      baseUrl: apiUrl,
      broker,
      mode,
      log: (line) => this.o.log?.(line),
      onRequest: (e) => {
        note(e.status);
        this.o.requestLog?.(e);
      },
    });
    const host = new AllowListedCodeHost(
      new GitHubRestCodeHost({
        transport,
        installationId: cfg.data.installation_id,
        clock,
        git: {
          broker,
          gitBaseUrl: gitUrl,
          capBytes: this.o.bundleCapBytes,
          timeoutMs: this.o.bundleTimeoutMs,
          log: (line) => this.o.log?.(line),
          ...(this.o.requestLog
            ? {
                onFetch: (e: { method: string; path: string; status: number; auth: string }) =>
                  this.o.requestLog?.(e),
              }
            : {}),
        },
      }),
      new NarrowedRegisteredRepos(this.o.registered, view, row.integration_id),
    );
    return { host, broker };
  }

  /** The shared health shape for this integration, from what the row and GitHub's answers showed. */
  health(): IntegrationHealthReport['reports'] {
    const id = this.o.integrationId;
    if (this.status.state === 'unavailable') {
      return [{ integration_id: id, state: 'down', detail_code: this.status.detail }];
    }
    const e = this.evidence;
    if (!e || this.clock.nowMs() - e.at > EVIDENCE_MS) {
      return [{ integration_id: id, state: 'unknown', detail_code: 'no_recent_call' }];
    }
    const map: Record<string, { state: IntegrationHealthState; detail: string }> = {
      ok: { state: 'ok', detail: 'ok' },
      auth: { state: 'down', detail: 'auth_failed' },
      rate_limited: { state: 'degraded', detail: 'rate_limited' },
      unavailable: { state: 'degraded', detail: 'unavailable' },
    };
    const m = map[e.code] as { state: IntegrationHealthState; detail: string };
    return [{ integration_id: id, state: m.state, detail_code: m.detail }];
  }
}

/** Reports a reporter's health to core (`POST /v1/integrations/health`); never throws. */
export async function reportHealth(
  core: { url: string; token: string },
  reports: IntegrationHealthReport['reports'],
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const r = await callJson({
    baseUrl: core.url,
    token: core.token,
    method: 'POST',
    path: '/v1/integrations/health',
    body: { reporter: 'codehost', reports },
    ...(fetchImpl ? { fetchImpl } : {}),
    timeoutMs: 5_000,
  });
  return r.reached && r.status >= 200 && r.status < 300;
}
