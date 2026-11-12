import { useState } from 'react';
import {
  ACTION_CATALOGUE,
  ActionId,
  GateId,
  ROLE_CATALOGUE,
  pdpResource,
  roleDef,
  type MyBinding,
  type MyProjectAccess,
  type PdpResource,
  type Scope,
} from '@aisdlc/contracts';
import { reasonText, rolesThatGrant, useAccess, useCan, useMe } from '../access';
import { AccessRequestForm, GrantsList } from './AccessPages';
import { Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, GateTag, PageHead, Pill, Stat, Stats, Table } from '../ui';

// My access (portal-coverage §2 `my-access`): every role binding the person reaches, where it
// applies and where it comes from, the view level and data class per project, and a small matrix
// of what the PDP allows per project. It shows what the server says; asking for a role (P1-6) is a proposal that
// someone at the scope's admin slot decides.

/** The actions the matrix asks about on each project (all of them apply to a Project resource). */
const PROBES: readonly ActionId[] = [
  'project.view',
  'work.request',
  'project.settings.edit',
  'config.propose',
  'audit.read',
  'access.explain',
  // PLAN §7a (2026-11-12)
  'access.manage',
  'ops.read',
  'quality.read',
  'session.stop',
  'assistant.use',
];

const scopeText = (s: Scope): string =>
  s.kind === 'fleet' ? 'whole factory' : `${s.kind} ${s.ref}`;

function Cell({ action, resource }: { action: ActionId; resource: PdpResource }) {
  const can = useCan(action, resource);
  if (can.state === 'pending') return <span className="muted">…</span>;
  if (can.state === 'allow') {
    return (
      <span data-can="allow" title={can.reasons.join(', ')}>
        <span aria-hidden="true">✓</span>
        <span className="ui-sr">allowed</span>
      </span>
    );
  }
  return (
    <span data-can="deny" title={reasonText(action, can.reasons)} className="muted">
      <span aria-hidden="true">·</span>
      <span className="ui-sr">not allowed: {reasonText(action, can.reasons)}</span>
    </span>
  );
}

