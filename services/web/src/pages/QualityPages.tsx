import { useQuery } from '@tanstack/react-query';
import type { EvalRunHeader } from '@aisdlc/contracts';
import { ErrorNote, Loading } from '../components/Notice';
import { NotBuilt, Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { api } from '../api';
import { Card, EmptyState, PageHead, Pill, Table, type Column } from '../ui';

// Evaluations (Agents › Evaluations): every evaluation run the tooling recorded and the newest result per task. The
// agents themselves, their settings and their scores are on the Agents pages (src/agents). Reads are `quality.read`.

const pct = (x: number) => `${Math.round(x * 100)}%`;

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
