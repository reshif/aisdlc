import { useQuery } from '@tanstack/react-query';
import {
  label,
  type ItemListRow,
  type PortalInboxItem,
  type ProjectSummary,
} from '@aisdlc/contracts';
import type { ReactNode } from 'react';
import { api, type Me } from '../api';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  ErrorState,
  NeedsYouTable,
  PageHeader,
  Pill,
  Stat,
  Stats,
  type NeedsYouRow,
} from '../ui';
import { AskForWorkLink } from './AskScreen';
import {
  ago,
  gateName,
  itemNo,
  listText,
  needsYouRow,
  showsCodes,
  stageOfPhase,
  wire,
} from './words';
import './work.css';

// Home, "needs you" (screen-map §2.1, skeleton screen 1): what needs me now (oldest first, overdue in red), my
// requests, what I wait on others for, my projects, and the blocks of the fleet roles. Each block reads its own route
// and fails on its own, so one refusal never takes the page with it. Nothing is decided here: a row opens Decide.

export const renderLink = (to: string, children: ReactNode, className?: string) => (
  <Link to={to} {...(className ? { className } : {})}>
    {children}
  </Link>
);

const renderCrumb = (to: string, text: string) => <Link to={to}>{text}</Link>;
export { renderCrumb };

/** Rows for "needs you": the decisions waiting on me, then the questions on my own requests. */
export function needsYouRows(
  decide: readonly PortalInboxItem[],
  mine: readonly ItemListRow[],
  now: number = Date.now(),
): NeedsYouRow[] {
  const rows = decide.map((i) => needsYouRow(i, now));
  for (const it of mine) {
    if (it.terminal !== null) continue;
    if (it.phase === 'Clarifying' || it.phase === 'Parked') {
      rows.push({
        id: `questions:${it.item_id}`,
        kind: { kind: 'questions' },
        what: `Item ${itemNo(it.item_id)}`,
        project: it.project_id,
        due: { text: `Asked ${ago(it.updated_at, now)}` },
        to: `/items/${encodeURIComponent(it.item_id)}`,
      });
    } else if (it.phase === 'Handoff') {
      rows.push({
        id: `handoff:${it.item_id}`,
        kind: { kind: 'handoff', handoff: 'D1' },
        what: `Item ${itemNo(it.item_id)}`,
        project: it.project_id,
        due: { text: `Since ${ago(it.updated_at, now)}` },
        to: `/items/${encodeURIComponent(it.item_id)}`,
        verb: 'Open',
      });
    }
  }
  return rows;
}

