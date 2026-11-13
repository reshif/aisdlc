import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  label,
  roleDef,
  type PersonBinding,
  type PersonDetailView,
  type PersonRow,
} from '@aisdlc/contracts';
import { useId, useMemo, useState } from 'react';
import { DeleteObject, adminApi, errorText, useOverride } from '../admin';
import { ApiError, type Me } from '../api';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link, useNavigate } from '../router';
import {
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  LockedButton,
  Modal,
  PageHeader,
  PropertiesPanel,
  Table,
  type Column,
} from '../ui';
import { GiveRole } from './GiveRole';
import {
  PeopleNav,
  Person,
  RoleName,
  StatusPill,
  initials,
  peopleRights,
  roleLabel,
  scopeLabel,
  signInLabel,
} from './shared';

// People (screen map §2.13 People; §3 Person): everyone who can sign in, from the identity read model; add, edit,
// suspend or reactivate and delete a person, see and change the roles that reach them. Sign-in accounts themselves
// live in the company identity provider (Keycloak): a person added here signs in once the provider has an account
// for the same email; managing the provider from the portal (N18) is not built.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

export const personPath = (id: string) => `/people/${encodeURIComponent(id)}`;

/** A refusal of a read as the page's state: 403 with the reason, one 404 for missing and invisible. */
export function ReadError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <ErrorState
        status={403}
        reason="Seeing people needs a factory-wide role that reads the record or manages access."
        action={<Link to="/me/access">See my access</Link>}
      />
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return <ErrorState status={404} action={<Link to="/people">Back to people</Link>} />;
  }
  return (
    <div className="adm-note" role="alert">
      {errorText(error)}{' '}
      {retry ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the list

export function PeoplePage({ me }: { me: Me }) {
  const rights = peopleRights(me);
  const q = useQuery({ queryKey: ['people'], queryFn: adminApi.people, enabled: rights.read });
  const teams = useQuery({ queryKey: ['teams'], queryFn: adminApi.teams, enabled: rights.read });
  const [find, setFind] = useState('');
  const [show, setShow] = useState<'all' | 'active' | 'disabled'>('all');
  const [adding, setAdding] = useState(false);
  const teamName = useMemo(
    () => new Map((teams.data?.teams ?? []).map((t) => [t.team_id, t.name])),
    [teams.data],
  );
  const rows = (q.data?.people ?? []).filter(
    (p) =>
      (show === 'all' || p.status === show) &&
      (find === '' ||
        `${p.display_name} ${p.display_handle} ${p.upn ?? ''}`
          .toLowerCase()
          .includes(find.toLowerCase())),
  );
  const cols: ReadonlyArray<Column<PersonRow>> = [
    {
      key: 'n',
      header: 'Name',
      rowHeader: true,
      render: (p) => (
        <Person
          name={p.display_name}
          sub={p.upn ?? p.display_handle}
          to={personPath(p.principal_id)}
        />
      ),
    },
    { key: 's', header: 'Sign-in', render: (p) => signInLabel(p.sign_in) },
    {
      key: 't',
      header: 'Teams',
      render: (p) =>
        p.teams.length === 0 ? (
          <span className="adm-muted">None</span>
        ) : (
          p.teams.map((t) => teamName.get(t) ?? t).join(', ')
        ),
    },
    { key: 'r', header: 'Roles', align: 'right', render: (p) => p.roles },
    { key: 'st', header: 'Status', render: (p) => <StatusPill status={p.status} /> },
  ];
  return (
    <>
      <PageHeader
        title={label('screen', 'people')}
        crumbs={[{ label: label('screen', 'people_roles') }]}
        meta="Everyone who can sign in, their teams and how many roles reach them."
        renderLink={renderLink}
        actions={
          rights.admin ? (
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setAdding(true)}>
              Add person
            </button>
          ) : (
            <LockedButton
              label="Add person"
              reason="Adding people needs the factory admin's sign-in and data rights."
              request={<Link to="/me/access">Ask for access</Link>}
            />
          )
        }
      />
      <PeopleNav me={me} />
      {!rights.read ? (
        <ErrorState
          status={403}
          reason="Seeing people needs a factory-wide role that reads the record or manages access."
          action={<Link to="/me/access">See my access</Link>}
        />
      ) : q.isPending ? (
        <Loading what="the people" />
      ) : q.isError ? (
        <ReadError error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Card flush>
          <div className="adm-tools" style={{ padding: '14px 16px 0' }}>
            <label>
              <span className="ui-label">Find</span>
              <input
                className="ui-input"
                type="search"
                value={find}
                placeholder="Name or email"
                onChange={(e) => setFind(e.target.value)}
              />
            </label>
            <label>
              <span className="ui-label">Show</span>
              <select
                className="ui-select"
                value={show}
                onChange={(e) => setShow(e.target.value as typeof show)}
              >
                <option value="all">Everyone</option>
                <option value="active">{label('concept', 'person_active')}</option>
                <option value="disabled">{label('concept', 'person_suspended')}</option>
              </select>
            </label>
          </div>
          <Table
            caption="People"
            captionHidden
            columns={cols}
            rows={rows}
            rowKey={(p) => p.principal_id}
            empty={
              <EmptyState title={q.data.people.length === 0 ? 'No people yet' : 'Nobody matches'}>
                {q.data.people.length === 0
                  ? 'People appear when they first sign in, or when a factory admin adds them.'
                  : 'Try another name, or show everyone.'}
              </EmptyState>
            }
          />
        </Card>
      )}
      <Drawer open={adding} title="Add person" onClose={() => setAdding(false)}>
        <AddPerson me={me} onDone={() => setAdding(false)} />
      </Drawer>
    </>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');

function AddPerson({ me, onDone }: { me: Me; onDone: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ov = useOverride();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [local, setLocal] = useState(false);
  const h = handle || slug(email || name);
  const add = useMutation({
    mutationFn: () =>
      ov.ifNeeded('Add as factory admin', (reason) =>
        adminApi.createPerson(
          {
            principal_id: h,
            display_name: name.trim(),
            display_handle: h,
            upn: email.trim() || null,
            breakglass: local,
          },
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people'] });
      onDone();
      navigate(personPath(h));
    },
  });
  return (
    <form
      className="adm-form"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div>
        <label className="ui-label" htmlFor={`${id}-n`}>
          Name
        </label>
        <input
          id={`${id}-n`}
          className="ui-input"
          value={name}
          required
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-e`}>
          Company email
        </label>
        <input
          id={`${id}-e`}
          className="ui-input"
          type="email"
          value={email}
          autoComplete="off"
          aria-describedby={`${id}-eh`}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p id={`${id}-eh`} className="ui-help">
          The address they sign in with at the company sign-in.
        </p>
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-h`}>
          Handle
        </label>
        <input
          id={`${id}-h`}
          className="ui-input"
          value={h}
          pattern="[A-Za-z0-9_.@-]+"
          aria-describedby={`${id}-hh`}
          onChange={(e) => setHandle(e.target.value)}
        />
        <p id={`${id}-hh`} className="ui-help">
          Short and unique; shown in mentions and pickers. It cannot change later.
        </p>
      </div>
      <label className="adm-check">
        <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
        {label('concept', 'sign_in_local')} (break-glass, factory admins only)
      </label>
      <p className="ui-help">
        The sign-in account itself is kept in the company identity provider; adding a person here
        gives them a place in the factory and lets you give them roles before they first sign in.
      </p>
      <div className="adm-acts">
        <button
          type="submit"
          className="ui-btn ui-btn-primary"
          disabled={add.isPending || name.trim() === '' || h === ''}
        >
          Add person
        </button>
        <button type="button" className="ui-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      {add.isError && errorText(add.error) ? (
        <p className="ui-help ui-help-bad" role="alert">
          {errorText(add.error)}
        </p>
      ) : null}
      {ov.dialog}
    </form>
  );
}

// ---------------------------------------------------------------- one person

const throughOf = (b: PersonBinding, d: PersonDetailView, teamName: Map<string, string>) => {
  if (b.origin === 'role_map') return `The project's settings`;
  if (b.team_id) return `${label('concept', 'team')} ${teamName.get(b.team_id) ?? b.team_id}`;
  if (b.group_id === `person.${d.person.principal_id}`) return 'Given directly';
  if (b.origin === 'access_grant') return 'An approved access request';
  return d.groups.find((g) => g.group_id === b.group_id)?.display ?? 'A group';
};

export function PersonPage({ id, me }: { id: string; me: Me }) {
  const rights = peopleRights(me);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['people', id],
    queryFn: () => adminApi.person(id),
    enabled: rights.read,
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: adminApi.teams, enabled: rights.read });
  const [editing, setEditing] = useState(false);
  const [suspending, setSuspending] = useState(false);
  if (!rights.read) return <ReadError error={new ApiError(403, 'forbidden', 'denied')} />;
  if (q.isPending) return <Loading what="the person" />;
  if (q.isError) return <ReadError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const p = v.person;
  const teamName = new Map((teams.data?.teams ?? []).map((t) => [t.team_id, t.name]));
  const isMe = p.principal_id === me.principal.principal_id;
  const cols: ReadonlyArray<Column<PersonBinding>> = [
    {
      key: 'r',
      header: label('concept', 'role'),
      rowHeader: true,
      render: (b) => <RoleName id={b.role_id} def={roleDef(b.role_id)} />,
    },
    { key: 'w', header: 'Where', render: (b) => scopeLabel(b.scope) },
    { key: 't', header: 'Through', render: (b) => throughOf(b, v, teamName) },
    {
      key: 'u',
      header: 'Until',
      render: (b) => (b.expiry ? shortTime(b.expiry) : <span className="adm-muted">No end</span>),
    },
    {
      key: 'a',
      header: <span className="ui-sr">Actions</span>,
      render: (b) =>
        b.origin === 'role_map' && b.scope.kind === 'project' ? (
          <Link to={`/projects/${encodeURIComponent(b.scope.ref)}/settings`}>
            Change in project settings
          </Link>
        ) : b.team_id ? (
          <Link to={`/teams/${encodeURIComponent(b.team_id)}`}>Change on the team</Link>
        ) : rights.deleteBinding ? (
          <DeleteObject
            kind="binding"
            id={b.binding_id}
            name={roleLabel2(b)}
            csrf={me.csrf_token}
            small
            onDeleted={() => void q.refetch()}
          />
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={p.display_name}
        icon={initials(p.display_name)}
        crumbs={[{ label: label('screen', 'people'), to: '/people' }, { label: p.display_name }]}
        status={<StatusPill status={p.status} />}
        meta={[p.upn ?? p.display_handle, signInLabel(p.sign_in)].join(' · ')}
        renderLink={renderLink}
      />
      <div className="ui-split">
        <div className="adm-stack">
          <Card title={`Roles (${v.bindings.length})`} flush>
            <Table
              caption={`Roles of ${p.display_name}`}
              captionHidden
              columns={cols}
              rows={v.bindings}
              rowKey={(b) => b.binding_id}
              empty={
                <EmptyState title="No roles yet">
                  {p.display_name} can sign in but sees no project until given a role.
                </EmptyState>
              }
            />
          </Card>
          {rights.manage ? (
            <Card title="Give a role">
              {isMe ? (
                <p className="ui-help">
                  You are giving yourself a role. Only a factory admin may; it is recorded.
                </p>
              ) : null}
              <GiveRole
                me={me}
                who={p.display_name}
                group={(reason) =>
                  adminApi.ensurePersonGroup(p.principal_id, p.display_name, me.csrf_token, reason)
                }
                onDone={() => void q.refetch()}
              />
            </Card>
          ) : null}
          <TeamsOf me={me} v={v} onChange={() => void q.refetch()} />
        </div>
        <PropertiesPanel
          rows={[
            { label: 'Name', value: p.display_name },
            { label: 'Handle', value: <span className="ui-mono">{p.display_handle}</span> },
            { label: 'Company email', value: p.upn ?? <span className="adm-muted">None</span> },
            { label: 'Sign-in', value: signInLabel(p.sign_in) },
            { label: 'Status', value: <StatusPill status={p.status} /> },
            { label: 'Since', value: shortTime(p.status_changed_at) },
          ]}
          actions={
            rights.admin || rights.deletePerson ? (
              <>
                {rights.admin ? (
                  <>
                    <button type="button" className="ui-btn" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <button type="button" className="ui-btn" onClick={() => setSuspending(true)}>
                      {p.status === 'active' ? 'Suspend' : 'Reactivate'}
                    </button>
                  </>
                ) : null}
                {rights.deletePerson && !isMe ? (
                  <DeleteObject
                    kind="person"
                    id={p.principal_id}
                    name={p.display_handle}
                    csrf={me.csrf_token}
                    onDeleted={() => navigate('/people')}
                  />
                ) : null}
              </>
            ) : (
              <p className="ui-help">
                You can see this person; changing them needs a factory admin.
              </p>
            )
          }
        />
      </div>
      <Drawer open={editing} title={`Edit ${p.display_name}`} onClose={() => setEditing(false)}>
        <EditPerson me={me} v={v} onDone={() => setEditing(false)} />
      </Drawer>
      {suspending ? <SuspendPerson me={me} v={v} onDone={() => setSuspending(false)} /> : null}
    </>
  );
}

const roleLabel2 = (b: PersonBinding) => roleLabel(b.role_id, roleDef(b.role_id));

function TeamsOf({ me, v, onChange }: { me: Me; v: PersonDetailView; onChange: () => void }) {
  const rights = peopleRights(me);
  const teams = useQuery({ queryKey: ['teams'], queryFn: adminApi.teams });
  const ov = useOverride();
  const qc = useQueryClient();
  const id = useId();
  const mine = (teams.data?.teams ?? []).filter((t) => v.person.teams.includes(t.team_id));
  const others = (teams.data?.teams ?? []).filter(
    (t) => t.group_id !== null && !v.person.teams.includes(t.team_id),
  );
  const [pick, setPick] = useState('');
  const chosen = others.find((t) => t.team_id === (pick || others[0]?.team_id));
  const join = useMutation({
    mutationFn: () =>
      ov.ifNeeded('Add to the team as factory admin', (reason) => {
        if (!chosen?.group_id) throw new Error('Choose a team.');
        return adminApi.addMember(chosen.group_id, v.person.principal_id, me.csrf_token, reason);
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onChange();
    },
  });
  const leave = useMutation({
    mutationFn: (group: string) =>
      ov.ifNeeded('Remove from the team as factory admin', (reason) =>
        adminApi.removeMember(
          group,
          v.person.principal_id,
          'removed in the portal',
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onChange();
    },
  });
  return (
    <Card title={`${label('screen', 'teams')} (${mine.length})`}>
      {mine.length === 0 ? (
        <p className="adm-muted">Not in a team.</p>
      ) : (
        <ul className="adm-chips" aria-label={`Teams of ${v.person.display_name}`}>
          {mine.map((t) => (
            <li key={t.team_id} className="adm-acts">
              <Link to={`/teams/${encodeURIComponent(t.team_id)}`} className="adm-chip">
                {t.name}
              </Link>
              {rights.admin && t.group_id ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                  aria-label={`Remove ${v.person.display_name} from ${t.name}`}
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(t.group_id as string)}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {rights.admin && others.length > 0 ? (
        <form
          className="adm-tools adm-gap"
          onSubmit={(e) => {
            e.preventDefault();
            join.mutate();
          }}
        >
          <label htmlFor={`${id}-t`}>
            <span className="ui-label">Add to a team</span>
            <select
              id={`${id}-t`}
              className="ui-select"
              value={chosen?.team_id ?? ''}
              onChange={(e) => setPick(e.target.value)}
            >
              {others.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="ui-btn" disabled={join.isPending}>
            Add to team
          </button>
        </form>
      ) : null}
      {[join, leave].map((m, i) =>
        m.isError && errorText(m.error) ? (
          <p key={i} className="ui-help ui-help-bad" role="alert">
            {errorText(m.error)}
          </p>
        ) : null,
      )}
      {ov.dialog}
    </Card>
  );
}

function EditPerson({ me, v, onDone }: { me: Me; v: PersonDetailView; onDone: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const ov = useOverride();
  const [name, setName] = useState(v.person.display_name);
  const [email, setEmail] = useState(v.person.upn ?? '');
  const save = useMutation({
    mutationFn: () =>
      ov.ifNeeded('Save as factory admin', (reason) =>
        adminApi.updatePerson(
          v.person.principal_id,
          { display_name: name.trim(), upn: email.trim() || null },
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people'] });
      onDone();
    },
  });
  return (
    <form
      className="adm-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div>
        <label className="ui-label" htmlFor={`${id}-n`}>
          Name
        </label>
        <input
          id={`${id}-n`}
          className="ui-input"
          value={name}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-e`}>
          Company email
        </label>
        <input
          id={`${id}-e`}
          className="ui-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="adm-acts">
        <button
          type="submit"
          className="ui-btn ui-btn-primary"
          disabled={save.isPending || name.trim() === ''}
        >
          Save
        </button>
        <button type="button" className="ui-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      {save.isError && errorText(save.error) ? (
        <p className="ui-help ui-help-bad" role="alert">
          {errorText(save.error)}
        </p>
      ) : null}
      {ov.dialog}
    </form>
  );
}

function SuspendPerson({ me, v, onDone }: { me: Me; v: PersonDetailView; onDone: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const ov = useOverride();
  const [why, setWhy] = useState('');
  const suspend = v.person.status === 'active';
  const verb = suspend ? 'Suspend' : 'Reactivate';
  const go = useMutation({
    mutationFn: () =>
      ov.ifNeeded(`${verb} as factory admin`, (reason) =>
        adminApi.setStatus(
          v.person.principal_id,
          suspend ? 'disabled' : 'active',
          why.trim(),
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people'] });
      onDone();
    },
  });
  if (ov.dialog) return <>{ov.dialog}</>;
  return (
    <Modal
      open
      title={`${verb} ${v.person.display_name}?`}
      onClose={onDone}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className={suspend ? 'ui-btn ui-btn-danger' : 'ui-btn ui-btn-primary'}
            disabled={why.trim() === '' || go.isPending}
            onClick={() => go.mutate()}
          >
            {verb}
          </button>
        </>
      }
    >
      <p>
        {suspend
          ? `${v.person.display_name} will not be able to sign in or act until reactivated. Their roles stay; nothing is deleted.`
          : `${v.person.display_name} can sign in and act again with the roles they hold.`}
      </p>
      <label className="ui-label" htmlFor={id}>
        Why
      </label>
      <textarea
        id={id}
        className="ui-input"
        value={why}
        maxLength={500}
        onChange={(e) => setWhy(e.target.value)}
      />
      {go.isError && errorText(go.error) ? (
        <p className="ui-help ui-help-bad" role="alert">
          {errorText(go.error)}
        </p>
      ) : null}
    </Modal>
  );
}
