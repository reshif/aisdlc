import { useQuery } from '@tanstack/react-query';
import {
  ROLE_CATALOGUE,
  ROLES_VERSION,
  roleGrants,
  type ExplainHolder,
  type PrincipalSummary,
  type RoleDef,
  type Team,
} from '@aisdlc/contracts';
import { useState } from 'react';
import { api, type Me } from '../api';
import { NotBuilt, Read } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, PageHead, Pill, Table, type Column } from '../ui';

// Admin (prototype `people`, `teams`, `roles`, `access-requests`, `access-explain`). Read-only here:
// bindings change through the role map (card 4, an M1 revision) and the identity service, never from a
// table cell. People and teams read the directory (`audit.read` on the fleet); the role catalogue is
// contracts data everyone may read; "who can do what" asks the PDP for each holder (`access.explain`).

const PEOPLE_COLS: ReadonlyArray<Column<PrincipalSummary>> = [
  { key: 'n', header: 'Name', rowHeader: true, render: (p) => p.display_name },
  { key: 'h', header: 'Handle', render: (p) => <code>{p.display_handle}</code> },
  { key: 'k', header: 'Kind', render: (p) => p.kind },
  {
    key: 's',
    header: 'Status',
    render: (p) => <Pill tone={p.status === 'active' ? 'ok' : 'mute'}>{p.status}</Pill>,
  },
];

export function PeoplePage() {
  const q = useQuery({ queryKey: ['directory'], queryFn: api.directory });
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="People"
        sub="Everyone the directory knows, from the identity journal. Who holds which role on a project is on Who can do what; bindings change through the role map and its M1 gate."
        actions={
          <Link to="/access-explain" className="ui-btn">
            Who can do what
          </Link>
        }
      />
      <Read q={q} what="the directory">
        {(v) => (
          <Card title={`${v.principals.length} active principals`} flush>
            <Table
              caption="People"
              captionHidden
              columns={PEOPLE_COLS}
              rows={v.principals}
              rowKey={(p) => p.principal_id}
              empty={
                <EmptyState title="Nobody yet">The directory has no active principal.</EmptyState>
              }
            />
          </Card>
        )}
      </Read>
      <NotBuilt title="Suspend, erase, legal hold" milestone="M19">
        Erasure and legal hold are on Govern › Audit under <code>identity.admin</code>; suspending a
        person and the sign-in settings have no backend route yet, and role bindings change through
        the role map (<code>access.manage</code> has no route either). The portal reads only here.
      </NotBuilt>
    </>
  );
}

const TEAM_COLS: ReadonlyArray<Column<Team>> = [
  { key: 'n', header: 'Team', rowHeader: true, render: (t) => t.name },
  { key: 'id', header: 'Id', render: (t) => <code>{t.team_id}</code> },
  { key: 'c', header: 'Classification', render: (t) => t.classification },
  {
    key: 'g',
    header: 'IdP group',
    render: (t) => (t.idp_group ? <code>{t.idp_group}</code> : 'none'),
  },
];

export function TeamsPage() {
  const q = useQuery({ queryKey: ['directory'], queryFn: api.directory });
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="Teams"
        sub="Teams are owned by the factory, each with an optional mapping to an IdP group (DM §9 Q1). An onboarder may be scoped to a team."
      />
      <Read q={q} what="the teams">
        {(v) => (
          <Card title={`${v.teams.length} teams`} flush>
            <Table
              caption="Teams"
              captionHidden
              columns={TEAM_COLS}
              rows={v.teams}
              rowKey={(t) => t.team_id}
              empty={
                <EmptyState title="No team yet">
                  Projects can still be onboarded at fleet level.
                </EmptyState>
              }
            />
          </Card>
        )}
      </Read>
    </>
  );
}

const ROLE_COLS: ReadonlyArray<Column<RoleDef>> = [
  {
    key: 'r',
    header: 'Role',
    rowHeader: true,
    render: (r) => (
      <>
        <code>{r.role_id}</code>
        <div className="muted">{r.description}</div>
      </>
    ),
  },
  { key: 's', header: 'Slot', render: (r) => r.slot ?? '–' },
  { key: 'scope', header: 'Bound at', render: (r) => r.scope_kinds.join(', ') },
  { key: 'v', header: 'View', render: (r) => <Pill plain>{r.view_level}</Pill> },
  { key: 'd', header: 'Data class', render: (r) => <Pill plain>{r.data_class_default}</Pill> },
  {
    key: 'f',
    header: 'Flags',
    render: (r) => (
      <>
        {r.approval_capable ? <Pill tone="gate">approves</Pill> : null}
        {r.privileged ? <Pill tone="warn">privileged</Pill> : null}
        {r.service_only ? <Pill tone="mute">service only</Pill> : null}
        {r.requires_qualification ? (
          <Pill tone="info">needs {r.requires_qualification}</Pill>
        ) : null}
      </>
    ),
  },
  {
    key: 'a',
    header: 'Actions it grants',
    render: (r) => (
      <ul className="pg-chips">
        {roleGrants(r).map((g) => (
          <li key={g.action}>
            <code>{g.action}</code>
            {g.gate_slot ? <span className="muted"> (its gates)</span> : null}
          </li>
        ))}
      </ul>
    ),
  },
];

