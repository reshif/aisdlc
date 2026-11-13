import {
  GATEWAY_CONFIG_KEYS,
  GatewayModels,
  INTEGRATION_CONFIG_KEYS,
  INTEGRATION_FORBIDDEN,
  IntegrationRegistry,
  NOTIFICATIONS_CONFIG_KEY,
  NotificationChannels,
  label,
  lookupTerm,
  pdpResource,
  secretVaultRef,
  type Integration,
  type IntegrationHealthTile,
  type NotificationChannelRow,
  type ProviderTestResult,
  type SecretName,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Guarded } from '../access';
import { api, type ConfigKeyWire, type Me } from '../api';
import { ErrorNote } from '../components/Notice';
import { Read } from '../components/Read';
import { describeError, shortTime } from '../format';
import { TabHead } from '../operate/TabHead';
import { GithubAppsCard, RepositoriesCard } from '../pages/GithubAppsPanel';
import { Link } from '../router';
import { ChangeActions } from '../settings/ChangeActions';
import { settingHref } from '../settings/SettingsPage';
import {
  Card,
  ConfirmDelete,
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  Pill,
  Table,
  WireTerm,
  useToast,
  type PillTone,
} from '../ui';
import { SecretRow, SecretRows, secretOfRef, useSecrets } from './secrets';
import '../settings/settings.css';

// Integrations (screen map §2.12): connect GitHub, model providers, Slack and email; enter their secrets (write-only,
// into the vault); test; see health. Each integration is a row of the registry (`integrations.registry`) and each
// channel a row of `notifications.channels`: adding, editing, turning off and deleting one is a settings change like
// every other (preview, then propose, or apply now as the factory admin). Reading is `quality.read`; the registry and
// the secrets need the right to read settings and to propose a change.

export const INTEGRATION_TABS = [
  'overview',
  'github',
  'models',
  'notifications',
  'secrets',
] as const;
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];
const TAB_WORD: Readonly<Record<IntegrationTab, string>> = {
  overview: 'Overview',
  github: 'GitHub',
  models: 'Models and providers',
  notifications: label('integrationKind', 'notifier'),
  secrets: 'Secrets',
};

const HEALTH_TONE: Readonly<Record<IntegrationHealthTile['state'], PillTone>> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'bad',
  unknown: 'mute',
};

const REGISTRY = INTEGRATION_CONFIG_KEYS.registry;

function useRegistry() {
  return useQuery({
    queryKey: ['config', REGISTRY],
    queryFn: () => api.configKey(REGISTRY),
    retry: false,
  });
}
const rowsOf = (v: ConfigKeyWire | undefined): Integration[] => {
  const p = IntegrationRegistry.safeParse(v?.effective.value ?? []);
  return p.success ? p.data : [];
};

