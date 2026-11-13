import { useQuery } from '@tanstack/react-query';
import {
  GATEWAY_CONFIG_KEYS,
  GatewayModels,
  GatewayRoutes,
  STEPS,
  type AgentRegistryRow,
  type EvalRunHeader,
  type IntegrationHealthTile,
} from '@aisdlc/contracts';
import { ApiError, api } from '../api';
import { ErrorNote, Loading } from '../components/Notice';
import { NotBuilt, Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import {
  ActorGlyph,
  Card,
  EmptyState,
  KeyValue,
  PageHead,
  Pill,
  Stat,
  Stats,
  Table,
  type Column,
  type PillTone,
} from '../ui';

// Quality (prototype `agents`, `evals`, `models`, `integrations`). The agent registry is code
// (packages/agents): it changes by a reviewed pull request that passes the eval gate, never here, so
// there is no on/off switch. Models and routes are configuration: they change through the one
// configuration pattern (ConfigConsole), linked from here. Every read is `quality.read` on the fleet.

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The newest eval run per agent (runs come newest first). */
const newestByAgent = (runs: readonly EvalRunHeader[]) => {
  const m = new Map<string, EvalRunHeader>();
  for (const r of runs) if (!m.has(r.agent_id)) m.set(r.agent_id, r);
  return m;
};

export function StepChips({ a }: { a: AgentRegistryRow }) {
  if (a.steps.length === 0 && a.specialist_steps.length === 0) {
    return <span className="muted">no step: never run, never gets a key</span>;
  }
  return (
    <ul className="pg-chips" aria-label={`steps of ${a.agent_id}`}>
      {a.steps.map((s) => (
        <li key={s} className="pg-step">
          <ActorGlyph actor={STEPS[s].actor} /> {s}
        </li>
      ))}
      {a.specialist_steps.map((s) => (
        <li
          key={s}
          className="pg-step pg-step-spec"
          title="specialist: a deterministic step calls the agent in"
        >
          <ActorGlyph actor={STEPS[s].actor} /> {s} <span className="ui-sr">specialist</span>
        </li>
      ))}
    </ul>
  );
}

export function AgentsPage() {
  const reg = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const runs = useQuery({ queryKey: ['eval-runs'], queryFn: api.evalRuns });
  return (
    <>
      <PageHead
        eyebrow="Quality · packages/agents"
        title="Agents"
        sub="The agent registry is code: definitions, the steps each may act at, contracts, tools, data class and prompts pinned by hash. It changes by a reviewed pull request that passes the eval gate, never here. From the portal you see how each agent scores and which model it prefers."
        actions={
          <>
            <Link to="/evals" className="ui-btn">
              Evals
            </Link>
            <Link to="/models" className="ui-btn">
              Models and routes
            </Link>
          </>
        }
      />
      <Read q={reg} what="the agent registry">
        {(v) => {
          const newest = newestByAgent(runs.data?.runs ?? []);
          const bound = v.agents.filter((a) => a.steps.length + a.specialist_steps.length > 0);
          const cols: ReadonlyArray<Column<AgentRegistryRow>> = [
            {
              key: 'agent',
              header: 'Agent',
              rowHeader: true,
              render: (a) => (
                <>
                  <Link to={`/agents/${a.agent_id}`}>
                    <b>{a.agent_id}</b>
                  </Link>{' '}
                  {a.name ?? <span className="muted">unbound</span>}
                  <div className="ui-mono muted">{a.prompt.ref}</div>
                </>
              ),
            },
            { key: 'steps', header: 'Acts at', render: (a) => <StepChips a={a} /> },
            {
              key: 'contract',
              header: 'Contract',
              render: (a) => (
                <>
                  {a.contract_version}
                  <div className="ui-mono muted">{a.output_schema_id}</div>
                </>
              ),
            },
            {
              key: 'sha',
              header: 'Prompt sha256',
              render: (a) => <ShortHash hash={a.prompt.sha256} />,
            },
            {
              key: 'tools',
              header: 'Tools',
              render: (a) =>
                a.tools.length === 0 ? (
                  <span className="muted">none</span>
                ) : (
                  <ul className="pg-chips">
                    {a.tools.map((t) => (
                      <li key={t}>
                        <code>{t}</code>
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              key: 'dc',
              header: 'Data class',
              render: (a) => <Pill plain>{a.data_class_max}</Pill>,
            },
            { key: 'model', header: 'Prefers', render: (a) => a.models.join(', ') },
            {
              key: 'score',
              header: 'Eval score',
              align: 'right',
              render: (a) => {
                const r = newest.get(a.agent_id);
                if (runs.isError) return <span className="muted">unknown</span>;
                if (!r)
                  return <span className="muted">{runs.isPending ? '…' : 'no eval run'}</span>;
                const stale = r.prompt_sha256 !== a.prompt.sha256;
                return (
                  <span
                    title={`${r.suite_id} on ${r.provider}/${r.model}, ${shortTime(r.ended_at)}`}
                  >
                    <b>{pct(r.pass_rate)}</b>
                    {stale ? (
                      <div>
                        <Pill tone="warn">other prompt</Pill>
                      </div>
                    ) : null}
                  </span>
                );
              },
            },
          ];
          return (
            <>
              <Stats label="The registry">
                <Stat
                  label="Agents in the registry"
                  value={v.agents.length}
                  detail={`${bound.length} bound to steps`}
                />
                <Stat
                  label="Contracts"
                  value={new Set(v.agents.map((a) => a.output_schema_id)).size}
                  detail="output schemas (Zod → JSON Schema)"
                />
                <Stat
                  label="Prompts pinned"
                  value={new Set(v.agents.map((a) => a.prompt.ref)).size}
                  detail={`prompts.lock.json · ${v.lock_format}`}
                />
              </Stats>
              <Card title="Registry" flush>
                <Table
                  caption="Agents"
                  captionHidden
                  columns={cols}
                  rows={v.agents}
                  rowKey={(a) => a.agent_id}
                />
              </Card>
            </>
          );
        }}
      </Read>
      <div className="pg-split">
        <Card title="Change an agent">
          <ul className="pg-notes">
            <li>
              <b>Prompt, contract, tools, limits:</b> a pull request to the factory repo.{' '}
              <code>npm run gen -w @aisdlc/agents</code> regenerates the lock; a test fails when a
              prompt moves without it.
            </li>
            <li>
              <b>Before it merges:</b> the eval gate (<code>aisdlc-evals run</code>,{' '}
              <code>compare</code>, <code>gate</code>). A failing gate is a reason not to merge.
            </li>
            <li>
              <b>Which model serves it:</b> a route per environment and data class:{' '}
              <Link to="/models">Models and routes</Link>.
            </li>
          </ul>
        </Card>
        <NotBuilt title="Switching an agent off" milestone="M19">
          An agent is bound to a step by code; kill and control scopes have no agent kind yet (DM §8
          gap 14). Autonomy promotion (M5) from evals and outcomes comes with M15.5.
        </NotBuilt>
      </div>
    </>
  );
}

export function EvalsPage() {
  const runs = useQuery({ queryKey: ['eval-runs'], queryFn: api.evalRuns });
  const summary = useQuery({ queryKey: ['eval-summary'], queryFn: api.evalSummary });
  const runCols: ReadonlyArray<Column<EvalRunHeader>> = [
    { key: 'suite', header: 'Suite', rowHeader: true, render: (r) => <code>{r.suite_id}</code> },
    { key: 'agent', header: 'Agent', render: (r) => r.agent_id },
    { key: 'prompt', header: 'Prompt', render: (r) => <ShortHash hash={r.prompt_sha256} /> },
    { key: 'model', header: 'Provider / model', render: (r) => `${r.provider} / ${r.model}` },
    { key: 'trigger', header: 'Trigger', render: (r) => r.trigger },
    {
      key: 'rate',
      header: 'Pass rate',
      align: 'right',
      render: (r) => `${pct(r.pass_rate)} (${r.passes}/${r.trials}, k=${r.k})`,
    },
    {
      key: 'errored',
      header: 'Errored',
      align: 'right',
      render: (r) => (r.errored > 0 ? <Pill tone="bad">{r.errored}</Pill> : '0'),
    },
    { key: 'ended', header: 'Ended', render: (r) => shortTime(r.ended_at) },
  ];
  return (
    <>
      <PageHead
        eyebrow="Quality"
        title="Evals"
        sub="Every eval run the tooling recorded, newest first, and the newest result per task. The store and the hidden graders stay outside the factory; core keeps only the run history."
      />
      <Read q={runs} what="the eval runs">
        {(v) => (
          <Card title="Run history" flush>
            <Table
              caption="Eval runs"
              captionHidden
              columns={runCols}
              rows={v.runs}
              rowKey={(r) => r.eval_run_id}
              empty={
                <EmptyState title="No eval run yet">
                  Runs appear here once <code>aisdlc-evals run</code> posts one (scope{' '}
                  <code>evals</code>).
                </EmptyState>
              }
            />
          </Card>
        )}
      </Read>
      <Card title="Newest result per task">
        {summary.isPending ? <Loading what="the summary" /> : null}
        {summary.isError ? (
          <ErrorNote error={summary.error} retry={() => void summary.refetch()} />
        ) : null}
        {summary.data ? (
          <Table
            caption="Tasks"
            captionHidden
            columns={[
              {
                key: 't',
                header: 'Task',
                rowHeader: true,
                render: (r) => <code>{r.task_id}</code>,
              },
              { key: 's', header: 'Suite', render: (r) => r.suite },
              { key: 'p', header: 'Provider', render: (r) => r.provider },
              {
                key: 'st',
                header: 'Status',
                render: (r) => (
                  <Pill tone={r.status === 'pass' ? 'ok' : r.status === 'flaky' ? 'warn' : 'bad'}>
                    {r.status}
                  </Pill>
                ),
              },
              {
                key: 'k',
                header: 'pass^k',
                align: 'right',
                render: (r) => `${pct(r.pass_k)} (k=${r.k})`,
              },
            ]}
            rows={summary.data.rows}
            rowKey={(r) => `${r.suite}/${r.provider}/${r.task_id}`}
            empty={<p className="muted">No task results yet.</p>}
          />
        ) : null}
      </Card>
      <NotBuilt title="Gate results" milestone="no milestone yet">
        <code>aisdlc-evals gate</code> decides a candidate in its pull request (significant
        regression, absolute floor, security case, errored trial, no baseline). Core does not record
        gate verdicts yet, so the portal cannot show them; it shows the runs they were computed
        from.
      </NotBuilt>
    </>
  );
}

function ConfigTable({ configKey }: { configKey: string }) {
  const q = useQuery({
    queryKey: ['config-key', configKey],
    queryFn: () => api.configKey(configKey),
  });
  if (q.isPending) return <Loading what={configKey} />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <p className="muted">This deployment does not register {configKey}.</p>;
    }
    return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  }
  const v = q.data.effective;
  const meta = (
    <KeyValue
      rows={[
        [
          'In force',
          v.source === 'default' ? 'the default (no published revision)' : 'a published revision',
        ],
        ['Revision', v.rev_hash ? <ShortHash hash={v.rev_hash} /> : '–'],
        ['Published', v.published_at ? shortTime(v.published_at) : '–'],
        ['Open proposals', String(q.data.pending.length)],
      ]}
    />
  );
  if (configKey === GATEWAY_CONFIG_KEYS.models) {
    const m = GatewayModels.safeParse(v.value);
    return (
      <>
        {meta}
        {m.success ? (
          <Table
            caption="Models"
            captionHidden
            columns={[
              {
                key: 'id',
                header: 'Model',
                rowHeader: true,
                render: (x) => <code>{x.model_id}</code>,
              },
              { key: 'p', header: 'Provider', render: (x) => x.provider_id },
              { key: 'pm', header: 'Vendor name', render: (x) => x.provider_model },
              { key: 'tools', header: 'Tools', render: (x) => (x.tools_capable ? 'yes' : 'no') },
              { key: 'cap', header: 'Max tokens', align: 'right', render: (x) => x.max_tokens_cap },
              {
                key: 'usd',
                header: 'USD per Mtok in / out',
                align: 'right',
                render: (x) => `${x.usd_in_per_mtok} / ${x.usd_out_per_mtok}`,
              },
            ]}
            rows={m.data}
            rowKey={(x) => x.model_id}
            empty={<p className="muted">No model is configured.</p>}
          />
        ) : (
          <p className="muted">The value in force does not read as a model list.</p>
        )}
      </>
    );
  }
  const r = GatewayRoutes.safeParse(v.value);
  return (
    <>
      {meta}
      {r.success ? (
        <Table
          caption="Routes"
          captionHidden
          columns={[
            { key: 'e', header: 'Environment', rowHeader: true, render: (x) => x.environment },
            { key: 'd', header: 'Data class', render: (x) => <Pill plain>{x.data_class}</Pill> },
            { key: 'm', header: 'Model', render: (x) => <code>{x.model_id}</code> },
          ]}
          rows={r.data}
          rowKey={(x) => `${x.environment}/${x.data_class}`}
          empty={<p className="muted">No route: no call is routed (D3 never is).</p>}
        />
      ) : (
        <p className="muted">The value in force does not read as a route list.</p>
      )}
    </>
  );
}

export function ModelsPage() {
  return (
    <>
      <PageHead
        eyebrow="Quality · gateway"
        title="Models and routes"
        sub="Which models the gateway may call, and which model serves each environment and data class. The gateway is the only holder of a vendor key; a change is a proposal with its M1 gate, made in Configuration."
      />
      <div className="pg-split">
        <Card
          title="Models"
          actions={<Link to={`/config/${GATEWAY_CONFIG_KEYS.models}`}>Open in Configuration</Link>}
        >
          <ConfigTable configKey={GATEWAY_CONFIG_KEYS.models} />
        </Card>
        <Card
          title="Routes"
          actions={<Link to={`/config/${GATEWAY_CONFIG_KEYS.routes}`}>Open in Configuration</Link>}
        >
          <ConfigTable configKey={GATEWAY_CONFIG_KEYS.routes} />
        </Card>
      </div>
    </>
  );
}

const HEALTH_TONE: Readonly<Record<IntegrationHealthTile['state'], PillTone>> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'bad',
  unknown: 'mute',
};

export function IntegrationTiles({ tiles }: { tiles: readonly IntegrationHealthTile[] }) {
  if (tiles.length === 0) return <p className="muted">No integration is registered.</p>;
  return (
    <ul className="pg-tiles" aria-label="Integrations">
      {tiles.map((t) => (
        <li key={t.integration_id} className="ui-card pg-tile" data-state={t.state}>
          <div className="pg-tile-hd">
            <b>{t.display_name}</b>
            <Pill tone={HEALTH_TONE[t.state]}>{t.state}</Pill>
          </div>
          <div className="muted">
            {t.kind} · {t.adapter} · {t.status}
          </div>
          <div className="muted">
            {t.stale
              ? 'report older than two minutes'
              : t.as_of
                ? `as of ${shortTime(t.as_of)}`
                : 'no report'}
            {t.detail_code ? ` · ${t.detail_code}` : ''}
          </div>
          <div className="muted">enabled for {t.installs} project(s)</div>
        </li>
      ))}
    </ul>
  );
}

export function IntegrationsPage() {
  const q = useQuery({
    queryKey: ['integrations'],
    queryFn: api.integrations,
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHead
        eyebrow="Quality"
        title="Integrations"
        sub="Code hosts and model providers as rows of one registry, each with its health. Credentials are references (file:, env:), never values; the registry changes through Configuration with its M1 gate."
        actions={
          <Link to="/config/integrations.registry" className="ui-btn">
            Registry in Configuration
          </Link>
        }
      />
      <Read q={q} what="the integrations">
        {(v) => (
          <>
            <Card title="Health">
              <IntegrationTiles tiles={v.health.tiles} />
            </Card>
            <Card title="What published revisions did" flush>
              <Table
                caption="Integration events"
                captionHidden
                columns={[
                  {
                    key: 'i',
                    header: 'Integration',
                    rowHeader: true,
                    render: (e) => <code>{e.integration_id}</code>,
                  },
                  {
                    key: 'k',
                    header: 'Change',
                    render: (e) => (e.detail ? `${e.event} (${e.detail})` : e.event),
                  },
                  { key: 'at', header: 'When', render: (e) => shortTime(e.at) },
                  {
                    key: 'l',
                    header: 'Ledger entry',
                    render: (e) => <code>{e.ledger_entry_id}</code>,
                  },
                ]}
                rows={v.events}
                rowKey={(e) => `${e.integration_id}:${e.event}:${e.rev_hash}:${e.install_id ?? ''}`}
                empty={<p className="muted">No registry change has been published yet.</p>}
              />
            </Card>
          </>
        )}
      </Read>
    </>
  );
}
