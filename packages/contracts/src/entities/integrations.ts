import { z } from 'zod';
import { AnthropicDefaultModels } from './gateway.js';
import { CODEHOST_FORBIDDEN_VERBS, CodeHostForbiddenVerb } from './codehost.js';
import { IsoDateTime, PrincipalId, ProjectId } from './ids.js';
import { DataClass } from '../values.js';

// The Integration registry (PLAN M10.4; DM §4.1; decided 2026-11-08: ONE registry for code hosts and model
// providers, with a shared health shape). Everything here is CONFIG, published through `config_publish`
// behind an M1 gate, in two factory-layer keys:
//
//   `integrations.registry`  Integration rows, each with its credentials (REFERENCES only, never a value)
//                            and its scopes (with the D11 forbidden list)
//   `integrations.installs`  IntegrationInstall rows: an integration enabled for one project, with overrides
//
// The model provider of the DM (`ModelProvider`) is an Integration of kind `model_provider` (its
// `provider_id` is the `integration_id`); its models and routes stay the `gateway.models` and
// `gateway.routes` keys (`ProviderModel`, `Route`). IntegrationHealth is NOT config: the processes that
// hold the adapters report it, and a report older than two minutes reads `unknown`, never green.

export const INTEGRATION_CONFIG_KEYS = {
  registry: 'integrations.registry',
  installs: 'integrations.installs',
} as const;

const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, 'lowercase slug');

export const IntegrationKind = z.enum([
  'code_host',
  'model_provider',
  'notifier',
  'tracker',
  'identity',
]);
export type IntegrationKind = z.infer<typeof IntegrationKind>;

/**
 * Adapters the factory has a class for. A row naming another adapter is refused (unknown means unmet),
 * so adding GitLab or Slack is a class plus a name here, never a free-text string in a row.
 * `openai_compat` is the one OpenAI-compatible chat-completions adapter: Codex and DeepSeek are two ROWS of it.
 */
export const IntegrationAdapter = z.enum([
  'github_app',
  'fake_github',
  'anthropic',
  'openai_compat',
  'fake',
]);
export type IntegrationAdapter = z.infer<typeof IntegrationAdapter>;

/** Which kind each adapter serves. */
export const ADAPTER_KIND: Readonly<Record<IntegrationAdapter, IntegrationKind>> = {
  github_app: 'code_host',
  fake_github: 'code_host',
  anthropic: 'model_provider',
  openai_compat: 'model_provider',
  fake: 'model_provider',
};

export const IntegrationStatus = z.enum(['draft', 'enabled', 'disabled', 'retired']);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** The shape of a secret reference; its `source` is the `pattern` a JSON Schema of a SecretRef carries. */
export const SECRET_REF_PATTERN = /^(file:\/[A-Za-z0-9_./-]{1,200}|env:[A-Z][A-Z0-9_]{0,63})$/;

/** A reference to a secret: a `file:` path or an `env:` name. Never a value (the check is by shape). */
export const SecretRef = z
  .string()
  .regex(
    SECRET_REF_PATTERN,
    'a secret reference: file:/absolute/path or env:NAME (never the secret itself)',
  );

export const IntegrationCredentialKind = z.enum(['app_key', 'pat', 'api_key', 'oauth']);
export type IntegrationCredentialKind = z.infer<typeof IntegrationCredentialKind>;

/** IntegrationCredential: where the secret lives, not the secret. */
export const IntegrationCredential = z.strictObject({
  credential_id: Slug,
  secret_ref: SecretRef,
  kind: IntegrationCredentialKind,
  rotated_at: IsoDateTime.optional(),
  expires_at: IsoDateTime.optional(),
});
export type IntegrationCredential = z.infer<typeof IntegrationCredential>;

/** What an integration may do. Never one of the forbidden verbs: those are not scopes, they are refusals. */
export const IntegrationScopeName = z.enum([
  'read_repos',
  'apply_patch',
  'pr_status',
  'chat_complete',
  'notify',
]);
export type IntegrationScopeName = z.infer<typeof IntegrationScopeName>;

/** The scopes each kind may carry. */
export const KIND_SCOPES: Readonly<Record<IntegrationKind, readonly IntegrationScopeName[]>> = {
  code_host: ['read_repos', 'apply_patch', 'pr_status'],
  model_provider: ['chat_complete'],
  notifier: ['notify'],
  tracker: ['notify'],
  identity: [],
};