export function HomeScreen({ me }: { me: Me }) {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox, refetchInterval: 15_000 });
  const items = useQuery({ queryKey: ['items', null], queryFn: () => api.items() });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const fleet = me.actions.fleet;
  const codes = showsCodes(fleet);
  const mine = (items.data?.items ?? []).filter((i) => i.mine);
  const open = mine.filter((i) => i.terminal === null);
  const rows = inbox.data ? needsYouRows(inbox.data.decide, open) : [];
  const first = me.principal.display_name.split(' ')[0] ?? me.principal.display_name;
  const mayOnboard = fleet.includes('project.onboard');
  return (
    <div className="wk-page">
      <PageHeader
        title={`Hello, ${first}`}
        meta={
          inbox.data
            ? rows.length === 0
              ? 'Nothing needs you right now.'
              : `${rows.length} ${rows.length === 1 ? 'thing needs' : 'things need'} you.`
            : 'What needs you now, then what you are waiting for.'
        }
        actions={<AskForWorkLink me={me} primary />}
      />

      <Card title="Needs you" actions={<Link to="/inbox">Open the inbox</Link>} testId="home-needs">
        {inbox.isPending ? <p className="wk-muted">Loading what needs you…</p> : null}
        {inbox.isError ? (
          <p role="alert" className="wk-bad">
            The inbox could not load. Your approvals are safe; nothing expires approved.{' '}
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => void inbox.refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {inbox.data ? (
          <NeedsYouTable
            rows={rows}
            renderLink={renderLink}
            showCodes={codes}
            empty={
              <>
                Nothing needs you. <Link to="/ask">Ask for work</Link> to start
                {mayOnboard ? (
                  <>
                    , or <Link to="/onboard">onboard a repo</Link>
                  </>
                ) : null}
                .
              </>
            }
          />
        ) : null}
      </Card>

      <div className="wk-two">
        <Card
          title="My requests"
          actions={<Link to="/items?mine=1">All my items</Link>}
          testId="home-requests"
        >
          {items.isPending ? <p className="wk-muted">Loading your requests…</p> : null}
          {items.isError ? (
            <p role="alert" className="wk-bad">
              Your requests could not load.
            </p>
          ) : null}
          {items.data && open.length === 0 ? (
            <p className="wk-muted">
              You have no open request. <Link to="/ask">Ask for work</Link> and it shows here.
            </p>
          ) : null}
          {open.length > 0 ? <ItemRows rows={open.slice(0, 8)} label="My requests" /> : null}
        </Card>

        <Card title="Waiting on others" testId="home-waiting">
          {inbox.data && items.data ? (
            <WaitingOnOthers mine={open} inbox={inbox.data.view} />
          ) : (
            <p className="wk-muted">Loading…</p>
          )}
        </Card>
      </div>

      <Card
        title="My projects"
        actions={<Link to="/projects">All projects</Link>}
        testId="home-projects"
      >
        {projects.isPending ? <p className="wk-muted">Loading your projects…</p> : null}
        {projects.isError ? (
          <p role="alert" className="wk-bad">
            Your projects could not load.
          </p>
        ) : null}
        {projects.data && projects.data.length === 0 ? (
          <EmptyState title="No project yet">
            {mayOnboard ? (
              <>
                <Link to="/onboard">Onboard a repo</Link> to start.
              </>
            ) : (
              'You can see no project yet. A project admin can add you.'
            )}
          </EmptyState>
        ) : null}
        {projects.data && projects.data.length > 0 ? (
          <ul className="wk-projects" aria-label="My projects">
            {projects.data.map((p) => (
              <ProjectRow key={p.project.project_id} p={p} items={items.data?.items ?? []} />
            ))}
          </ul>
        ) : null}
      </Card>

      {fleet.includes('ops.read') ? <AdminBlock /> : null}
      {fleet.includes('audit.read') ? (
        <Card title="For auditors" testId="home-auditor">
          <p>
            <Link to="/ledger">Decision log</Link> · <Link to="/audit">Access decisions</Link> ·{' '}
            <Link to="/inbox?scope=factory">Every open approval</Link>
          </p>
        </Card>
      ) : null}
    </div>
  );
}

/** My items that wait on someone else's decision, with that person's name. */
function WaitingOnOthers({
  mine,
  inbox,
}: {
  mine: readonly ItemListRow[];
  inbox: readonly PortalInboxItem[];
}) {
  const ids = new Set(mine.map((i) => i.item_id));
  const waits = inbox.filter((i) => i.kind === 'work_gate' && i.item_id && ids.has(i.item_id));
  if (waits.length === 0) {
    return <p className="wk-muted">None of your requests waits on someone else's approval.</p>;
  }
  return (
    <ul className="wk-list" aria-label="Waiting on others">
      {waits.map((w) => (
        <li key={w.id}>
          <Link to={`/items/${encodeURIComponent(w.item_id ?? '')}`}>
            Item {itemNo(w.item_id ?? '')}
          </Link>
          <span>
            {gateName(w.gate)}:{' '}
            {w.deciders.length === 0 ? (
              <span className="wk-bad">nobody can decide it yet</span>
            ) : (
              `waiting for ${listText(w.deciders.map((d) => d.display_name))}`
            )}
          </span>
          {w.overdue ? <Pill tone="bad">Overdue</Pill> : null}
        </li>
      ))}
    </ul>
  );
}

/** Item rows: number, where it is (stage), status pill, project. */
export function ItemRows({ rows, label: name }: { rows: readonly ItemListRow[]; label: string }) {
  return (
    <ul className="wk-list" aria-label={name}>
      {rows.map((i) => {
        const stage = stageOfPhase(i.underlying);
        return (
          <li key={i.item_id}>
            <Link to={`/items/${encodeURIComponent(i.item_id)}`}>Item {itemNo(i.item_id)}</Link>
            <span>{stage ? label('stage', stage) : wire('phase', i.phase)}</span>
            <StatusPill row={i} />
            <span className="wk-muted">{i.project_id}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The one status pill of an item row. */
export function StatusPill({ row }: { row: ItemListRow }) {
  if (row.terminal !== null) return <Pill tone="mute">{wire('phase', row.terminal)}</Pill>;
  if (row.holds > 0) return <Pill tone="warn">{label('status', 'held')}</Pill>;
  if (row.phase === 'Quarantined') return <Pill tone="bad">{wire('phase', row.phase)}</Pill>;
  if (['Handoff', 'Clarifying', 'Parked', 'G4', 'G5', 'G6'].includes(row.phase)) {
    return <Pill tone="gate">{wire('phase', row.phase)}</Pill>;
  }
  return (
    <Pill tone={row.in_flight ? 'info' : 'neutral'}>{row.in_flight ? 'Working' : 'Waiting'}</Pill>
  );
}

function ProjectRow({ p, items }: { p: ProjectSummary; items: readonly ItemListRow[] }) {
  const id = p.project.project_id;
  const live = items.filter((i) => i.project_id === id && i.terminal === null);
  return (
    <li>
      <Link to={`/projects/${encodeURIComponent(id)}`}>{p.project.name}</Link>
      <Pill tone="info">{wire('level', p.project.level)}</Pill>
      <span className="wk-muted">
        {live.length} in progress · {live.filter((i) => i.holds > 0).length} on hold
      </span>
    </li>
  );
}

function AdminBlock() {
  const kills = useQuery({ queryKey: ['kills', 'active'], queryFn: () => api.activeKills() });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health() });
  const stopped = kills.data?.kills.length;
  return (
    <Card title="Factory" testId="home-admin">
      <Stats label="The factory at a glance">
        <Stat
          label={label('screen', 'emergency_stop')}
          value={
            kills.isError
              ? 'Unknown'
              : stopped === undefined
                ? '…'
                : stopped === 0
                  ? 'Off'
                  : `${stopped} on`
          }
          {...(kills.isError || (stopped ?? 0) > 0 ? { tone: 'bad' as const } : {})}
        />
        <Stat
          label={label('screen', 'health')}
          value={health.isError ? 'Unknown' : health.data ? 'See health' : '…'}
        />
      </Stats>
      <p>
        <Link to="/kill">{label('screen', 'emergency_stop')}</Link> ·{' '}
        <Link to="/health">{label('screen', 'health')}</Link> ·{' '}
        <Link to="/config">{label('screen', 'settings')}</Link> ·{' '}
        <Link to="/integrations">{label('screen', 'integrations')}</Link>
      </p>
    </Card>
  );
}

/** The 403 used by the Work screens: the reason, and where to look. */
export function Forbidden({ reason }: { reason?: string }) {
  return (
    <ErrorState
      status={403}
      {...(reason ? { reason } : {})}
      action={<Link to="/me/access">See my access</Link>}
    />
  );
}
