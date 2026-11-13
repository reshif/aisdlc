import type { AgentRunView } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, Pill, Table, type Column } from '../ui';
import { AGENT_RUN_STATE_TEXT, AGENT_RUN_VERDICT_TEXT, usd } from '../vocab';

// The item page's Agent runs tab (P2-1, DM §3.5): every run of an agent on the item, in the order it was dispatched,
// with its step, state, what came of it (the verdict the gates and back-edges gave it), its metered cost and the sha256
// of the prompt it ran with. A fold of the record (`core.agent_run`); never a prompt, an input or an output.

export const agentRunColumns = (withItem: boolean): ReadonlyArray<Column<AgentRunView>> => [
  {
    key: 'agent',
    header: 'Agent',
    rowHeader: true,
    render: (r) => <Link to={`/agents/${r.agent_id}`}>{r.agent_id}</Link>,
  },
  ...(withItem
    ? [
        {
          key: 'item',
          header: 'Item',
          render: (r: AgentRunView) => (
            <Link to={`/items/${r.item_id}`}>item {r.item_id.slice(0, 8)}</Link>
          ),
        },
      ]
    : []),
  {
    key: 'step',
    header: 'Step',
    render: (r) => (
      <>
        {r.step}
        {r.attempt > 1 ? <span className="muted"> (attempt {r.attempt})</span> : null}
      </>
    ),
  },
  {
    key: 'state',
    header: 'State',
    render: (r) => (
      <>
        {AGENT_RUN_STATE_TEXT[r.state]}
        {r.failure_code ? <span className="muted"> ({r.failure_code})</span> : null}
      </>
    ),
  },
  {
    key: 'verdict',
    header: 'Verdict',
    render: (r) => {
      const t = AGENT_RUN_VERDICT_TEXT[r.outcome.verdict];
      return (
        <>
          <Pill tone={t.tone}>{t.label}</Pill>
          {r.outcome.back_edges.length > 0 ? (
            <div className="muted">{r.outcome.back_edges.join(', ')}</div>
          ) : null}
        </>
      );
    },
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    render: (r) => (
      <span title={`${r.calls} calls, ${r.tokens_in} tokens in, ${r.tokens_out} out`}>
        {usd(r.cost_micro_usd)}
      </span>
    ),
  },
  {
    key: 'model',
    header: 'Model',
    render: (r) =>
      r.provider === null ? (
        <span className="muted">no call yet</span>
      ) : (
        `${r.provider} / ${r.model ?? '?'}`
      ),
  },
  { key: 'prompt', header: 'Prompt sha256', render: (r) => <ShortHash hash={r.prompt_sha256} /> },
  { key: 'started', header: 'Started', render: (r) => shortTime(r.started_at) },
];

export function AgentRunsTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-agent-runs', id], queryFn: () => api.itemAgentRuns(id) });
  return (
    <Read q={q} what="the agent runs">
      {(v) =>
        v.runs.length === 0 ? (
          <EmptyState title="No agent has run on this item yet" />
        ) : (
          <Card title="Agent runs" flush testId="agent-runs-tab">
            <Table
              caption="Agent runs on the item"
              captionHidden
              columns={agentRunColumns(false)}
              rows={v.runs}
              rowKey={(r) => r.run_id}
            />
          </Card>
        )
      }
    </Read>
  );
}