/** The D11 list (`CODEHOST_FORBIDDEN_VERBS`): every scope row carries all of it; a row that lacks one is refused. */
export const INTEGRATION_FORBIDDEN: readonly CodeHostForbiddenVerb[] = CODEHOST_FORBIDDEN_VERBS;

export const IntegrationScope = z
  .strictObject({
    scope: IntegrationScopeName,
    data_class_max: DataClass,
    forbidden: z.array(CodeHostForbiddenVerb).max(16),
  })
  .refine(
    (s) => INTEGRATION_FORBIDDEN.every((v) => s.forbidden.includes(v)),
    `forbidden must list every verb of the D11 list: ${INTEGRATION_FORBIDDEN.join(', ')}`,
  );
export type IntegrationScope = z.infer<typeof IntegrationScope>;

/** Non-secret settings by adapter. Strict: a key nobody declared is refused. */
const Url = z
  .url()
  .max(300)
  .refine((u) => {
    try {
      const p = new URL(u);
      return (
        p.username === '' &&
        p.password === '' &&
        (p.protocol === 'https:' || p.protocol === 'http:')
      );
    } catch {
      return false;
    }
  }, 'an http(s) URL without credentials in it');

export const ADAPTER_CONFIG = {
  github_app: z.strictObject({
    app_id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
    installation_id: z.number().int().min(1),
    api_url: Url.optional(),
    git_url: Url.optional(),
    mode: z.literal('census').optional(),
  }),
  fake_github: z.strictObject({
    app_id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
    installation_id: z.number().int().min(1),
    api_url: Url.optional(),
    git_url: Url.optional(),
    mode: z.literal('census').optional(),
  }),
  anthropic: z.strictObject({
    base_url: Url.optional(),
    models: AnthropicDefaultModels.optional(),
  }),
  openai_compat: z.strictObject({
    base_url: Url,
    request_timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    /** Newer OpenAI models want `max_completion_tokens`; most compatible vendors take `max_tokens` (default). */
    max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  }),
  fake: z.strictObject({
    tools_capable: z.boolean().optional(),
    /** `planning`: answers the planning steps with canned valid outputs (a local stack only). */
    fixtures: z.literal('planning').optional(),
  }),
} as const satisfies Record<IntegrationAdapter, z.ZodType>;

/** DM `ModelProvider` facts, for an integration of kind `model_provider`. */
export const ModelProviderFacts = z.strictObject({
  tools_capable: z.boolean(),
  streams: z.boolean(),
  aws_only: z.boolean(),
});
export type ModelProviderFacts = z.infer<typeof ModelProviderFacts>;

