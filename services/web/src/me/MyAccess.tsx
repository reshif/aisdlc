import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionId,
  FLEET_REF,
  GRANTABLE_ROLES,
  GateId,
  label,
  lookupTerm,
  pdpResource,
  roleDef,
  type GrantScope,
  type MyBinding,
  type MyProjectAccess,
} from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { rolesThatGrant, useAccess, useMe } from '../access';
import { errorText } from '../admin';
import { api, type AccessGrantWire } from '../api';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { requestPath } from '../people/AccessRequests';
import { GrantStatusPill, RoleName, roleLabel, scopeLabel } from '../people/shared';
import { Link } from '../router';
import { Card, EmptyState, PageHeader, Pill, Table, Term, WireTerm } from '../ui';

// My access (screen map §1.3): what I can do and why. My roles (in force or not, and why not), per project what I
// see and may do, my access requests, and asking for a role (someone at the scope's admin role answers, never me).
// A locked button anywhere links here with `?want=<action>&project=<id>[&gate=<id>]`: the roles that would grant
// it are named and the request form starts with the first of them.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

const BLOCKER_WORDS: Readonly<Record<string, string>> = {
  binding_expired: 'the role ended',
  membership_expired: 'your place in the group ended',
  membership_not_started: 'your place in the group has not started',
  service_only_role: 'a role for services only',
  unknown_role: 'a role the factory does not know',
};

