import { useQuery } from '@tanstack/react-query';
import { roleDef, type ItemListRow, type ProjectSummary, type RoleId } from '@aisdlc/contracts';
import { api, type Me } from '../api';
import { useAccess } from '../access';
import { ErrorNote, Loading } from '../components/Notice';
import { itemKey } from '../components/Read';
import { shortTime } from '../format';
import { AskForWorkButton } from '../items/AskForWorkButton';
import { Link } from '../router';
import { Card, Chip, EmptyState, PageHead, Pill, Stat, Stats } from '../ui';
import { levelTitle } from '../vocab';
import { hrefOf, titleOf } from './InboxPage';
import { phaseText } from './ItemsPage';

// Home, per person (prototype `home`): what needs you, your requests, your projects, the roles you hold.
// Each block reads its own route, so a block the person may not open (or a route that fails) says so
// without taking the rest of the page with it.

const greeting = (d: Date): string => {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/** The roles the person holds anywhere, in force, each with where (fleet or the projects). */
function useRoles(): { loading: boolean; roles: Array<{ role: RoleId; where: string }> } {
  const a = useAccess();
  if (!a.data) return { loading: a.isPending, roles: [] };
  const where = new Map<RoleId, Set<string>>();
  for (const b of a.data.bindings) {
    if (b.blockers.length > 0) continue;
    const at = b.scope.kind === 'fleet' ? 'whole factory' : (b.project_id ?? b.scope.ref);
    where.set(b.role_id, (where.get(b.role_id) ?? new Set()).add(at));
  }
  return {
    loading: false,
    roles: [...where].map(([role, w]) => ({ role, where: [...w].sort().join(', ') })),
  };
}

export function HomePage({ me }: { me: Me }) {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox, refetchInterval: 15_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const items = useQuery({ queryKey: ['items', null], queryFn: () => api.items() });
  const roles = useRoles();
  const first = me.principal.display_name.split(' ')[0] ?? me.principal.display_name;
  const waiting = inbox.data?.decide ?? [];
  const mine = (items.data?.items ?? []).filter((i) => i.mine);
  const fleetAudit = me.actions.fleet.includes('audit.read');
  const top = roles.roles[0]?.role;

  return (
    <>
      <PageHead
        eyebrow={top ? roleName(top) : 'Signed in'}
        title={`${greeting(new Date())}, ${first}`}
        sub={
          inbox.data === undefined
            ? 'What waits for you, your requests and your projects.'
            : waiting.length === 0
              ? 'Nothing needs you right now.'
              : `${waiting.length} ${waiting.length === 1 ? 'decision waits' : 'decisions wait'} for you.`
        }
        actions={
          <>
            <AskForWorkButton />
            <Link to="/ask" className="ui-btn">
              Ask the factory
            </Link>
            {me.actions.fleet.includes('project.onboard') ? (
              <Link to="/onboard" className="ui-btn">
                Onboard a repo
              </Link>
            ) : null}
          </>
        }
      />

      <Card title="Your roles" testId="home-roles">
        {roles.loading ? <Loading what="your roles" /> : null}
        {!roles.loading && roles.roles.length === 0 ? (
          <p className="muted">
            You hold no role in force. <Link to="/me/access">What can I do?</Link>
          </p>
        ) : null}
        {roles.roles.length > 0 ? (
          <ul className="pg-chips" aria-label="Your roles">
            {roles.roles.map((r) => (
              <li key={r.role} className="pg-role">
                <b>{roleName(r.role)}</b>
                <span className="muted">{r.where}</span>
              </li>
            ))}
            <li>
              <Link to="/me/access">What can I do?</Link>
            </li>
          </ul>
        ) : null}
      </Card>

      <div className="pg-split">
        <div className="pg-col">
          <Card title="Needs you" actions={<Link to="/inbox">Inbox</Link>} testId="home-needs">
            {inbox.isPending ? <Loading what="what waits for you" /> : null}
            {inbox.isError ? (
              <ErrorNote error={inbox.error} retry={() => void inbox.refetch()} />
            ) : null}
            {inbox.data && waiting.length === 0 ? (
              <EmptyState title="Nothing waits on you">
                Decisions, questions and access requests for your roles appear here first.
              </EmptyState>
            ) : null}
            {waiting.length > 0 ? (
              <ul className="pg-list" aria-label="Waiting for you">
                {waiting.map((i) => (
                  <li key={i.id}>
                    <Link to={hrefOf(i)}>{titleOf(i)}</Link>
                    <span className="muted"> · {i.project_id}</span>
                    {i.overdue ? <Pill tone="bad">overdue</Pill> : null}
                    {i.sla_due_at ? (
                      <span className="muted"> · due {shortTime(i.sla_due_at)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card
            title="Your requests"
            actions={<Link to="/items">Items</Link>}
            testId="home-requests"
          >
            {items.isPending ? <Loading what="your requests" /> : null}
            {items.isError ? (
              <ErrorNote error={items.error} retry={() => void items.refetch()} />
            ) : null}
            {items.data && mine.length === 0 ? (
              <p className="muted">
                You have asked for no work yet. <Link to="/ask">Ask the factory</Link> what to ask
                for.
              </p>
            ) : null}
            {mine.length > 0 ? <ItemLines rows={mine.slice(0, 8)} label="Your requests" /> : null}
          </Card>

          {fleetAudit ? <Glance projects={projects.data} items={items.data?.items} /> : null}
        </div>

        <div className="pg-col" aria-label="Your projects" role="region">
          <div className="ui-eyebrow">Your projects</div>
          {projects.isPending ? <Loading what="your projects" /> : null}
          {projects.isError ? (
            <ErrorNote error={projects.error} retry={() => void projects.refetch()} />
          ) : null}
          {projects.data && projects.data.length === 0 ? (
            <p className="muted">No project is visible to you yet.</p>
          ) : null}
          {(projects.data ?? []).map((p) => (
            <ProjectCard key={p.project.project_id} p={p} items={items.data?.items ?? []} />
          ))}
        </div>
      </div>
    </>
  );
}

const roleName = (r: RoleId): string => {
  const d = roleDef(r);
  return d ? (d.description.split(':')[0] ?? r) : r;
};

export function ItemLines({ rows, label }: { rows: readonly ItemListRow[]; label: string }) {
  return (
    <ul className="pg-list" aria-label={label}>
      {rows.map((i) => (
        <li key={i.item_id}>
          <Link to={`/items/${i.item_id}`} aria-label={`item ${itemKey(i.item_id)}`}>
            <Chip itemKey={itemKey(i.item_id)} lane={i.lane ?? i.proposed_lane} />
          </Link>
          <span>{phaseText(i)}</span>
          <span className="muted">{i.project_id}</span>
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ p, items }: { p: ProjectSummary; items: readonly ItemListRow[] }) {
  const id = p.project.project_id;
  const live = items.filter((i) => i.project_id === id && i.terminal === null);
  return (
    <Card
      title={<Link to={`/projects/${id}`}>{p.project.name}</Link>}
      actions={<Pill tone="info">{levelTitle(p.project.level)}</Pill>}
      testId={`home-project-${id}`}
    >
      <p className="ui-mono muted">{p.repos.map((r) => r.repo_ref).join(', ') || 'no repo yet'}</p>
      <Stats label={`${id} at a glance`}>
        <Stat label="in flight" value={live.filter((i) => i.in_flight).length} />
        <Stat label="held" value={live.filter((i) => i.holds > 0).length} />
        <Stat label="open items" value={live.length} />
      </Stats>
    </Card>
  );
}

/** For whoever reads the factory's audit views: a few numbers from what this page already loaded. */
function Glance({
  projects,
  items,
}: {
  projects: readonly ProjectSummary[] | undefined;
  items: readonly ItemListRow[] | undefined;
}) {
  const live = (items ?? []).filter((i) => i.terminal === null);
  return (
    <Card
      title="Factory at a glance"
      actions={
        <span>
          <Link to="/health">Health</Link> · <Link to="/kill">Kill switch</Link>
        </span>
      }
      testId="home-glance"
    >
      <Stats label="Factory at a glance">
        <Stat label="Projects" value={projects?.length ?? '–'} />
        <Stat label="Items open" value={items ? live.length : '–'} />
        <Stat
          label="Held"
          value={items ? live.filter((i) => i.holds > 0).length : '–'}
          detail="H1–H3, WIP, kill, control"
          {...(live.some((i) => i.holds > 0) ? { tone: 'warn' as const } : {})}
        />
        <Stat label="In a session" value={items ? live.filter((i) => i.in_flight).length : '–'} />
      </Stats>
    </Card>
  );
}
