import { useQuery } from '@tanstack/react-query';
import {
  ACTION_CATALOGUE,
  ACTION_IDS,
  ROLE_CATALOGUE,
  label,
  lookupTerm,
  roleGrants,
  type ActionDef,
  type ActionId,
  type ExplainHolder,
  type GrantRule,
  type RoleDef,
} from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { ApiError, api, type Me } from '../api';
import { Loading } from '../components/Notice';
import { Link } from '../router';
import { Card, EmptyState, PageHeader, Pill, Table, Term, WireTerm, type Column } from '../ui';
import { ReadError, personPath } from './People';
import {
  PeopleNav,
  RoleName,
  canExplainSomewhere,
  roleLabel,
  scopeLabel,
  useProjectIds,
} from './shared';

// Roles (screen map §2.13 Roles): each role in plain words, where it applies, what it sees and every action it
// may take, read from the roles setting (`access.roles`: the role catalogue and per-action grants, which the policy
// is generated from). Changing roles is a settings change (Settings › Roles and permissions): proposed, previewed
// and approved by another factory admin, or applied alone by a factory admin with a reason.
//
// Who can do what (screen map §2.13): pick a project and an action; the policy (PDP) is asked now, for everyone a
// role reaches on the project, which of them may do it and through which roles.

const ROLES_KEY = 'access.roles';
const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

interface RolesSetting {
  readonly roles: readonly RoleDef[];
  readonly grants: Partial<Record<ActionId, readonly GrantRule[]>>;
}

/** The action catalogue with the setting's grants in place (the same reading as the policy generator's). */
function actionsWith(grants: RolesSetting['grants']): Record<string, ActionDef> {
  const base = ACTION_CATALOGUE as unknown as Record<string, ActionDef>;
  return Object.fromEntries(
    Object.entries(base).map(([id, a]) => {
      const g = grants[id as ActionId];
      return [id, g ? { ...a, grants: [...g] } : a];
    }),
  );
}

const asSetting = (v: unknown): RolesSetting | null => {
  const x = v as Partial<RolesSetting> | null;
  return x && Array.isArray(x.roles) ? { roles: x.roles, grants: x.grants ?? {} } : null;
};

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  fleet: label('concept', 'role_scope_fleet'),
  project: 'A project',
  team: 'A team',
  lane: 'A track',
};

function ActionChips({ actions }: { actions: readonly ActionId[] }) {
  if (actions.length === 0) return <span className="adm-muted">Nothing</span>;
  return (
    <ul className="adm-chips">
      {actions.map((a) => (
        <li key={a} className="adm-chip">
          <WireTerm family="action" value={a} />
        </li>
      ))}
    </ul>
  );
}

