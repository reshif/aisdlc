import {
  AgentSettingsRow,
  DEFAULT_CODER_LIMITS,
  label,
  type AgentDetailView,
  type AgentScore,
  type AgentsSettingsConfig,
  type EvalRunHeader,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, type ConfigKeyWire } from '../api';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { agentRunColumns } from '../items/AgentRunsTab';
import { Link } from '../router';
import { ChangeActions } from '../settings/ChangeActions';
import {
  Card,
  EmptyState,
  KeyValue,
  PageHeader,
  Pill,
  Stat,
  Stats,
  Table,
  Tabs,
  Term,
  type Column,
  type PillTone,
} from '../ui';
import { usd } from '../vocab';
import {
  AGENTS_KEY,
  agentName,
  agentWhat,
  isOn,
  rowsOf,
  useAgentsConfig,
  useModelIds,
} from './AgentsPage';

// One agent (screen map §2.14): its settings (on or off, model, turns, time limit, budget per run: `agents.config`,
// changed as every setting is), its quality (scores per prompt, provider and model; evaluations; production outcomes),
// its recent runs, and its instructions (the prompt and contract in force: code, read only). A run keeps no transcript
// (hashes, tokens and cost only), whatever the data class.

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

const STATUS_TONE: Readonly<Record<AgentScore['status'], PillTone>> = {
  pass: 'ok',
  flaky: 'warn',
  fail: 'bad',
  unknown: 'mute',
};
const STATUS_WORD: Readonly<Record<AgentScore['status'], string>> = {
  pass: 'Passing',
  flaky: 'Unsteady',
  fail: 'Failing',
  unknown: 'Unknown',
};

const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'quality', label: 'Quality' },
  { id: 'runs', label: 'Runs' },
  { id: 'instructions', label: 'Instructions' },
] as const;

export function AgentPage({ id, csrf }: { id: string; csrf: string }) {
  const detail = useQuery({ queryKey: ['agent', id], queryFn: () => api.agent(id) });
  return (
    <Read q={detail} what="the agent">
      {(d) => <AgentBody id={id} d={d} csrf={csrf} />}
    </Read>
  );
}

function AgentBody({ id, d, csrf }: { id: string; d: AgentDetailView; csrf: string }) {
  const [tab, setTab] = useState<string>('settings');
  const cfg = useAgentsConfig();
  const row = rowsOf(cfg.data)[d.agent.agent_id];
  const name = agentName(d.agent.agent_id);
  return (
    <>
      <PageHeader
        title={name}
        crumbs={[{ label: label('screen', 'agents'), to: '/agents' }, { label: name }]}
        renderLink={(to, text) => <Link to={to}>{text}</Link>}
        status={
          cfg.isError ? (
            <Pill tone="mute">Unknown</Pill>
          ) : isOn(row) ? (
            <Pill tone="ok">On</Pill>
          ) : (
            <Pill tone="bad">Off</Pill>
          )
        }
        meta={agentWhat(d.agent.agent_id)}
      />
      <Tabs label="About this agent" tabs={TABS} selected={tab} onSelect={setTab}>
        {tab === 'settings' ? (
          cfg.data ? (
            <AgentSettings d={d} cfg={cfg.data} csrf={csrf} />
          ) : cfg.isError ? (
            <p className="muted" data-testid="agent-settings-denied">
              You can see how this agent works but not its settings.
            </p>
          ) : (
            <p className="muted">Reading the settings…</p>
          )
        ) : null}
        {tab === 'quality' ? (
          <>
            <Outcomes id={id} />
            <Scores id={id} current={d.agent.prompt.sha256} />
            <EvalHistory id={id} current={d.agent.prompt.sha256} />
          </>
        ) : null}
        {tab === 'runs' ? <RecentRuns id={id} /> : null}
        {tab === 'instructions' ? <Instructions d={d} /> : null}
      </Tabs>
    </>
  );
}

/** A number field with its own text (blank: the contract's value). */
function NumberField({
  label: name,
  value,
  placeholder,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder: string;
  min: number;
  max: number;
  onChange: (v: number | undefined) => void;
}) {
  const id = useId();
  return (
    <div>
      <label className="ui-label" htmlFor={id}>
        {name}
      </label>
      <input
        id={id}
        className="ui-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      <p className="ui-help">
        {min.toLocaleString('en-GB')} to {max.toLocaleString('en-GB')}; leave empty for the
        agent&rsquo;s own default ({placeholder}).
      </p>
    </div>
  );
}

