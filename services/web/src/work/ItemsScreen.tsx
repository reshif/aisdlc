import { useQuery } from '@tanstack/react-query';
import {
  LaneValues,
  label,
  type ItemListRow,
  type PortalInboxItem,
  type StageId,
} from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { api, type Me } from '../api';
import { Link } from '../router';
import { EmptyState, PageHeader, Pill, Table, type Column } from '../ui';
import { AskForWorkLink } from './AskScreen';
import { StatusPill } from './HomeScreen';
import {
  ago,
  fullTime,
  gateName,
  itemNo,
  listText,
  stageOfPhase,
  STRIP_STAGES,
  wire,
} from './words';
import './work.css';

// Items (screen-map §2.5): every work item the person can see (the bff and core decide; this page only draws), with
// filters (project, track, stage, status, mine), a list or a board in columns by stage, and for audit readers the
// CSV export (N6). Items carry no title: the request text stays on the item page, cut to the person's data class.

type View = 'list' | 'board';
type Status = '' | 'open' | 'held' | 'ended';

/** The board's columns: the stages, then "Needs a person" and "Ended". */
const BOARD: ReadonlyArray<{ id: string; label: string }> = [
  ...STRIP_STAGES.map((s) => ({ id: s, label: label('stage', s) })),
  { id: 'people', label: label('phase', 'Handoff') },
  { id: 'ended', label: 'Ended' },
];

export const boardColumn = (i: ItemListRow): string => {
  if (i.terminal !== null) return 'ended';
  if (['Handoff', 'Quarantined'].includes(i.underlying)) return 'people';
  return stageOfPhase(i.underlying) ?? 'people';
};

/** Who an item waits on, from the open approvals the person can see. */
function waitingOn(i: ItemListRow, gates: readonly PortalInboxItem[]): string {
  const g = gates.find((x) => x.item_id === i.item_id);
  if (!g) return i.terminal !== null ? '' : i.in_flight ? 'The agents' : '';
  const who =
    g.deciders.length === 0 ? 'nobody yet' : listText(g.deciders.map((d) => d.display_name));
  return `${gateName(g.gate)}: ${who}`;
}

