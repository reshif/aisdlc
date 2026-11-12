import { useQuery } from '@tanstack/react-query';
import { LANE_LABELS, type ItemListRow, type WorkItemPhase } from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Read, itemKey } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { AskForWorkButton } from '../items/AskForWorkButton';
import { Card, Chip, EmptyState, PageHead, Pill, Table, laneText, type Column } from '../ui';

// Items and the board (prototype `items`, `board`): the items the person may see, filtered to the
// projects they may view (the bff and core decide; this page only draws). Items carry no title: the
// request text is on the item page, cut to the person's data class there.

/** The board's columns, in the order of the lifecycle. */
const COLUMNS = [
  'Intake',
  'Plan',
  'Build',
  'Verify',
  'Release',
  'Close-out',
  'With people',
  'Closed',
] as const;
type BoardColumn = (typeof COLUMNS)[number];

const COLUMN_OF: Partial<Record<WorkItemPhase, BoardColumn>> = {
  Draft: 'Intake',
  Clarifying: 'Intake',
  S1: 'Intake',
  S2: 'Plan',
  S3: 'Plan',
  S4: 'Plan',
  S5: 'Plan',
  Scheduling: 'Build',
  S6: 'Build',
  S7: 'Verify',
  G4: 'Verify',
  S8a: 'Release',
  S8b: 'Release',
  G5: 'Release',
  S9: 'Close-out',
  G6: 'Close-out',
  Handoff: 'With people',
  Quarantined: 'With people',
  Parked: 'With people',
};

/** The column an item stands in: a held item stands where it resumes; a terminal one is closed. */
export const columnOf = (i: ItemListRow): BoardColumn =>
  i.terminal !== null ? 'Closed' : (COLUMN_OF[i.underlying] ?? 'Closed');

/** Where an item is, in words. */
export const phaseText = (i: ItemListRow): string =>
  i.terminal !== null
    ? i.terminal
    : i.holds > 0
      ? `${i.underlying}, held`
      : i.phase === i.underlying
        ? i.phase
        : `${i.phase} (${i.underlying})`;

function useItems() {
  return useQuery({
    queryKey: ['items', null],
    queryFn: () => api.items(),
    refetchInterval: 15_000,
  });
}

function Filters({
  rows,
  project,
  setProject,
  onlyMine,
  setOnlyMine,
}: {
  rows: readonly ItemListRow[];
  project: string;
  setProject: (p: string) => void;
  onlyMine: boolean;
  setOnlyMine: (v: boolean) => void;
}) {
  const projects = [...new Set(rows.map((r) => r.project_id))].sort();
  return (
    <div className="pg-filters" role="group" aria-label="Filters">
      <label>
        Project{' '}
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All you can see</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />{' '}
        Only my requests
      </label>
    </div>
  );
}

function useFiltered(rows: readonly ItemListRow[]) {
  const [project, setProject] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const shown = rows.filter(
    (r) => (project === '' || r.project_id === project) && (!onlyMine || r.mine),
  );
  return { shown, filters: { rows, project, setProject, onlyMine, setOnlyMine } };
}

const COLS: ReadonlyArray<Column<ItemListRow>> = [
  {
    key: 'key',
    header: 'Item',
    rowHeader: true,
    render: (i) => (
      <Link to={`/items/${i.item_id}`} aria-label={`item ${itemKey(i.item_id)}`}>
        <Chip itemKey={itemKey(i.item_id)} lane={i.lane ?? i.proposed_lane} />
      </Link>
    ),
  },
  {
    key: 'project',
    header: 'Project',
    render: (i) => <Link to={`/projects/${i.project_id}`}>{i.project_id}</Link>,
  },
  {
    key: 'lane',
    header: 'Lane',
    render: (i) =>
      i.lane ? laneText(i.lane) : <span className="muted">{i.proposed_lane} proposed</span>,
  },
  { key: 'where', header: 'Where', render: (i) => phaseText(i) },
  {
    key: 'flags',
    header: 'State',
    render: (i) => (
      <>
        {i.holds > 0 ? <Pill tone="warn">held</Pill> : null}
        {i.in_flight ? <Pill tone="agent">in a session</Pill> : null}
        {i.mine ? <Pill tone="human">yours</Pill> : null}
      </>
    ),
  },
  {
    key: 'pin',
    header: 'Catalogue',
    render: (i) => <span className="ui-mono">{i.catalogue_version}</span>,
  },
  { key: 'updated', header: 'Updated', render: (i) => shortTime(i.updated_at) },
];

export function ItemsPage() {
  const q = useItems();
  return (
    <>
      <PageHead
        eyebrow="Work"
        title="Items"
        sub="Every item you may see, where it is in the lifecycle, and whether it is held. Items carry no title here; the request is on the item page."
        actions={
          <>
            <AskForWorkButton />
            <Link to="/board" className="ui-btn">
              Board
            </Link>
          </>
        }
      />
      <Read q={q} what="the items">
        {(v) => <ItemsTable rows={v.items} />}
      </Read>
    </>
  );
}

function ItemsTable({ rows }: { rows: readonly ItemListRow[] }) {
  const { shown, filters } = useFiltered(rows);
  return (
    <>
      <Filters {...filters} />
      <Card flush>
        <Table
          caption={`${shown.length} items`}
          columns={COLS}
          rows={shown}
          rowKey={(i) => i.item_id}
          empty={<EmptyState title="No items">Nothing you may see matches.</EmptyState>}
        />
      </Card>
    </>
  );
}

export function BoardPage() {
  const q = useItems();
  return (
    <>
      <PageHead
        eyebrow="Work"
        title="Board"
        sub="The items you may see by where they stand: a held item stands where it resumes. The live floor, with gates and rooms, comes with M19."
        actions={
          <Link to="/items" className="ui-btn">
            Items
          </Link>
        }
      />
      <Read q={q} what="the board">
        {(v) => <Board rows={v.items} />}
      </Read>
    </>
  );
}

function Board({ rows }: { rows: readonly ItemListRow[] }) {
  const { shown, filters } = useFiltered(rows);
  return (
    <>
      <Filters {...filters} />
      {/* focusable, so the board scrolls sideways from the keyboard too */}
      <div className="pg-board" role="list" aria-label="Board" tabIndex={0}>
        {COLUMNS.map((c) => {
          const here = shown.filter((i) => columnOf(i) === c);
          return (
            <section
              key={c}
              className="pg-board-col"
              role="listitem"
              aria-label={`${c}: ${here.length}`}
            >
              <h2>
                {c} <span className="muted">{here.length}</span>
              </h2>
              <ul>
                {here.map((i) => (
                  <li key={i.item_id} className="pg-board-card">
                    <Link to={`/items/${i.item_id}`} aria-label={`item ${itemKey(i.item_id)}`}>
                      <Chip itemKey={itemKey(i.item_id)} lane={i.lane ?? i.proposed_lane} />
                    </Link>
                    <span>{phaseText(i)}</span>
                    <span className="muted">
                      {i.project_id}
                      {i.lane && LANE_LABELS[i.lane] ? ` · ${LANE_LABELS[i.lane]}` : ''}
                    </span>
                    {i.holds > 0 ? <Pill tone="warn">held</Pill> : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