export const Integration = z
  .strictObject({
    integration_id: Slug,
    kind: IntegrationKind,
    adapter: IntegrationAdapter,
    display_name: z.string().min(1).max(120),
    /** Non-secret settings (base URL, org, app id, region): validated by adapter. */
    config: z.record(z.string(), z.unknown()),
    status: IntegrationStatus,
    owner: PrincipalId.optional(),
    /** Increases with every published change of this row (the registry's own count, not the config revision's). */
    version: z.number().int().min(1),
    credentials: z.array(IntegrationCredential).max(8),
    scopes: z.array(IntegrationScope).max(8),
    /** Required for `model_provider`, absent otherwise. */
    provider: ModelProviderFacts.optional(),
  })
  .superRefine((i, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (ADAPTER_KIND[i.adapter] !== i.kind) {
      bad(['adapter'], `adapter ${i.adapter} serves ${ADAPTER_KIND[i.adapter]}, not ${i.kind}`);
      return;
    }
    const cfg = ADAPTER_CONFIG[i.adapter].safeParse(i.config);
    if (!cfg.success) {
      bad(['config'], cfg.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
    }
    if ((i.kind === 'model_provider') !== (i.provider !== undefined)) {
      bad(['provider'], 'provider facts belong to model_provider integrations, and only to them');
    }
    const allowed = KIND_SCOPES[i.kind];
    const seen = new Set<string>();
    for (const [n, s] of i.scopes.entries()) {
      if (!allowed.includes(s.scope))
        bad(['scopes', n, 'scope'], `${i.kind} cannot carry ${s.scope}`);
      if (seen.has(s.scope)) bad(['scopes', n, 'scope'], `scope ${s.scope} is listed twice`);
      seen.add(s.scope);
      // D3 data never has a model route, and a provider scope never claims it.
      if (i.kind === 'model_provider' && s.data_class_max === 'D3') {
        bad(['scopes', n, 'data_class_max'], 'a model provider never carries D3');
      }
    }
    const ids = new Set<string>();
    for (const [n, c] of i.credentials.entries()) {
      if (ids.has(c.credential_id))
        bad(['credentials', n], `credential ${c.credential_id} is listed twice`);
      ids.add(c.credential_id);
    }
    const keyless = i.adapter === 'fake' || i.adapter === 'fake_github';
    if (i.status === 'enabled') {
      if (!keyless && i.credentials.length === 0)
        bad(['credentials'], 'an enabled integration needs a credential reference');
      if (i.scopes.length === 0) bad(['scopes'], 'an enabled integration needs at least one scope');
    }
  });
export type Integration = z.infer<typeof Integration>;

export const IntegrationRegistry = z
  .array(Integration)
  .max(64)
  .refine(
    (r) => new Set(r.map((x) => x.integration_id)).size === r.length,
    'duplicate integration_id',
  );
export type IntegrationRegistry = z.infer<typeof IntegrationRegistry>;

/** IntegrationInstall: one integration enabled for one project, with overrides that can only narrow. */
export const IntegrationInstall = z.strictObject({
  install_id: Slug,
  integration_id: Slug,
  project_id: ProjectId,
  enabled: z.boolean(),
  overrides: z.strictObject({
    /** `owner/name`: the repos of the project this integration may touch. Absent: the project's registered repos. */
    repos_allowed: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
      .max(256)
      .optional(),
    /** `gateway.models` ids this project may use through the integration. Absent: all of the provider's. */
    models_allowed: z.array(Slug).max(64).optional(),
  }),
});
export type IntegrationInstall = z.infer<typeof IntegrationInstall>;

export const IntegrationInstalls = z
  .array(IntegrationInstall)
  .max(512)
  .refine((r) => new Set(r.map((x) => x.install_id)).size === r.length, 'duplicate install_id')
  .refine(
    (r) => new Set(r.map((x) => `${x.integration_id}/${x.project_id}`)).size === r.length,
    'an integration is installed once per project',
  );
export type IntegrationInstalls = z.infer<typeof IntegrationInstalls>;

// ---------------------------------------------------------------- health (the shared shape)

export const IntegrationHealthState = z.enum(['ok', 'degraded', 'down', 'unknown']);
export type IntegrationHealthState = z.infer<typeof IntegrationHealthState>;

/** The processes that hold adapters and so can say how they are doing. */
export const IntegrationReporter = z.enum(['codehost', 'gateway']);
export type IntegrationReporter = z.infer<typeof IntegrationReporter>;

/** The `HealthSnapshot` rule: a report older than this reads `unknown`. */
export const INTEGRATION_HEALTH_STALE_MS = 120_000;

export const IntegrationHealth = z.strictObject({
  integration_id: Slug,
  reporter: IntegrationReporter,
  state: IntegrationHealthState,
  /** Why, as a code (`ok`, `auth_failed`, `rate_limited`, `unreachable`, ...). Never text from a vendor. */
  detail_code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .nullable(),
  as_of: IsoDateTime,
});
export type IntegrationHealth = z.infer<typeof IntegrationHealth>;

/** What a reporter sends (`as_of` is the receiver's clock, not the sender's). */
export const IntegrationHealthReport = z.strictObject({
  reporter: IntegrationReporter,
  reports: z
    .array(
      z.strictObject({
        integration_id: Slug,
        state: IntegrationHealthState,
        detail_code: IntegrationHealth.shape.detail_code.optional(),
      }),
    )
    .max(64),
});
export type IntegrationHealthReport = z.infer<typeof IntegrationHealthReport>;

/**
 * The state a reader may show: the reported one while it is fresh, `unknown` once it is older than two
 * minutes (never green on a stale report), and `unknown` for an `as_of` in the future or unreadable.
 */
export function effectiveHealthState(
  h: { readonly state: IntegrationHealthState; readonly as_of: string },
  nowMs: number,
): IntegrationHealthState {
  const t = Date.parse(h.as_of);
  if (!Number.isFinite(t)) return 'unknown';
  const age = nowMs - t;
  if (age < 0 || age > INTEGRATION_HEALTH_STALE_MS) return 'unknown';
  return h.state;
}

const RANK: Record<IntegrationHealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** One state for an integration from its reporters' reports: the worst fresh one; `unknown` when there is none. */
export function aggregateHealth(
  reports: ReadonlyArray<{ readonly state: IntegrationHealthState; readonly as_of: string }>,
  nowMs: number,
): IntegrationHealthState {
  if (reports.length === 0) return 'unknown';
  return reports
    .map((r) => effectiveHealthState(r, nowMs))
    .reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok' as IntegrationHealthState);
}

/** One tile of the portal's integrations panel (the tile itself comes later). */
export const IntegrationHealthTile = z.strictObject({
  integration_id: Slug,
  kind: IntegrationKind,
  adapter: IntegrationAdapter,
  display_name: z.string(),
  status: IntegrationStatus,
  state: IntegrationHealthState,
  /** The detail of the worst fresh report, or `stale` / `no_report`. */
  detail_code: z.string().nullable(),
  as_of: IsoDateTime.nullable(),
  /** True when the newest report exists and is older than two minutes (the state is then `unknown`). */
  stale: z.boolean(),
  reporters: z.array(
    z.strictObject({
      reporter: IntegrationReporter,
      state: IntegrationHealthState,
      reported_state: IntegrationHealthState,
      detail_code: z.string().nullable(),
      as_of: IsoDateTime,
    }),
  ),
  /** Projects this integration is enabled for. */
  installs: z.number().int().min(0),
});
export type IntegrationHealthTile = z.infer<typeof IntegrationHealthTile>;

export const IntegrationHealthTiles = z.strictObject({
  as_of: IsoDateTime,
  /** The config revision (factory) the registry came from; null before the first publish. */
  registry_revision: z.string().nullable(),
  tiles: z.array(IntegrationHealthTile),
});
export type IntegrationHealthTiles = z.infer<typeof IntegrationHealthTiles>;

// ---------------------------------------------------------------- events (ledgered through config publish)

export const IntegrationEventKind = z.enum([
  'created',
  'enabled',
  'disabled',
  'retired',
  'scope_widened',
  'scope_narrowed',
  'credential_changed',
  'config_changed',
  'install_added',
  'install_enabled',
  'install_disabled',
  'install_removed',
  'route_added',
  'route_removed',
]);
export type IntegrationEventKind = z.infer<typeof IntegrationEventKind>;

/**
 * IntegrationEvent: what a published config revision changed about an integration or an install. It is
 * derived from the lineage (never stored on its own) and each one names the ledger entry of the M1
 * decision that made the revision effective, so the ledger is the audit trail.
 */
export const IntegrationEvent = z.strictObject({
  integration_id: Slug,
  install_id: Slug.nullable(),
  event: IntegrationEventKind,
  /** A one-line, code-like detail (`scope:apply_patch`, `route:local/D2`). */
  detail: z.string().max(200).nullable(),
  rev_hash: z.string().regex(/^[0-9a-f]{64}$/),
  ledger_entry_id: z.string().min(1),
  at: IsoDateTime,
});
export type IntegrationEvent = z.infer<typeof IntegrationEvent>;

/**
 * What a revision of the registry does that M1 must see named. Every revision of any config opens an M1
 * gate; these are the registry changes the gate's evidence lists in words: enabling, widening a scope,
 * adding a model route to D2 or lower, and adding an install.
 */
export const GATED_INTEGRATION_CHANGES = [
  'enabled',
  'scope_widened',
  'route_added',
  'install_added',
  'install_enabled',
] as const satisfies readonly IntegrationEventKind[];

/** The API's answer for a registry read (core to the codehost and the gateway). */
export const IntegrationRegistryView = z.strictObject({
  revision: z.string().nullable(),
  integrations: z.array(Integration),
  installs: z.array(IntegrationInstall),
});
export type IntegrationRegistryView = z.infer<typeof IntegrationRegistryView>;