const compact = (r: AgentSettingsRow): AgentSettingsRow =>
  Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as AgentSettingsRow;

function AgentSettings({ d, cfg, csrf }: { d: AgentDetailView; cfg: ConfigKeyWire; csrf: string }) {
  const a = d.agent;
  const rows = rowsOf(cfg);
  const inForce = rows[a.agent_id] ?? {};
  const [draft, setDraft] = useState<AgentSettingsRow>(inForce);
  const [forHead, setForHead] = useState(cfg.head_rev_hash);
  if (forHead !== cfg.head_rev_hash) {
    setForHead(cfg.head_rev_hash);
    setDraft(inForce);
  }
  const models = useModelIds();
  const options = [...new Set([...a.models, ...(models.data ?? [])])];
  const isCoder = a.agent_id === 'coder';
  const modelId = useId();
  const set = (patch: Partial<AgentSettingsRow>) => setDraft((r) => compact({ ...r, ...patch }));
  const parsed = AgentSettingsRow.safeParse(draft);
  const next: AgentsSettingsConfig = { ...rows, [a.agent_id]: draft };
  if (Object.keys(draft).length === 0) delete (next as Record<string, unknown>)[a.agent_id];
  const changed = JSON.stringify(compact(inForce)) !== JSON.stringify(compact(draft));
  const budget = draft.budget;
  return (
    <Card title="Settings" testId="agent-settings">
      <form
        className="st-form"
        aria-label={`Settings of ${agentName(a.agent_id)}`}
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="check">
          <input
            type="checkbox"
            checked={draft.enabled !== false}
            disabled={!cfg.may_propose}
            onChange={(e) => set({ enabled: e.target.checked ? undefined : false })}
          />{' '}
          On (an agent that is off runs nothing)
        </label>
        <div>
          <label className="ui-label" htmlFor={modelId}>
            Model
          </label>
          <select
            id={modelId}
            className="ui-input"
            disabled={!cfg.may_propose}
            value={draft.models?.[0] ?? ''}
            onChange={(e) => set({ models: e.target.value === '' ? undefined : [e.target.value] })}
          >
            <option value="">Its own default ({a.models.join(', ') || 'none'})</option>
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="ui-help">
            Only models the gateway knows are offered; most sensitive data it may see:{' '}
            <Term family="dataClass" value={a.data_class_max} />.
          </p>
        </div>
        {isCoder ? (
          <>
            <NumberField
              label="Most turns in one session"
              value={draft.max_turns}
              placeholder={String(DEFAULT_CODER_LIMITS.max_turns)}
              min={1}
              max={500}
              onChange={(v) => set({ max_turns: v })}
            />
            <NumberField
              label="Session time limit (seconds)"
              value={draft.run_time_s}
              placeholder={String(DEFAULT_CODER_LIMITS.run_time_s)}
              min={60}
              max={14_400}
              onChange={(v) => set({ run_time_s: v })}
            />
            <NumberField
              label="Test run time limit (seconds)"
              value={draft.test_time_s}
              placeholder={String(DEFAULT_CODER_LIMITS.test_time_s)}
              min={30}
              max={14_400}
              onChange={(v) => set({ test_time_s: v })}
            />
          </>
        ) : null}
        <fieldset className="cfg-group">
          <legend>Budget per run</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={budget !== undefined}
              disabled={!cfg.may_propose}
              onChange={(e) =>
                set({
                  budget: e.target.checked
                    ? { max_tokens: 200_000, max_cost_micro_usd: 2_000_000, ttl_seconds: 3600 }
                    : undefined,
                })
              }
            />{' '}
            Set its own budget (otherwise its definition&rsquo;s)
          </label>
          {budget ? (
            <>
              <NumberField
                label="Most tokens"
                value={budget.max_tokens}
                placeholder="200,000"
                min={1}
                max={1_000_000_000}
                onChange={(v) => set({ budget: { ...budget, max_tokens: v ?? 0 } })}
              />
              <NumberField
                label="Most money (millionths of a dollar)"
                value={budget.max_cost_micro_usd}
                placeholder="2,000,000"
                min={1}
                max={1_000_000_000_000}
                onChange={(v) => set({ budget: { ...budget, max_cost_micro_usd: v ?? 0 } })}
              />
              <NumberField
                label="Key lasts (seconds)"
                value={budget.ttl_seconds}
                placeholder="3,600"
                min={60}
                max={86_400}
                onChange={(v) => set({ budget: { ...budget, ttl_seconds: v ?? 0 } })}
              />
            </>
          ) : null}
        </fieldset>
      </form>
      {!parsed.success ? (
        <div className="notice notice-bad" role="alert" aria-label="Problems with the draft">
          <ul>
            {parsed.error.issues.map((i) => (
              <li key={i.path.join('.') + i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {cfg.may_propose ? (
        <ChangeActions
          configKey={AGENTS_KEY}
          draft={next}
          parent={cfg.head_rev_hash}
          csrf={csrf}
          mayApplyNow={cfg.may_apply_now === true}
          blocked={
            !changed
              ? 'Change a field to send a change.'
              : !parsed.success
                ? 'Fix the problems above first.'
                : null
          }
        />
      ) : (
        <p className="muted">You can read these settings but not change them.</p>
      )}
      {cfg.pending.length > 0 ? (
        <p data-testid="agent-pending">
          <Pill tone="warn">{cfg.pending.length} waiting for approval</Pill>{' '}
          <Link to={`/settings/agents/${AGENTS_KEY}`}>See the changes waiting</Link>
        </p>
      ) : null}
    </Card>
  );
}

function Instructions({ d }: { d: AgentDetailView }) {
  const a = d.agent;
  return (
    <Card title="Instructions and definition" testId="agent-contract">
      <KeyValue
        rows={[
          [
            'Works at',
            [...a.steps, ...a.specialist_steps].map((s) => label('step', s)).join(', ') || 'none',
          ],
          ['Definition version', a.contract_version],
          ['Tools it may use', a.tools.length === 0 ? 'none' : a.tools.join(', ')],
          ['Most sensitive data', <Term key="dc" family="dataClass" value={a.data_class_max} />],
          ['Its own default model', a.models.join(', ') || 'none'],
          [
            'Instructions in force',
            <>
              <code>{a.prompt.ref}</code> <ShortHash hash={a.prompt.sha256} />
            </>,
          ],
          ['Transcripts', 'not kept: a run records hashes, tokens and cost only'],
        ]}
      />
      <p className="muted">
        The instructions and the definition are code: they change by a reviewed pull request that
        passes the evaluation gate.
      </p>
      <details>
        <summary>What it is given (JSON Schema)</summary>
        <pre className="ask-text" data-testid="agent-input-schema">
          {JSON.stringify(d.input_schema, null, 2)}
        </pre>
      </details>
      <details>
        <summary>What it must answer (JSON Schema)</summary>
        <pre className="ask-text" data-testid="agent-output-schema">
          {JSON.stringify(d.output_schema, null, 2)}
        </pre>
      </details>
    </Card>
  );
}

function Outcomes({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['agent-stats', id], queryFn: () => api.agentStats(id) });
  return (
    <Read q={q} what="the production outcomes">
      {(s) => (
        <Stats label="Production outcomes">
          <Stat label="Runs" value={s.runs} detail={`${s.finished} finished, ${s.failed} failed`} />
          <Stat
            label="Accepted"
            value={pct(s.acceptance_rate)}
            detail={`${s.accepted} of ${s.judged} judged`}
          />
          <Stat
            label="Rework caused"
            value={pct(s.back_edge_rate)}
            detail={`${s.with_back_edge} runs with a back-edge; ${s.sent_back} sent back, ${s.reworked} reworked`}
          />
          <Stat
            label="Handed off"
            value={s.handed_off}
            {...(s.handed_off > 0 ? { tone: 'warn' as const } : {})}
          />
          <Stat
            label="Cost per run"
            value={
              s.cost_per_run_micro_usd === null ? 'n/a' : usd(Math.round(s.cost_per_run_micro_usd))
            }
            detail={`${usd(s.cost_micro_usd)} in all, ${s.calls} calls`}
          />
        </Stats>
      )}
    </Read>
  );
}

function Scores({ id, current }: { id: string; current: string }) {
  const q = useQuery({ queryKey: ['agent-scores', id], queryFn: () => api.agentScores(id) });
  const cols: ReadonlyArray<Column<AgentScore>> = [
    {
      key: 'prompt',
      header: 'Prompt',
      rowHeader: true,
      render: (r) => (
        <>
          <ShortHash hash={r.prompt_sha256} />
          {r.prompt_sha256 === current ? (
            <>
              {' '}
              <Pill tone="info">current</Pill>
            </>
          ) : null}
        </>
      ),
    },
    { key: 'model', header: 'Provider / model', render: (r) => `${r.provider} / ${r.model}` },
    {
      key: 'passk',
      header: 'Passes every time',
      align: 'right',
      render: (r) => <b>{pct(r.pass_k)}</b>,
    },
    { key: 'rate', header: 'Pass rate', align: 'right', render: (r) => pct(r.pass_rate) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={STATUS_TONE[r.status]}>{STATUS_WORD[r.status]}</Pill>,
    },
    {
      key: 'prod',
      header: 'In production',
      render: (r) =>
        r.production_judged === 0 ? (
          <span className="muted">{r.production_runs} runs, none judged</span>
        ) : (
          `${pct(r.accept_rate)} accepted, ${pct(r.rework_rate)} reworked (${r.production_judged} judged)`
        ),
    },
    {
      key: 'last',
      header: 'Last eval',
      render: (r) => (r.last_eval_at === null ? 'never' : shortTime(r.last_eval_at)),
    },
  ];
  return (
    <Read q={q} what="the scores">
      {(v) => (
        <Card title="Scores by prompt, provider and model" flush testId="agent-scores">
          <Table
            caption="Agent scores"
            captionHidden
            columns={cols}
            rows={v.scores}
            rowKey={(r) => r.score_id}
            empty={<p className="muted">No eval run or judged production run yet.</p>}
          />
        </Card>
      )}
    </Read>
  );
}

/** Scores over time: each eval run of the agent, oldest first, with the prompt it ran. */
function EvalHistory({ id, current }: { id: string; current: string }) {
  const q = useQuery({ queryKey: ['agent-eval-runs', id], queryFn: () => api.agentEvalRuns(id) });
  const cols: ReadonlyArray<Column<EvalRunHeader>> = [
    { key: 'ended', header: 'Ended', rowHeader: true, render: (r) => shortTime(r.ended_at) },
    { key: 'suite', header: 'Suite', render: (r) => <code>{r.suite_id}</code> },
    {
      key: 'prompt',
      header: 'Prompt',
      render: (r) => (
        <>
          <ShortHash hash={r.prompt_sha256} />
          {r.prompt_sha256 === current ? null : (
            <>
              {' '}
              <Pill tone="warn">other prompt</Pill>
            </>
          )}
        </>
      ),
    },
    { key: 'model', header: 'Provider / model', render: (r) => `${r.provider} / ${r.model}` },
    {
      key: 'rate',
      header: 'Pass rate',
      align: 'right',
      render: (r) => (
        <span data-testid="eval-rate">
          <meter min={0} max={1} value={r.pass_rate} aria-hidden="true" /> {pct(r.pass_rate)} (
          {r.passes}/{r.trials}, k={r.k})
        </span>
      ),
    },
    {
      key: 'errored',
      header: 'Errored',
      align: 'right',
      render: (r) => (r.errored > 0 ? <Pill tone="bad">{r.errored}</Pill> : '0'),
    },
  ];
  return (
    <Read q={q} what="the eval runs">
      {(v) => (
        <Card title="Eval runs over time" flush testId="agent-eval-history">
          <Table
            caption="Eval runs of the agent, oldest first"
            captionHidden
            columns={cols}
            rows={[...v.runs].sort((x, y) => x.ended_at.localeCompare(y.ended_at))}
            rowKey={(r) => r.eval_run_id}
            empty={<p className="muted">No eval run is recorded for this agent.</p>}
          />
        </Card>
      )}
    </Read>
  );
}

function RecentRuns({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['agent-runs', id], queryFn: () => api.agentRecentRuns(id) });
  return (
    <Read q={q} what="the recent runs">
      {(v) =>
        v.runs.length === 0 ? (
          <EmptyState title="No production run you may see yet" />
        ) : (
          <Card
            title={`Recent runs (${v.runs.length} of ${v.total})`}
            flush
            testId="agent-recent-runs"
          >
            <Table
              caption="Recent runs of the agent"
              captionHidden
              columns={agentRunColumns(true)}
              rows={v.runs}
              rowKey={(r) => r.run_id}
            />
          </Card>
        )
      }
    </Read>
  );
}