/** "Request access" lands here with `?want=<action>&project=<id>[&gate=<id>]`. */
function RequestPanel() {
  const me = useMe();
  const qs = new URLSearchParams(window.location.search);
  const want = ActionId.safeParse(qs.get('want'));
  if (!want.success) return null;
  const project = qs.get('project');
  const gate = GateId.safeParse(qs.get('gate'));
  const resource =
    project === null
      ? pdpResource.fleet()
      : gate.success
        ? pdpResource.gate(project, 'any', gate.data)
        : pdpResource.project(project);
  const roles = rolesThatGrant(want.data, resource);
  return (
    <Card title="Asking for access" testId="request-access">
      <p>
        You asked for: <strong>{ACTION_CATALOGUE[want.data].description}</strong>{' '}
        <span className="ui-mono">({want.data})</span>
        {project !== null ? (
          <>
            {' '}
            on <span className="ui-mono">{project}</span>
          </>
        ) : null}
        {gate.success ? (
          <>
            {' '}
            for <GateTag gate={gate.data} />
          </>
        ) : null}
        .
      </p>
      {roles.length === 0 ? (
        <p>No role of the catalogue holds this action here.</p>
      ) : (
        <>
          <p>These roles hold it:</p>
          <ul aria-label="Roles that grant it">
            {roles.map((r) => (
              <li key={r}>
                <span className="ui-mono">{r}</span>: {roleDef(r)?.description}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">
        A role of a project&rsquo;s role map (a gate-deciding slot) is given in its Project
        settings: ask the project&rsquo;s admin. The roles beyond it you can ask for here; someone
        at the scope&rsquo;s admin slot decides, never you.
      </p>
      <AccessRequestForm me={me} project={project} roles={roles} />
    </Card>
  );
}

/** Ask for a role from scratch (no locked button led here): on the whole factory, or a project you name. */
function AskForRole() {
  const me = useMe();
  const [project, setProject] = useState('');
  return (
    <>
      <label className="pg-form">
        Project (empty for the whole factory){' '}
        <input value={project} onChange={(e) => setProject(e.target.value.trim())} />
      </label>
      <AccessRequestForm
        key={project}
        me={me}
        project={project === '' ? null : project}
        roles={[]}
      />
    </>
  );
}

export function MyAccessPage() {
  const q = useAccess();
  if (q.isPending) return <Loading what="your access" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const inForce = v.bindings.filter((b) => b.blockers.length === 0);
  return (
    <>
      <PageHead
        eyebrow="Account"
        title="My access"
        sub="Every role you hold, where it applies and where it comes from, and what the policy lets you do. The server decides every action again when you take it."
      />
      <RequestPanel />
      <Stats label="Your access at a glance">
        <Stat label="Bindings in force" value={inForce.length} detail={`of ${v.bindings.length}`} />
        <Stat label="Projects with a role" value={v.projects.length} />
        <Stat
          label="Factory-wide"
          value={v.fleet.view_level ?? 'none'}
          detail={v.fleet.roles.length > 0 ? v.fleet.roles.join(', ') : 'no fleet role'}
        />
      </Stats>
      <Card title="Role bindings" flush>
        <Table<MyBinding>
          caption="Role bindings"
          captionHidden
          rowKey={(b) => `${b.binding_id}:${b.group_id}`}
          rows={v.bindings}
          empty={
            <EmptyState title="No roles yet">
              Ask a project admin for a role. Until then you see no project.
            </EmptyState>
          }
          columns={[
            {
              key: 'role',
              header: 'Role',
              rowHeader: true,
              render: (b) => (
                <>
                  <span className="ui-mono">{b.role_id}</span>
                  <div className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    {roleDef(b.role_id)?.description ?? 'not in the role catalogue'}
                  </div>
                </>
              ),
            },
            { key: 'scope', header: 'Scope', render: (b) => scopeText(b.scope) },
            {
              key: 'level',
              header: 'View · data',
              render: (b) => {
                const d = roleDef(b.role_id);
                return d ? (
                  <span className="ui-mono">
                    {d.view_level} · {d.data_class_default}
                  </span>
                ) : (
                  '—'
                );
              },
            },
            {
              key: 'source',
              header: 'Source',
              render: (b) => (
                <>
                  {b.group_display}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.source}
                  </div>
                </>
              ),
            },
            {
              key: 'expiry',
              header: 'Ends',
              render: (b) => (b.expiry ? shortTime(b.expiry) : 'no end date'),
            },
            {
              key: 'state',
              header: 'State',
              render: (b) =>
                b.blockers.length === 0 ? (
                  <Pill tone="ok">in force</Pill>
                ) : (
                  <Pill tone="warn">{`not in force: ${b.blockers.join(', ')}`}</Pill>
                ),
            },
          ]}
        />
      </Card>
      <Card title="Ask for a role" testId="ask-role">
        <AskForRole />
      </Card>
      <GrantsList only={(g) => g.proposed_by === v.principal.principal_id || g.may_decide} />
      <Card title="Per project" flush>
        <Table<MyProjectAccess>
          caption="View level, data class and what you may do per project"
          captionHidden
          rowKey={(p) => p.project_id}
          rows={v.projects}
          empty={<EmptyState title="No project">You hold no role on a project.</EmptyState>}
          columns={[
            {
              key: 'project',
              header: 'Project',
              rowHeader: true,
              render: (p) => (
                <Link to={`/projects/${encodeURIComponent(p.project_id)}`}>{p.project_id}</Link>
              ),
            },
            { key: 'view', header: 'View', render: (p) => p.view_level },
            { key: 'data', header: 'Data', render: (p) => p.data_class },
            { key: 'roles', header: 'Roles', render: (p) => p.roles.join(', ') },
            ...PROBES.map((a) => ({
              key: a,
              header: <span title={ACTION_CATALOGUE[a].description}>{a}</span>,
              render: (p: MyProjectAccess) => (
                <Cell action={a} resource={pdpResource.project(p.project_id)} />
              ),
            })),
          ]}
        />
      </Card>
      <Card title="How access works">
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            A role binding gives you a role at a scope: one project, a team, or the whole factory.
          </li>
          <li>
            Each role has a view level (V1 positions, V2 content, V3 audit and settings) and a data
            class (D0 to D2) that caps what text you see. The catalogue has {ROLE_CATALOGUE.length}{' '}
            roles (version {v.roles_version}).
          </li>
          <li>
            Gates are decided by one slot each; an admin decides no gate unless given the slot.
          </li>
          <li>
            On top of the roles: you never decide your own request, some gates need two people, and
            sensitive decisions need a step-up.
          </li>
        </ul>
      </Card>
    </>
  );
}