export function IntegrationsPage({ tab, me }: { tab: string | null; me: Me }) {
  const t = (INTEGRATION_TABS as readonly string[]).includes(tab ?? 'overview')
    ? ((tab ?? 'overview') as IntegrationTab)
    : null;
  const title = label('screen', 'integrations');
  if (t === null) return <IntegrationDetail id={tab as string} csrf={me.csrf_token} />;
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: title, to: '/integrations' }, { label: TAB_WORD[t] }]}
        renderLink={(to, text) => <Link to={to}>{text}</Link>}
        meta="The outside services the factory uses: each with its health, its secret (saved once, never shown again) and a test."
      />
      <nav className="st-tabs" aria-label={`${title} tabs`}>
        <ul>
          {INTEGRATION_TABS.map((x) => (
            <li key={x}>
              <Link
                to={x === 'overview' ? '/integrations' : `/integrations/${x}`}
                {...(x === t ? { 'aria-current': 'page' as const } : {})}
              >
                {TAB_WORD[x]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {t === 'overview' ? <Overview /> : null}
      {t === 'github' ? <GithubTab csrf={me.csrf_token} /> : null}
      {t === 'models' ? <ModelsTab csrf={me.csrf_token} /> : null}
      {t === 'notifications' ? <NotificationsTab csrf={me.csrf_token} /> : null}
      {t === 'secrets' ? <SecretsTab csrf={me.csrf_token} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- overview

export function HealthTiles({ tiles }: { tiles: readonly IntegrationHealthTile[] }) {
  if (tiles.length === 0) {
    return (
      <EmptyState title="No integration yet">
        Add a model provider so agents can work:{' '}
        <Link to="/integrations/models">Models and providers</Link>.
      </EmptyState>
    );
  }
  return (
    <ul className="st-tiles" aria-label="Integrations and their health">
      {tiles.map((t) => (
        <li key={t.integration_id} className="st-tile" data-state={t.state}>
          <div className="st-tile-hd">
            <h3>
              <Link to={`/integrations/${encodeURIComponent(t.integration_id)}`}>
                {t.display_name}
              </Link>
            </h3>
            <Pill tone={HEALTH_TONE[t.state]}>
              <WireTerm family="health" value={t.state} />
            </Pill>
          </div>
          <p>
            <WireTerm family="integrationKind" value={t.kind} /> ·{' '}
            <WireTerm family="integrationAdapter" value={t.adapter} /> ·{' '}
            <WireTerm family="integrationStatus" value={t.status} />
          </p>
          <p>
            {t.stale
              ? 'Last check is too old: health unknown.'
              : t.as_of
                ? `Last check ${shortTime(t.as_of)}`
                : 'No check yet.'}
          </p>
          <p>Used by {t.installs} project(s)</p>
        </li>
      ))}
    </ul>
  );
}

function Overview() {
  const q = useQuery({
    queryKey: ['integrations'],
    queryFn: api.integrations,
    refetchInterval: 30_000,
  });
  return (
    <Read q={q} what="the integrations">
      {(v) => (
        <>
          <TabHead
            title="Health"
            sub="A check older than two minutes reads unknown, never healthy."
            actions={
              <>
                <Link to="/integrations/models#add" className="ui-btn ui-btn-primary">
                  Add a model provider
                </Link>
                <Link to="/integrations/notifications#add" className="ui-btn">
                  Add a notification channel
                </Link>
              </>
            }
          />
          <HealthTiles tiles={v.health.tiles} />
          <Card title="Recent changes" flush>
            <Table
              caption="Changes to integrations"
              captionHidden
              columns={[
                {
                  key: 'i',
                  header: 'Integration',
                  rowHeader: true,
                  render: (e) =>
                    v.health.tiles.find((t) => t.integration_id === e.integration_id)
                      ?.display_name ?? e.integration_id,
                },
                { key: 'k', header: 'Change', render: (e) => eventWord(e.event) },
                { key: 'at', header: 'When', render: (e) => shortTime(e.at) },
              ]}
              rows={v.events}
              rowKey={(e) => `${e.integration_id}:${e.event}:${e.rev_hash}:${e.install_id ?? ''}`}
              empty={<p className="muted">No change yet.</p>}
            />
          </Card>
        </>
      )}
    </Read>
  );
}

const EVENT_WORD: Readonly<Record<string, string>> = {
  created: 'Added',
  enabled: 'Turned on',
  disabled: 'Turned off',
  retired: 'Retired',
  updated: 'Changed',
  installed: 'Given to a project',
  uninstalled: 'Taken from a project',
};
const eventWord = (e: string) => EVENT_WORD[e] ?? 'Changed';

// ---------------------------------------------------------------- GitHub

const GITHUB_SECRETS: readonly SecretName[] = [
  'github-app-key',
  'push-broker-app-key',
  'gate-check-app-key',
  'tracker-app-key',
  'gate-relay-app-key',
];

function GithubTab({ csrf }: { csrf: string }) {
  return (
    <>
      <TabHead
        title="GitHub"
        sub="The factory's GitHub Apps, what each may do, the repos they see and whether the factory check is required."
      />
      <GithubAppsCard />
      <RepositoriesCard />
      <Card title="App private keys">
        <p className="muted">
          Paste the private key GitHub gave you when the App was made. It goes straight to the vault
          and is never shown again.
        </p>
        <SecretRows names={GITHUB_SECRETS} csrf={csrf} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- models and providers

/** The secret a provider's adapter reads by default. */
const PROVIDER_SECRET: Readonly<Record<string, SecretName>> = {
  anthropic: 'anthropic-api-key',
  openai_compat: 'openai-api-key',
};

function providerRow(f: ProviderDraft): Integration {
  const secret: SecretName | null =
    f.adapter === 'fake' ? null : f.adapter === 'anthropic' ? 'anthropic-api-key' : f.secret_name;
  return {
    integration_id: f.id,
    kind: 'model_provider',
    adapter: f.adapter,
    display_name: f.name,
    config:
      f.adapter === 'openai_compat'
        ? { base_url: f.base_url }
        : f.adapter === 'anthropic' && f.base_url !== ''
          ? { base_url: f.base_url }
          : {},
    status: 'enabled',
    version: 1,
    credentials: secret
      ? [{ credential_id: 'api-key', secret_ref: secretVaultRef(secret), kind: 'api_key' }]
      : [],
    scopes: [
      {
        scope: 'chat_complete',
        data_class_max: f.data_class,
        forbidden: [...INTEGRATION_FORBIDDEN],
      },
    ],
    provider: { tools_capable: true, streams: true, aws_only: false },
  };
}

interface ProviderDraft {
  readonly adapter: 'anthropic' | 'openai_compat' | 'fake';
  readonly id: string;
  readonly name: string;
  readonly base_url: string;
  readonly secret_name: SecretName;
  readonly data_class: 'D0' | 'D1' | 'D2';
}

function AddProvider({ reg, csrf }: { reg: ConfigKeyWire; csrf: string }) {
  const ids = {
    adapter: useId(),
    id: useId(),
    name: useId(),
    url: useId(),
    secret: useId(),
    dc: useId(),
  };
  const [f, setF] = useState<ProviderDraft>({
    adapter: 'anthropic',
    id: 'anthropic',
    name: 'Anthropic',
    base_url: '',
    secret_name: 'anthropic-api-key',
    data_class: 'D1',
  });
  const rows = rowsOf(reg);
  const taken = rows.some((r) => r.integration_id === f.id);
  const row = providerRow(f);
  const draft = [...rows, row];
  const check = IntegrationRegistry.safeParse(draft);
  const set = (p: Partial<ProviderDraft>) => setF((x) => ({ ...x, ...p }));
  const secret = row.credentials[0] ? secretOfRef(row.credentials[0].secret_ref) : null;
  return (
    <Card title="Add a model provider" testId="add-provider">
      <form
        className="st-form"
        id="add"
        aria-label="Add a model provider"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label className="ui-label" htmlFor={ids.adapter}>
            Kind of provider
          </label>
          <select
            id={ids.adapter}
            className="ui-input"
            value={f.adapter}
            onChange={(e) => {
              const a = e.target.value as ProviderDraft['adapter'];
              set({
                adapter: a,
                secret_name: PROVIDER_SECRET[a] ?? 'openai-api-key',
                ...(a === 'fake' ? { id: 'test-model', name: 'Test model' } : {}),
              });
            }}
          >
            {(['anthropic', 'openai_compat', 'fake'] as const).map((a) => (
              <option key={a} value={a}>
                {label('integrationAdapter', a)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="ui-label" htmlFor={ids.name}>
            Name people see
          </label>
          <input
            id={ids.name}
            className="ui-input"
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label className="ui-label" htmlFor={ids.id}>
            Short id (lower case, used in settings)
          </label>
          <input
            id={ids.id}
            className="ui-input"
            value={f.id}
            aria-invalid={taken}
            onChange={(e) => set({ id: e.target.value })}
          />
          {taken ? (
            <p className="ui-help ui-help-bad">An integration has this id already.</p>
          ) : null}
        </div>
        {f.adapter !== 'fake' ? (
          <div>
            <label className="ui-label" htmlFor={ids.url}>
              Address of its API {f.adapter === 'anthropic' ? '(optional)' : ''}
            </label>
            <input
              id={ids.url}
              className="ui-input"
              type="url"
              placeholder="https://api.example.com"
              value={f.base_url}
              onChange={(e) => set({ base_url: e.target.value })}
            />
          </div>
        ) : null}
        {f.adapter === 'openai_compat' ? (
          <div>
            <label className="ui-label" htmlFor={ids.secret}>
              Which key it uses
            </label>
            <select
              id={ids.secret}
              className="ui-input"
              value={f.secret_name}
              onChange={(e) => set({ secret_name: e.target.value as SecretName })}
            >
              <option value="openai-api-key">OpenAI-compatible API key</option>
              <option value="deepseek-api-key">DeepSeek API key</option>
            </select>
          </div>
        ) : null}
        <div>
          <label className="ui-label" htmlFor={ids.dc}>
            Most sensitive data it may see
          </label>
          <select
            id={ids.dc}
            className="ui-input"
            value={f.data_class}
            onChange={(e) => set({ data_class: e.target.value as ProviderDraft['data_class'] })}
          >
            {(['D0', 'D1', 'D2'] as const).map((d) => (
              <option key={d} value={d}>
                {label('dataClass', d)}
              </option>
            ))}
          </select>
        </div>
      </form>
      {secret ? (
        <>
          <h3>Its API key</h3>
          <p className="muted">
            Save the key first or after: the provider works once both the key and the change are in.
          </p>
          <SecretRows names={[secret]} csrf={csrf} />
        </>
      ) : null}
      {!check.success && !taken ? (
        <div className="notice notice-bad" role="alert" aria-label="Problems with the draft">
          <ul>
            {check.error.issues.map((i) => (
              <li key={i.path.join('.') + i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {reg.may_propose ? (
        <ChangeActions
          configKey={REGISTRY}
          draft={draft}
          parent={reg.head_rev_hash}
          csrf={csrf}
          mayApplyNow={reg.may_apply_now === true}
          blocked={
            taken ? 'Choose another id.' : check.success ? null : 'Fix the problems above first.'
          }
        />
      ) : null}
    </Card>
  );
}

function ModelsTab({ csrf }: { csrf: string }) {
  const reg = useRegistry();
  const models = useQuery({
    queryKey: ['config', GATEWAY_CONFIG_KEYS.models],
    queryFn: () => api.configKey(GATEWAY_CONFIG_KEYS.models),
    retry: false,
  });
  const providers = rowsOf(reg.data).filter((r) => r.kind === 'model_provider');
  const m = GatewayModels.safeParse(models.data?.effective.value ?? []);
  return (
    <>
      <TabHead
        title="Models and providers"
        sub="Who runs the models, the models agents may use and their prices. Each agent's model is chosen on its own page."
        actions={
          <Link to="/agents" className="ui-btn">
            Model per agent
          </Link>
        }
      />
      <Card title="Providers" flush testId="providers">
        {reg.isError ? (
          <p className="muted">You cannot read the list of integrations.</p>
        ) : (
          <Table
            caption="Model providers"
            captionHidden
            rows={providers}
            rowKey={(r) => r.integration_id}
            empty={
              <EmptyState title="No model provider yet">Add one so agents can work.</EmptyState>
            }
            columns={[
              {
                key: 'n',
                header: 'Provider',
                rowHeader: true,
                render: (r) => (
                  <Link to={`/integrations/${encodeURIComponent(r.integration_id)}`}>
                    {r.display_name}
                  </Link>
                ),
              },
              {
                key: 'a',
                header: 'Kind',
                render: (r) => <WireTerm family="integrationAdapter" value={r.adapter} />,
              },
              {
                key: 's',
                header: 'State',
                render: (r) => <WireTerm family="integrationStatus" value={r.status} />,
              },
              { key: 'k', header: 'Key', render: (r) => <KeyState r={r} /> },
            ]}
          />
        )}
      </Card>
      {reg.data ? <AddProvider reg={reg.data} csrf={csrf} /> : null}
      <GatewayProviders csrf={csrf} />
      <Card
        title="Models"
        flush
        actions={<Link to={settingHref(GATEWAY_CONFIG_KEYS.models)}>Change the models</Link>}
      >
        <Table
          caption="Models agents may use"
          captionHidden
          rows={m.success ? m.data : []}
          rowKey={(x) => x.model_id}
          empty={<p className="muted">No model is set up.</p>}
          columns={[
            { key: 'id', header: 'Model', rowHeader: true, render: (x) => x.model_id },
            { key: 'p', header: 'Provider', render: (x) => x.provider_id },
            { key: 'pm', header: 'Provider calls it', render: (x) => x.provider_model },
            {
              key: 'usd',
              header: 'Dollars per million tokens in / out',
              align: 'right',
              render: (x) => `${x.usd_in_per_mtok} / ${x.usd_out_per_mtok}`,
            },
          ]}
        />
      </Card>
      <p>
        <Link to={settingHref(GATEWAY_CONFIG_KEYS.routes)}>Model per data class</Link>
      </p>
    </>
  );
}

function KeyState({ r }: { r: Integration }) {
  const s = useSecrets();
  const name = r.credentials.map((c) => secretOfRef(c.secret_ref)).find((x) => x !== null);
  if (r.credentials.length === 0) return <span className="muted">No key needed</span>;
  if (!name) return <span className="muted">Kept outside the portal</span>;
  if (!s.data || !s.data.store_reachable) return <span className="muted">Unknown</span>;
  const v = s.data.secrets.find((x) => x.name === name);
  return v?.set ? (
    <Pill tone="ok">Saved {v.updated_at ? shortTime(v.updated_at) : ''}</Pill>
  ) : (
    <Pill tone="bad">Not set</Pill>
  );
}

/** The gateway's providers as it built them: Test (one tiny metered call) and Reload. */
function GatewayProviders({ csrf }: { csrf: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['model-providers'], queryFn: api.modelProviders, retry: false });
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});
  const test = useMutation({
    mutationFn: (id: string) => api.testProvider(id, csrf),
    onSuccess: (r) => setResults((x) => ({ ...x, [r.integration_id]: r })),
  });
  const reload = useMutation({
    mutationFn: () => api.reloadProviders(true, csrf),
    onSuccess: () => {
      toast('The model gateway reloaded its providers and keys.', 'ok');
      void qc.invalidateQueries({ queryKey: ['model-providers'] });
    },
  });
  const fleet = pdpResource.fleet();
  return (
    <Card
      title="Connection test"
      actions={
        <Guarded action="config.propose" resource={fleet} label="Reload the gateway" mode="hide">
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={reload.isPending}
            onClick={() => reload.mutate()}
          >
            Reload after a key change
          </button>
        </Guarded>
      }
    >
      {reload.isError ? <ErrorNote error={reload.error} /> : null}
      {q.isError ? (
        <p className="muted">The model gateway did not answer ({describeError(q.error)}).</p>
      ) : null}
      {q.data ? (
        <Table
          caption="Providers the gateway runs"
          captionHidden
          rows={q.data.integrations}
          rowKey={(p) => p.integration_id}
          empty={<p className="muted">The gateway runs no provider.</p>}
          columns={[
            { key: 'i', header: 'Provider', rowHeader: true, render: (p) => p.integration_id },
            {
              key: 's',
              header: 'Ready',
              render: (p) =>
                p.state === 'built' ? (
                  <Pill tone="ok">Ready</Pill>
                ) : (
                  <Pill tone="bad">Not ready</Pill>
                ),
            },
            {
              key: 't',
              header: 'Last test',
              render: (p) => {
                const r = results[p.integration_id];
                if (!r) return <span className="muted">Not tested here</span>;
                return r.outcome === 'ok' ? (
                  <Pill tone="ok">Worked in {r.latency_ms} ms</Pill>
                ) : (
                  <Pill tone="bad">Failed{r.code ? `: ${r.code}` : ''}</Pill>
                );
              },
            },
            {
              key: 'b',
              header: 'Test',
              render: (p) => (
                <Guarded
                  action="config.propose"
                  resource={fleet}
                  label={`Test ${p.integration_id}`}
                >
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    disabled={test.isPending}
                    onClick={() => test.mutate(p.integration_id)}
                  >
                    Test {p.integration_id}
                  </button>
                </Guarded>
              ),
            },
          ]}
        />
      ) : null}
      {test.isError ? <ErrorNote error={test.error} /> : null}
      <p className="muted">
        A test is one call of one token with the saved key; it is recorded with who asked. A failed
        test changes nothing.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationsTab({ csrf }: { csrf: string }) {
  const q = useQuery({
    queryKey: ['config', NOTIFICATIONS_CONFIG_KEY],
    queryFn: () => api.configKey(NOTIFICATIONS_CONFIG_KEY),
    retry: false,
  });
  const p = NotificationChannels.safeParse(q.data?.effective.value ?? []);
  const rows: NotificationChannelRow[] = p.success ? p.data : [];
  return (
    <>
      <TabHead
        title={label('integrationKind', 'notifier')}
        sub="Slack and email channels, the most sensitive data each may carry, and whether people get them unless they choose otherwise."
      />
      <Card title="Channels" flush>
        <Table
          caption="Notification channels"
          captionHidden
          rows={rows}
          rowKey={(r) => r.channel_id}
          empty={
            <EmptyState title="No channel yet">Add a Slack or email channel below.</EmptyState>
          }
          columns={[
            { key: 'n', header: 'Channel', rowHeader: true, render: (r) => r.display_name },
            {
              key: 'k',
              header: 'Kind',
              render: (r) => (r.kind === 'slack_webhook' ? 'Slack' : 'Email'),
            },
            {
              key: 'on',
              header: 'On or off',
              render: (r) => (r.enabled ? <Pill tone="ok">On</Pill> : <Pill tone="mute">Off</Pill>),
            },
            {
              key: 'd',
              header: 'Most sensitive data',
              render: (r) => <WireTerm family="dataClass" value={r.data_class_max} />,
            },
          ]}
        />
      </Card>
      {q.data ? <AddChannel cfg={q.data} rows={rows} csrf={csrf} /> : null}
      <Card title="Channel secrets">
        <SecretRows names={['slack-webhook-url', 'smtp-password']} csrf={csrf} />
      </Card>
      <p>
        <Link to={settingHref(NOTIFICATIONS_CONFIG_KEY)}>Every field of the channels</Link>
      </p>
    </>
  );
}

function AddChannel({
  cfg,
  rows,
  csrf,
}: {
  cfg: ConfigKeyWire;
  rows: readonly NotificationChannelRow[];
  csrf: string;
}) {
  const ids = { kind: useId(), name: useId(), id: useId(), host: useId(), from: useId() };
  const [kind, setKind] = useState<'slack_webhook' | 'email_smtp'>('slack_webhook');
  const [name, setName] = useState('Team channel');
  const [id, setId] = useState('team');
  const [host, setHost] = useState('smtp.example.com');
  const [from, setFrom] = useState('factory@example.com');
  const base = {
    channel_id: id,
    display_name: name,
    enabled: true,
    data_class_max: 'D0' as const,
    default_on: true,
  };
  const row: NotificationChannelRow =
    kind === 'slack_webhook'
      ? { ...base, kind, webhook_ref: secretVaultRef('slack-webhook-url') }
      : {
          ...base,
          kind,
          host,
          port: 587,
          tls: 'starttls',
          from,
          username_ref: null,
          password_ref: null,
        };
  const draft = [...rows, row];
  const check = NotificationChannels.safeParse(draft);
  return (
    <Card title="Add a channel" testId="add-channel">
      <form
        className="st-form"
        id="add"
        aria-label="Add a channel"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label className="ui-label" htmlFor={ids.kind}>
            Kind
          </label>
          <select
            id={ids.kind}
            className="ui-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="slack_webhook">Slack</option>
            <option value="email_smtp">Email</option>
          </select>
        </div>
        <div>
          <label className="ui-label" htmlFor={ids.name}>
            Name people see
          </label>
          <input
            id={ids.name}
            className="ui-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="ui-label" htmlFor={ids.id}>
            Short id
          </label>
          <input
            id={ids.id}
            className="ui-input"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </div>
        {kind === 'email_smtp' ? (
          <>
            <div>
              <label className="ui-label" htmlFor={ids.host}>
                Mail server
              </label>
              <input
                id={ids.host}
                className="ui-input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div>
              <label className="ui-label" htmlFor={ids.from}>
                Sent from
              </label>
              <input
                id={ids.from}
                className="ui-input"
                type="email"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
          </>
        ) : (
          <p className="muted">The webhook address is a secret: save it under Channel secrets.</p>
        )}
      </form>
      {!check.success ? (
        <div className="notice notice-bad" role="alert" aria-label="Problems with the draft">
          <ul>
            {check.error.issues.map((i) => (
              <li key={i.path.join('.') + i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {cfg.may_propose ? (
        <ChangeActions
          configKey={NOTIFICATIONS_CONFIG_KEY}
          draft={draft}
          parent={cfg.head_rev_hash}
          csrf={csrf}
          mayApplyNow={cfg.may_apply_now === true}
          blocked={check.success ? null : 'Fix the problems above first.'}
        />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- secrets

function SecretsTab({ csrf }: { csrf: string }) {
  const q = useSecrets();
  return (
    <>
      <TabHead
        title="Secrets"
        sub="Every secret the factory keeps, where it is used and when it was saved. A secret is never shown again: you can only replace or delete it."
      />
      {q.isPending ? <p className="muted">Reading the secrets…</p> : null}
      {q.isError ? (
        <ErrorState
          status={403}
          reason={describeError(q.error)}
          action={<Link to="/me/access">See my access</Link>}
        />
      ) : null}
      {q.data ? (
        <>
          {!q.data.store_reachable ? (
            <p role="alert" className="notice notice-bad">
              The vault did not answer: whether each secret is set is unknown.
            </p>
          ) : null}
          <ul className="st-list" aria-label="Secrets">
            {q.data.secrets.map((s) => (
              <li key={s.name} className="st-row">
                <SecretRow
                  name={s.name}
                  view={s}
                  csrf={csrf}
                  storeReachable={q.data.store_reachable}
                />
                <p className="muted">
                  Read by the {s.owner} service
                  {s.updated_by ? ` · saved by ${s.updated_by}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- one integration

function IntegrationDetail({ id, csrf }: { id: string; csrf: string }) {
  const reg = useRegistry();
  const [name, setName] = useState<string | null>(null);
  const [status, setStatus] = useState<Integration['status'] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const ids = { name: useId(), status: useId() };
  const title = label('screen', 'integrations');
  if (reg.isPending) return <p className="muted">Reading the integration…</p>;
  if (reg.isError) {
    return (
      <ErrorState
        status={403}
        reason={describeError(reg.error)}
        action={<Link to="/integrations">Back to integrations</Link>}
      />
    );
  }
  const rows = rowsOf(reg.data);
  const row = rows.find((r) => r.integration_id === id);
  if (!row)
    return (
      <ErrorState status={404} action={<Link to="/integrations">Back to integrations</Link>} />
    );
  const edited: Integration = {
    ...row,
    display_name: name ?? row.display_name,
    status: status ?? row.status,
    version: row.version + 1,
  };
  const changed = edited.display_name !== row.display_name || edited.status !== row.status;
  const editDraft = rows.map((r) => (r.integration_id === id ? edited : r));
  const removeDraft = rows.filter((r) => r.integration_id !== id);
  const secrets = row.credentials
    .map((c) => secretOfRef(c.secret_ref))
    .filter((x): x is SecretName => x !== null);
  const kindWord = lookupTerm('integrationKind', row.kind)?.label ?? 'Integration';
  return (
    <>
      <PageHeader
        title={row.display_name}
        crumbs={[{ label: title, to: '/integrations' }, { label: row.display_name }]}
        renderLink={(to, text) => <Link to={to}>{text}</Link>}
        status={
          <Pill tone={row.status === 'enabled' ? 'ok' : 'mute'}>
            <WireTerm family="integrationStatus" value={row.status} />
          </Pill>
        }
        meta={`${kindWord} · ${label('integrationAdapter', row.adapter)}`}
        actions={
          reg.data.may_propose ? (
            <button
              type="button"
              className="ui-btn ui-btn-danger"
              onClick={() => setDeleting(true)}
            >
              Delete integration
            </button>
          ) : null
        }
      />
      <Card title="About it">
        <KeyValue
          rows={[
            ['Kind', kindWord],
            ['Connects through', label('integrationAdapter', row.adapter)],
            [
              'Settings',
              Object.keys(row.config).length === 0 ? 'none' : JSON.stringify(row.config),
            ],
            ['May do', row.scopes.map((s) => s.scope.replace(/_/g, ' ')).join(', ') || 'nothing'],
            ['Change number', String(row.version)],
          ]}
        />
      </Card>
      {secrets.length > 0 ? (
        <Card title="Its secret">
          <SecretRows names={secrets} csrf={csrf} />
        </Card>
      ) : null}
      {reg.data.may_propose ? (
        <Card title="Change it" testId="edit-integration">
          <form
            className="st-form"
            aria-label="Change the integration"
            onSubmit={(e) => e.preventDefault()}
          >
            <div>
              <label className="ui-label" htmlFor={ids.name}>
                Name people see
              </label>
              <input
                id={ids.name}
                className="ui-input"
                value={edited.display_name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="ui-label" htmlFor={ids.status}>
                On or off
              </label>
              <select
                id={ids.status}
                className="ui-input"
                value={edited.status}
                onChange={(e) => setStatus(e.target.value as Integration['status'])}
              >
                {(['enabled', 'disabled', 'draft', 'retired'] as const).map((s) => (
                  <option key={s} value={s}>
                    {label('integrationStatus', s)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          <ChangeActions
            configKey={REGISTRY}
            draft={editDraft}
            parent={reg.data.head_rev_hash}
            csrf={csrf}
            mayApplyNow={reg.data.may_apply_now === true}
            blocked={changed ? null : 'Change a field to send a change.'}
          />
        </Card>
      ) : null}
      {removing ? (
        <Card title="Delete it" testId="remove-integration">
          <p>
            Deleting it is a settings change too: preview it, then propose it or apply it now. Its
            secret stays in the vault until you delete it above.
          </p>
          <ChangeActions
            configKey={REGISTRY}
            draft={removeDraft}
            parent={reg.data.head_rev_hash}
            csrf={csrf}
            mayApplyNow={reg.data.may_apply_now === true}
            blocked={null}
          />
        </Card>
      ) : null}
      <ConfirmDelete
        open={deleting}
        kind="integration"
        name={row.integration_id}
        consequences={
          <p>
            The factory stops using it. Projects that use it lose it; anything that needs it waits
            or fails closed.
          </p>
        }
        onConfirm={() => {
          setDeleting(false);
          setRemoving(true);
        }}
        onClose={() => setDeleting(false)}
      />
    </>
  );
}