export function ItemsScreen({ me }: { me: Me }) {
  const q = useQuery({
    queryKey: ['items', null],
    queryFn: () => api.items(),
    refetchInterval: 15_000,
  });
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox() });
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>(
    params.get('view') === 'board' || window.location.pathname === '/board' ? 'board' : 'list',
  );
  const [project, setProject] = useState('');
  const [lane, setLane] = useState('');
  const [stage, setStage] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [mine, setMine] = useState(params.get('mine') === '1');
  const ids = { project: useId(), lane: useId(), stage: useId(), status: useId(), mine: useId() };
  const gates = [...(inbox.data?.decide ?? []), ...(inbox.data?.view ?? [])].filter(
    (g) => g.kind === 'work_gate',
  );
  const rows = q.data?.items ?? [];
  const shown = rows.filter(
    (i) =>
      (project === '' || i.project_id === project) &&
      (lane === '' || (i.lane ?? i.proposed_lane) === lane) &&
      (stage === '' || stageOfPhase(i.underlying) === stage) &&
      (status === '' ||
        (status === 'ended'
          ? i.terminal !== null
          : status === 'held'
            ? i.holds > 0
            : i.terminal === null)) &&
      (!mine || i.mine),
  );
  const projects = [...new Set(rows.map((r) => r.project_id))].sort();
  const exporter = me.actions.fleet.includes('audit.read');

  const cols: ReadonlyArray<Column<ItemListRow>> = [
    {
      key: 'item',
      header: label('concept', 'item_key'),
      rowHeader: true,
      render: (i) => (
        <Link to={`/items/${encodeURIComponent(i.item_id)}`}>Item {itemNo(i.item_id)}</Link>
      ),
    },
    { key: 'project', header: label('concept', 'project'), render: (i) => i.project_id },
    {
      key: 'track',
      header: label('concept', 'lane'),
      render: (i) => (
        <>
          {wire('lane', i.lane ?? i.proposed_lane)}
          {i.lane === null ? <span className="wk-muted"> (proposed)</span> : null}
        </>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      render: (i) => {
        const s = stageOfPhase(i.underlying);
        return s ? label('stage', s) : wire('phase', i.terminal ?? i.phase);
      },
    },
    { key: 'status', header: 'Status', render: (i) => <StatusPill row={i} /> },
    {
      key: 'age',
      header: 'Age',
      render: (i) => <span title={fullTime(i.created_at)}>{ago(i.created_at)}</span>,
    },
    {
      key: 'waiting',
      header: 'Waiting on',
      render: (i) => waitingOn(i, gates) || <span className="wk-muted">–</span>,
    },
  ];

  return (
    <div className="wk-page">
      <PageHeader
        title={label('screen', 'items')}
        meta={`${label('screen', 'items')}: every work item you can see. ${q.data ? `${shown.length} of ${rows.length} shown.` : ''}`}
        actions={
          <>
            {exporter ? (
              <a className="ui-btn" href="/api/items/export.csv" download>
                Export CSV
              </a>
            ) : null}
            <AskForWorkLink me={me} primary />
          </>
        }
      />
      <div className="wk-filters" role="group" aria-label="Filters">
        <div className="wk-field">
          <label htmlFor={ids.project} className="ui-label">
            {label('concept', 'project')}
          </label>
          <select
            id={ids.project}
            className="ui-input ui-select"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">All you can see</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="wk-field">
          <label htmlFor={ids.lane} className="ui-label">
            {label('concept', 'lane')}
          </label>
          <select
            id={ids.lane}
            className="ui-input ui-select"
            value={lane}
            onChange={(e) => setLane(e.target.value)}
          >
            <option value="">Every track</option>
            {LaneValues.map((l) => (
              <option key={l} value={l}>
                {wire('lane', l)}
              </option>
            ))}
          </select>
        </div>
        <div className="wk-field">
          <label htmlFor={ids.stage} className="ui-label">
            Stage
          </label>
          <select
            id={ids.stage}
            className="ui-input ui-select"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="">Every stage</option>
            {STRIP_STAGES.map((s: StageId) => (
              <option key={s} value={s}>
                {label('stage', s)}
              </option>
            ))}
          </select>
        </div>
        <div className="wk-field">
          <label htmlFor={ids.status} className="ui-label">
            Status
          </label>
          <select
            id={ids.status}
            className="ui-input ui-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            <option value="">Any</option>
            <option value="open">In progress</option>
            <option value="held">{label('status', 'held')}</option>
            <option value="ended">Ended</option>
          </select>
        </div>
        <div className="wk-row">
          <input
            id={ids.mine}
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          <label htmlFor={ids.mine}>Only my requests</label>
        </div>
        <div className="wk-row" role="group" aria-label="Show as">
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            aria-pressed={view === 'board'}
            onClick={() => setView('board')}
          >
            Board
          </button>
        </div>
      </div>

      {q.isPending ? <p className="wk-muted">Loading the items…</p> : null}
      {q.isError ? (
        <p role="alert" className="wk-bad">
          The items could not load.{' '}
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => void q.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {q.data && rows.length === 0 ? (
        <EmptyState title="No work items yet" action={<AskForWorkLink me={me} />}>
          Ask for work and it shows here.
        </EmptyState>
      ) : null}
      {q.data && rows.length > 0 && shown.length === 0 ? (
        <p className="wk-muted">No item matches these filters.</p>
      ) : null}
      {shown.length > 0 && view === 'list' ? (
        <div className="wk-scroll">
          <Table
            caption="Work items"
            captionHidden
            columns={cols}
            rows={shown}
            rowKey={(i) => i.item_id}
          />
        </div>
      ) : null}
      {shown.length > 0 && view === 'board' ? (
        <div className="wk-board" data-testid="board">
          {BOARD.map((col) => {
            const here = shown.filter((i) => boardColumn(i) === col.id);
            return (
              <section key={col.id} className="wk-board-col" aria-label={col.label}>
                <h3>
                  {col.label} <span className="wk-muted">{here.length}</span>
                </h3>
                {here.map((i) => (
                  <div key={i.item_id} className="wk-icard">
                    <Link to={`/items/${encodeURIComponent(i.item_id)}`}>
                      Item {itemNo(i.item_id)}
                    </Link>
                    <span className="wk-muted">
                      {i.project_id} · {wire('lane', i.lane ?? i.proposed_lane)}
                    </span>
                    {i.holds > 0 ? <Pill tone="warn">{label('status', 'held')}</Pill> : null}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