function Ask({ project: given, roles }: { project: string | null; roles: readonly string[] }) {
  const me = useMe();
  const id = useId();
  const qc = useQueryClient();
  const [project, setProject] = useState(given ?? '');
  const p = project.trim() === '' ? null : project.trim();
  const grantable = GRANTABLE_ROLES.filter((r) =>
    r.scope_kinds.some((k) => k === 'fleet' || (k === 'project' && p !== null)),
  );
  const [role, setRole] = useState(
    (grantable.find((r) => roles.includes(r.role_id)) ?? grantable[0])?.role_id ?? '',
  );
  const def = grantable.find((r) => r.role_id === role) ?? grantable[0];
  const scope: GrantScope | null =
    def?.scope_kinds.includes('project') && p !== null
      ? { kind: 'project', ref: p as never }
      : def?.scope_kinds.includes('fleet')
        ? { kind: 'fleet', ref: FLEET_REF }
        : null;
  const [why, setWhy] = useState('');
  const send = useMutation({
    mutationFn: () => {
      if (!scope || !def) throw new Error('That role is not asked for there.');
      return api.requestAccess(
        { role_id: def.role_id, scope, expiry: null, reason: why.trim() },
        me.csrf_token,
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['access-grants'] }),
  });
  return (
    <form
      className="adm-form"
      aria-label="Ask for a role"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <div className="adm-form-row">
        <div>
          <label className="ui-label" htmlFor={`${id}-p`}>
            {label('concept', 'project')} (leave empty for the whole factory)
          </label>
          <input
            id={`${id}-p`}
            className="ui-input"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </div>
        <div>
          <label className="ui-label" htmlFor={`${id}-r`}>
            {label('concept', 'role')}
          </label>
          <select
            id={`${id}-r`}
            className="ui-select"
            value={def?.role_id ?? ''}
            onChange={(e) => setRole(e.target.value)}
          >
            {grantable.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {roleLabel(r.role_id, r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-w`}>
          Why
        </label>
        <textarea
          id={`${id}-w`}
          className="ui-input"
          value={why}
          maxLength={2000}
          onChange={(e) => setWhy(e.target.value)}
        />
      </div>
      <p className="ui-help">
        On {scope ? scopeLabel(scope) : 'no place this role is given'}. A role that decides a
        project’s approvals is given in that project’s settings: ask its admin.
      </p>
      <div className="adm-acts">
        <button
          type="submit"
          className="ui-btn ui-btn-primary"
          disabled={send.isPending || why.trim() === '' || !scope}
        >
          Ask for it
        </button>
      </div>
      {send.isError && errorText(send.error) ? (
        <p className="ui-help ui-help-bad" role="alert">
          {errorText(send.error)}
        </p>
      ) : null}
      {send.isSuccess ? (
        <p className="adm-status" role="status">
          Asked.{' '}
          {send.data.deciders.length === 0
            ? 'Nobody can answer it yet.'
            : `${send.data.deciders.join(', ')} can answer it.`}{' '}
          <Link to={requestPath(send.data.grant_id)}>Follow it</Link>
        </p>
      ) : null}
    </form>
  );
}

/** Came from a locked button: what was asked for and which roles hold it. */
function Wanted() {
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
        You asked to{' '}
        <strong>
          <WireTerm family="action" value={want.data} />
        </strong>
        {project !== null ? <> on {project}</> : null}
        {gate.success ? (
          <>
            {' '}
            for <WireTerm family="gate" value={gate.data} />
          </>
        ) : null}
        .
      </p>
      {roles.length === 0 ? (
        <p>No role gives this here.</p>
      ) : (
        <>
          <p>These roles give it:</p>
          <ul className="adm-chips" aria-label="Roles that grant it">
            {roles.map((r) => (
              <li key={r} className="adm-chip">
                <RoleName id={r} def={roleDef(r)} />
              </li>
            ))}
          </ul>
        </>
      )}
      <Ask project={project} roles={roles} />
    </Card>
  );
}

export function MyAccessPage() {
  const me = useMe();
  const q = useAccess();
  const grants = useQuery({ queryKey: ['access-grants'], queryFn: api.accessGrants });
  if (q.isPending) return <Loading what="your access" />;
  if (q.isError)
    return (
      <p className="adm-note" role="alert">
        {errorText(q.error)}
      </p>
    );
  const v = q.data;
  const mine = (grants.data?.grants ?? []).filter(
    (g) => g.proposed_by === v.principal.principal_id,
  );
  const wanted = new URLSearchParams(window.location.search).has('want');
  return (
    <>
      <PageHeader
        title={label('screen', 'my_access')}
        meta="Every role you hold, where it applies and where it comes from. The server decides every action again when you take it."
        renderLink={renderLink}
      />
      <div className="adm-stack">
        <Wanted />
        <Card title={`My roles (${v.bindings.length})`} flush>
          <Table<MyBinding>
            caption="My roles"
            captionHidden
            rowKey={(b) => `${b.binding_id}:${b.group_id}`}
            rows={v.bindings}
            empty={
              <EmptyState title="No roles yet">
                Ask for a role below. Until then you see no project.
              </EmptyState>
            }
            columns={[
              {
                key: 'r',
                header: label('concept', 'role'),
                rowHeader: true,
                render: (b) => <RoleName id={b.role_id} def={roleDef(b.role_id)} />,
              },
              { key: 'w', header: 'Where', render: (b) => scopeLabel(b.scope) },
              { key: 't', header: 'Through', render: (b) => b.group_display },
              {
                key: 'u',
                header: 'Until',
                render: (b) => (b.expiry ? shortTime(b.expiry) : 'No end'),
              },
              {
                key: 's',
                header: 'In force',
                render: (b) =>
                  b.blockers.length === 0 ? (
                    <Pill tone="ok">Yes</Pill>
                  ) : (
                    <Pill tone="warn">{`No: ${b.blockers.map((x) => BLOCKER_WORDS[x] ?? 'not in force').join(', ')}`}</Pill>
                  ),
              },
            ]}
          />
        </Card>
        <Card title="Per project" flush>
          <Table<MyProjectAccess>
            caption="What you see and may do per project"
            captionHidden
            rowKey={(p) => p.project_id}
            rows={v.projects}
            empty={<EmptyState title="No project">You hold no role on a project.</EmptyState>}
            columns={[
              {
                key: 'p',
                header: label('concept', 'project'),
                rowHeader: true,
                render: (p) => (
                  <Link to={`/projects/${encodeURIComponent(p.project_id)}`}>{p.project_id}</Link>
                ),
              },
              {
                key: 's',
                header: 'Sees',
                render: (p) => (
                  <>
                    <Term family="viewLevel" value={p.view_level} /> ·{' '}
                    <Term family="dataClass" value={p.data_class} />
                  </>
                ),
              },
              {
                key: 'r',
                header: 'Roles',
                render: (p) => p.roles.map((r) => roleLabel(r)).join(', '),
              },
              {
                key: 'a',
                header: 'May do',
                render: (p) => (
                  <span className="adm-muted">
                    {p.actions
                      .map((a) => lookupTerm('action', a)?.label)
                      .filter((x): x is string => !!x)
                      .join(', ') || 'Nothing'}
                  </span>
                ),
              },
            ]}
          />
        </Card>
        <Card title="My access requests" flush>
          <Table<AccessGrantWire>
            caption="My access requests"
            captionHidden
            rowKey={(g) => g.grant_id}
            rows={mine}
            empty={
              <EmptyState title="No requests">
                Requests you make show here with their answer.
              </EmptyState>
            }
            columns={[
              {
                key: 'r',
                header: label('concept', 'role'),
                rowHeader: true,
                render: (g) => (
                  <Link to={requestPath(g.grant_id)}>
                    {roleLabel(g.change.role_id, roleDef(g.change.role_id))}
                  </Link>
                ),
              },
              { key: 'w', header: 'Where', render: (g) => scopeLabel(g.change.scope) },
              { key: 't', header: 'When', render: (g) => shortTime(g.proposed_at) },
              { key: 's', header: 'Status', render: (g) => <GrantStatusPill status={g.status} /> },
            ]}
          />
        </Card>
        {wanted ? null : (
          <section id="ask">
            <Card title="Ask for a role">
              <Ask key={me.principal.principal_id} project={null} roles={[]} />
            </Card>
          </section>
        )}
      </div>
    </>
  );
}