export function RolesPage({ me }: { me: Me }) {
  const q = useQuery({
    queryKey: ['config-key', ROLES_KEY],
    queryFn: () => api.configKey(ROLES_KEY),
    retry: false,
  });
  // a person who may not read settings still sees the roles: the built-in catalogue, said as such
  const setting = (q.data ? asSetting(q.data.effective.value) : null) ?? {
    roles: ROLE_CATALOGUE,
    grants: {},
  };
  const fromSetting = q.isSuccess && asSetting(q.data.effective.value) !== null;
  const actions = actionsWith(setting.grants);
  const roles = setting.roles.filter((r) => !r.service_only);
  const cols: ReadonlyArray<Column<RoleDef>> = [
    {
      key: 'r',
      header: label('concept', 'role'),
      rowHeader: true,
      render: (r) => (
        <>
          <RoleName id={r.role_id} def={r} />
          {lookupTerm('role', r.role_id) ? null : (
            <>
              {' '}
              <Pill tone="info">Custom</Pill>
            </>
          )}
          <div className="adm-muted" style={{ fontWeight: 400, fontSize: 13 }}>
            {lookupTerm('role', r.role_id)?.explain ?? r.description}
          </div>
        </>
      ),
    },
    {
      key: 'w',
      header: 'Given on',
      render: (r) => r.scope_kinds.map((k) => SCOPE_WORDS[k] ?? k).join(', '),
    },
    {
      key: 's',
      header: 'Sees',
      render: (r) => (
        <>
          <Term family="viewLevel" value={r.view_level} />
          {' · '}
          <Term family="dataClass" value={r.data_class_default} />
        </>
      ),
    },
    {
      key: 'a',
      header: 'May do',
      render: (r) => (
        <>
          <ActionChips actions={roleGrants(r, actions as never).map((g) => g.action)} />
          {r.approval_capable ? (
            <p className="ui-help">Decides the approvals of its part of a project.</p>
          ) : null}
        </>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={label('screen', 'roles')}
        crumbs={[{ label: label('screen', 'people_roles') }]}
        meta={
          fromSetting
            ? `${roles.length} roles, from the setting “${label('configKey', 'access.roles')}”.`
            : `${roles.length} built-in roles.`
        }
        renderLink={renderLink}
        actions={
          q.data?.may_propose ? (
            <Link to={`/config/${ROLES_KEY}`} className="ui-btn ui-btn-primary">
              Change roles
            </Link>
          ) : undefined
        }
      />
      <PeopleNav me={me} />
      {q.isPending ? <Loading what="the roles" /> : null}
      {q.data?.may_propose ? (
        <p className="ui-help" style={{ margin: '0 0 12px' }}>
          Adding, editing or removing a role is a settings change: you see its effect before it is
          saved, and another factory admin approves it (or you apply it alone as factory admin, with
          a reason). Built-in roles cannot be removed.
        </p>
      ) : null}
      {q.isPending ? null : (
        <Card flush>
          <Table
            caption="Roles"
            captionHidden
            columns={cols}
            rows={roles}
            rowKey={(r) => r.role_id}
            empty={<EmptyState title="No roles">The roles setting lists none.</EmptyState>}
          />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- who can do what

const PROJECT_ACTIONS = ACTION_IDS.filter((a) =>
  (ACTION_CATALOGUE[a].resource_types as readonly string[]).includes('Project'),
);

export function WhoCanPage({ me }: { me: Me }) {
  const id = useId();
  const projects = useProjectIds(me, 'access.explain');
  const [pick, setPick] = useState('');
  const [action, setAction] = useState<ActionId>('gate.decide');
  const project = pick || projects[0] || '';
  const q = useQuery({
    queryKey: ['explain', project],
    queryFn: () => api.explain(project),
    enabled: project !== '',
  });
  const holders = (q.data?.holders ?? []).filter((h) => h.actions.includes(action));
  const cols: ReadonlyArray<Column<ExplainHolder>> = [
    {
      key: 'p',
      header: label('concept', 'person'),
      rowHeader: true,
      render: (h) => <Link to={personPath(h.principal_id)}>{h.display_name}</Link>,
    },
    {
      key: 'r',
      header: 'Through',
      render: (h) => h.roles.map((r) => roleLabel(r)).join(', '),
    },
    { key: 's', header: 'Where', render: (h) => h.scopes.map(scopeLabel).join(', ') },
    {
      key: 'v',
      header: 'Sees',
      render: (h) =>
        h.view_level ? (
          <Term family="viewLevel" value={h.view_level} />
        ) : (
          <span className="adm-muted">Nothing</span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={label('screen', 'who_can')}
        crumbs={[{ label: label('screen', 'people_roles') }]}
        meta="Pick a project and what someone would do: the policy is asked now, for everyone a role reaches there."
        renderLink={renderLink}
      />
      <PeopleNav me={me} />
      {!canExplainSomewhere(me) ? (
        <ReadError error={new ApiError(403, 'forbidden', 'denied')} />
      ) : (
        <>
          <div className="adm-tools">
            <label htmlFor={`${id}-p`}>
              <span className="ui-label">{label('concept', 'project')}</span>
              <select
                id={`${id}-p`}
                className="ui-select"
                value={project}
                onChange={(e) => setPick(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-a`}>
              <span className="ui-label">Who can…</span>
              <select
                id={`${id}-a`}
                className="ui-select"
                value={action}
                onChange={(e) => setAction(e.target.value as ActionId)}
              >
                {PROJECT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {lookupTerm('action', a)?.label ?? ACTION_CATALOGUE[a].description}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {project === '' ? (
            <EmptyState title="No project to ask about">
              Onboard a repo first, or ask for a role that sees who can do what on a project.
            </EmptyState>
          ) : q.isPending ? (
            <Loading what="who can do what" />
          ) : q.isError ? (
            <ReadError error={q.error} retry={() => void q.refetch()} />
          ) : (
            <Card
              title={`${holders.length} ${holders.length === 1 ? 'person' : 'people'} can “${lookupTerm('action', action)?.label ?? action}” on ${project}`}
              flush
            >
              <Table
                caption={`Who can ${lookupTerm('action', action)?.label ?? action} on ${project}`}
                captionHidden
                columns={cols}
                rows={holders}
                rowKey={(h) => h.principal_id}
                empty={
                  <EmptyState title="Nobody can">
                    No role in force on {project} allows this. A factory admin can still act, with a
                    reason that is recorded.
                  </EmptyState>
                }
              />
            </Card>
          )}
        </>
      )}
    </>
  );
}