export function RolesPage() {
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="Roles"
        sub={`The role catalogue (version ${ROLES_VERSION}) as data: the PDP's policies are generated from this list and nothing else. A change is a contracts change and a new policy bundle, never an edit here.`}
      />
      <Card title={`${ROLE_CATALOGUE.length} roles`} flush>
        <Table
          caption="Roles"
          captionHidden
          columns={ROLE_COLS}
          rows={ROLE_CATALOGUE}
          rowKey={(r) => r.role_id}
        />
      </Card>
    </>
  );
}

export function AccessRequestsPage() {
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="Access requests"
        sub="Asking for a role, and the decision on it by whoever administers the project."
      />
      <NotBuilt title="Access requests" milestone="no milestone yet">
        There is no access-request API yet: nothing records a request or its decision, so this page
        has nothing true to show. Until it exists, <Link to="/me/access">My access</Link> names the
        roles that would grant an action and who to ask; the project administrator changes the role
        map (card 4, M1).
      </NotBuilt>
    </>
  );
}

const EXPLAIN_COLS: ReadonlyArray<Column<ExplainHolder>> = [
  { key: 'p', header: 'Person', rowHeader: true, render: (h) => h.display_name },
  { key: 'r', header: 'Roles', render: (h) => h.roles.map((r) => <code key={r}>{r} </code>) },
  {
    key: 's',
    header: 'Through',
    render: (h) =>
      h.scopes.map((s) => (s.kind === 'fleet' ? 'fleet' : `${s.kind} ${s.ref}`)).join(', '),
  },
  {
    key: 'l',
    header: 'Sees',
    render: (h) => `${h.view_level ?? '–'} · ${h.data_class ?? '–'}`,
  },
  {
    key: 'a',
    header: 'The PDP allows on the project',
    render: (h) =>
      h.actions.length === 0 ? (
        <span className="muted">nothing</span>
      ) : (
        <ul className="pg-chips">
          {h.actions.map((a) => (
            <li key={a}>
              <code>{a}</code>
            </li>
          ))}
        </ul>
      ),
  },
];

function Explain({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['explain', project], queryFn: () => api.explain(project) });
  return (
    <Read q={q} what="who can do what">
      {(v) => (
        <Card title={`On ${v.project_id}, as of ${shortTime(v.as_of)}`} flush>
          <Table
            caption={`Who can do what on ${v.project_id}`}
            captionHidden
            columns={EXPLAIN_COLS}
            rows={v.holders}
            rowKey={(h) => h.principal_id}
            empty={
              <EmptyState title="Nobody holds a role here">
                No binding in force reaches this project.
              </EmptyState>
            }
          />
        </Card>
      )}
    </Read>
  );
}

export function ExplainPage({ me }: { me: Me }) {
  const fleet = me.actions.fleet.includes('access.explain');
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: fleet });
  const ids = fleet
    ? (projects.data ?? []).map((p) => p.project.project_id)
    : me.actions.projects
        .filter((p) => p.actions.includes('access.explain'))
        .map((p) => p.project_id);
  const [pick, setPick] = useState<string | null>(null);
  const project = pick ?? ids[0] ?? null;
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="Who can do what"
        sub="For one project: everyone a binding in force reaches, through which role and scope, what they see, and every action the policy allows them there. The answer is the PDP's own, asked now."
      />
      {ids.length > 0 ? (
        <div className="pg-filters">
          <label>
            Project{' '}
            <select value={project ?? ''} onChange={(e) => setPick(e.target.value)}>
              {ids.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <EmptyState title="No project to explain">
          {fleet && projects.isPending
            ? 'Loading the projects…'
            : 'access.explain is granted per project.'}
        </EmptyState>
      )}
      {project ? <Explain key={project} project={project} /> : null}
    </>
  );
}
