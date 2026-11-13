import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pdpResource, type BreakerState } from '@aisdlc/contracts';
import { api } from '../api';
import { Guarded } from '../access';
import { ErrorNote } from '../components/Notice';
import { Read } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, Pill, Table, laneText, useToast, type Column } from '../ui';

// P2-11 (FL R3; core `breaker.ts`): the circuit breaker per lane of a project. What counts toward it (Q1, E4 abandon
// or takeover, a spent rework budget) since the last reset, against the catalogue's trip threshold; a tripped
// breaker routes the lane's new items to L8. The reset is never this page's: asking opens an M5 gate that the
// project's admins decide (`config.propose` to ask, the gate to decide).

function ResetButton({ b, csrf }: { b: BreakerState; csrf: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const reset = useMutation({
    mutationFn: () => api.resetBreaker(b.project_id, b.lane, csrf),
    onSuccess: () => {
      toast(`A reset of ${b.lane} is asked for: the M5 gate waits in the admins' inbox.`, 'ok');
      void qc.invalidateQueries({ queryKey: ['breakers', b.project_id] });
    },
  });
  if (!b.tripped) return <span className="muted">not tripped</span>;
  if (b.pending_reset) return <Link to="/inbox">M5 reset waiting</Link>;
  return (
    <Guarded
      action="config.propose"
      resource={pdpResource.project(b.project_id)}
      label={`Ask to reset ${b.lane}`}
    >
      <button
        type="button"
        className="ui-btn ui-btn-sm"
        disabled={reset.isPending}
        onClick={() => reset.mutate()}
      >
        Ask to reset {b.lane}
      </button>
      {reset.isError ? <ErrorNote error={reset.error} /> : null}
    </Guarded>
  );
}

export function BreakersPanel({ project, csrf }: { project: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['breakers', project],
    queryFn: () => api.breakers(project),
    refetchInterval: 30_000,
  });
  const cols: ReadonlyArray<Column<BreakerState>> = [
    { key: 'l', header: 'Lane', rowHeader: true, render: (b) => laneText(b.lane) },
    {
      key: 's',
      header: 'State',
      render: (b) =>
        b.tripped ? (
          <Pill tone="bad">tripped{b.tripped_at ? ` ${shortTime(b.tripped_at)}` : ''}</Pill>
        ) : (
          <Pill tone="ok">closed</Pill>
        ),
    },
    {
      key: 'c',
      header: 'Counted',
      align: 'right',
      render: (b) => (b.threshold === null ? `${b.total}` : `${b.total} of ${b.threshold}`),
    },
    {
      key: 'w',
      header: 'From',
      render: (b) =>
        Object.entries(b.counts)
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || '—',
    },
    { key: 'r', header: 'Resets', align: 'right', render: (b) => b.resets },
    { key: 'a', header: 'Reset', render: (b) => <ResetButton b={b} csrf={csrf} /> },
  ];
  return (
    <Card title="Breakers" flush>
      <Read q={q} what="the breakers">
        {(v) => (
          <Table
            caption={`Circuit breakers of ${project}`}
            captionHidden
            columns={cols}
            rows={v.breakers}
            rowKey={(b) => b.lane}
            empty={
              <EmptyState title="No breaker has counted">
                A lane appears here when a quarantine, an abandoned or taken-over handoff, or a
                spent rework budget counts toward its breaker.
              </EmptyState>
            }
          />
        )}
      </Read>
    </Card>
  );
}
