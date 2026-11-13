import type { AgentDetailView, AgentScore, EvalRunHeader } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { agentRunColumns } from '../items/AgentRunsTab';
import { Link } from '../router';
import {
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
import { usd } from '../vocab';
import { StepChips } from './QualityPages';

// One agent (P2-3, DM §3.5, PLAN M11): its contract and the JSON Schemas of its input and output, the prompt it runs
// with (pinned by sha256), its scores over time (each eval run's pass rate, and pass^k per prompt, provider and model),
// what came of its production runs (acceptance, rework, cost) and its newest runs with their items. Every read is
// `quality.read` on the fleet; a run of a project the person may not view is left out by core. The registry is code:
// nothing here changes the agent. A run keeps no transcript (hashes, tokens and cost only), whatever the data class.

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

const STATUS_TONE: Readonly<Record<AgentScore['status'], PillTone>> = {
  pass: 'ok',
  flaky: 'warn',
  fail: 'bad',
  unknown: 'mute',
};

export function AgentPage({ id }: { id: string }) {
  const detail = useQuery({ queryKey: ['agent', id], queryFn: () => api.agent(id) });
  return (
    <>
      <p className="crumbs">
        <Link to="/agents">Agents</Link> / {id}
      </p>
      <Read q={detail} what="the agent">
        {(d) => <AgentBody id={id} d={d} />}
      </Read>
    </>
  );
}

function AgentBody({ id, d }: { id: string; d: AgentDetailView }) {
  const a = d.agent;
  return (
    <>
      <PageHead
        eyebrow="Quality · Agents"
        title={`${a.agent_id} ${a.name ?? ''}`.trim()}
        sub={a.note ?? 'An agent of the registry (packages/agents).'}
      />
      <Card title="Contract" testId="agent-contract">
        <KeyValue
          rows={[
            ['Role', a.role ?? 'unbound'],
            ['Acts at', <StepChips key="steps" a={a} />],
            ['Contract version', a.contract_version],
            ['Input schema', <code key="in">{d.input_schema_id}</code>],
            ['Output schema', <code key="out">{a.output_schema_id}</code>],
            [
              'Tools',
              a.tools.length === 0 ? 'none' : a.tools.map((t) => <code key={t}>{t} </code>),
            ],
            [
              'Data class at most',
              <Pill key="dc" plain>
                {a.data_class_max}
              </Pill>,
            ],
            ['Prefers', a.models.join(', ') || 'no model named'],
            [
              'Prompt',
              <>
                <code>{a.prompt.ref}</code> <ShortHash hash={a.prompt.sha256} />{' '}
                <span className="muted">({d.lock_format})</span>
              </>,
            ],
            ['Transcripts', 'not kept: a run records hashes, tokens and cost only'],
          ]}
        />
        <details>
          <summary>Input JSON Schema</summary>
          <pre className="ask-text" data-testid="agent-input-schema">
            {JSON.stringify(d.input_schema, null, 2)}
          </pre>
        </details>
        <details>
          <summary>Output JSON Schema</summary>
          <pre className="ask-text" data-testid="agent-output-schema">
            {JSON.stringify(d.output_schema, null, 2)}
          </pre>
        </details>
      </Card>
      <Outcomes id={id} />
      <Scores id={id} current={a.prompt.sha256} />
      <EvalHistory id={id} current={a.prompt.sha256} />
      <RecentRuns id={id} />
    </>
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
      header: 'pass^k',
      align: 'right',
      render: (r) => <b>{pct(r.pass_k)}</b>,
    },
    { key: 'rate', header: 'Pass rate', align: 'right', render: (r) => pct(r.pass_rate) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>,
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
