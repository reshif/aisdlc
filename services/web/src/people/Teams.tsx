import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { label, roleDef, type AccessBindingRow, type TeamRow } from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { DeleteObject, adminApi, errorText, useOverride } from '../admin';
import { ApiError, type Me } from '../api';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link, useNavigate } from '../router';
import {
  Card,
  Drawer,
  EmptyState,
  LockedButton,
  PageHeader,
  PropertiesPanel,
  Table,
  type Column,
} from '../ui';
import { GiveRole } from './GiveRole';
import { ReadError, personPath } from './People';
import {
  PeopleNav,
  Person,
  RoleName,
  StatusPill,
  peopleRights,
  roleLabel,
  scopeLabel,
} from './shared';

// Teams (screen map §2.13 Teams; §3 Team): people who work together. A team is a group of members (its own group,
// `team.<id>`) and the team that names it; a role given to the team reaches every member. Create, change members,
// give and remove the team's roles, delete it (the team and its role assignments go; its members stay).

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;
export const teamPath = (id: string) => `/teams/${encodeURIComponent(id)}`;

const CLASS_WORDS = { internal: 'Internal', confidential: 'Confidential' } as const;

export function TeamsPage({ me }: { me: Me }) {
  const rights = peopleRights(me);
  const q = useQuery({ queryKey: ['teams'], queryFn: adminApi.teams, enabled: rights.read });
  const [adding, setAdding] = useState(false);
  const cols: ReadonlyArray<Column<TeamRow>> = [
    {
      key: 'n',
      header: label('concept', 'team'),
      rowHeader: true,
      render: (t) => <Link to={teamPath(t.team_id)}>{t.name}</Link>,
    },
    {
      key: 'm',
      header: 'Members',
      render: (t) =>
        t.members.length === 0 ? (
          <span className="adm-muted">No members</span>
        ) : (
          <>
            {t.members.length}
            <span className="adm-muted">
              {' · '}
              {t.members
                .slice(0, 3)
                .map((m) => q.data?.names[m] ?? m)
                .join(', ')}
              {t.members.length > 3 ? '…' : ''}
            </span>
          </>
        ),
    },
    { key: 'r', header: 'Roles', align: 'right', render: (t) => t.roles },
    { key: 'c', header: 'Kind', render: (t) => CLASS_WORDS[t.classification] },
  ];
  return (
    <>
      <PageHeader
        title={label('screen', 'teams')}
        crumbs={[{ label: label('screen', 'people_roles') }]}
        meta="People who work together. A role given to a team reaches every member."
        renderLink={renderLink}
        actions={
          rights.admin ? (
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setAdding(true)}>
              Add team
            </button>
          ) : (
            <LockedButton
              label="Add team"
              reason="Adding teams needs the factory admin's sign-in and data rights."
              request={<Link to="/me/access">Ask for access</Link>}
            />
          )
        }
      />
      <PeopleNav me={me} />
      {!rights.read ? (
        <ReadError error={new ApiError(403, 'forbidden', 'denied')} />
      ) : q.isPending ? (
        <Loading what="the teams" />
      ) : q.isError ? (
        <ReadError error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Card flush>
          <Table
            caption="Teams"
            captionHidden
            columns={cols}
            rows={q.data.teams}
            rowKey={(t) => t.team_id}
            empty={
              <EmptyState
                title="No teams yet."
                action={
                  rights.admin ? (
                    <button type="button" className="ui-btn" onClick={() => setAdding(true)}>
                      Add team
                    </button>
                  ) : undefined
                }
              >
                Add a team to give a role to several people at once.
              </EmptyState>
            }
          />
        </Card>
      )}
      <Drawer open={adding} title="Add team" onClose={() => setAdding(false)}>
        <AddTeam me={me} onDone={() => setAdding(false)} />
      </Drawer>
    </>
  );
}

const teamSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

function AddTeam({ me, onDone }: { me: Me; onDone: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ov = useOverride();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'internal' | 'confidential'>('internal');
  const tid = teamSlug(name);
  const add = useMutation({
    mutationFn: () =>
      ov.ifNeeded('Add as factory admin', (reason) =>
        adminApi.createTeam(
          { team_id: tid, name: name.trim(), classification: kind },
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onDone();
      navigate(teamPath(tid));
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
          aria-describedby={`${id}-nh`}
          onChange={(e) => setName(e.target.value)}
        />
        <p id={`${id}-nh`} className="ui-help">
          {tid ? `Its link will be /teams/${tid}.` : 'For example "Payments".'}
        </p>
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-k`}>
          Kind
        </label>
        <select
          id={`${id}-k`}
          className="ui-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="internal">{CLASS_WORDS.internal}</option>
          <option value="confidential">{CLASS_WORDS.confidential}</option>
        </select>
      </div>
      <div className="adm-acts">
        <button
          type="submit"
          className="ui-btn ui-btn-primary"
          disabled={add.isPending || tid === ''}
        >
          Add team
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

export function TeamPage({ id, me }: { id: string; me: Me }) {
  const rights = peopleRights(me);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ov = useOverride();
  const fid = useId();
  const q = useQuery({
    queryKey: ['teams', id],
    queryFn: () => adminApi.team(id),
    enabled: rights.read,
  });
  const people = useQuery({
    queryKey: ['people'],
    queryFn: adminApi.people,
    enabled: rights.admin,
  });
  const [pick, setPick] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['teams'] });
    void qc.invalidateQueries({ queryKey: ['people'] });
  };
  const add = useMutation({
    mutationFn: (who: string) =>
      ov.ifNeeded('Add as factory admin', (reason) =>
        adminApi.addMember(q.data?.team.group_id ?? '', who, me.csrf_token, reason),
      ),
    onSuccess: () => {
      setPick('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (who: string) =>
      ov.ifNeeded('Remove as factory admin', (reason) =>
        adminApi.removeMember(
          q.data?.team.group_id ?? '',
          who,
          'removed in the portal',
          me.csrf_token,
          reason,
        ),
      ),
    onSuccess: refresh,
  });
  if (!rights.read) return <ReadError error={new ApiError(403, 'forbidden', 'denied')} />;
  if (q.isPending) return <Loading what="the team" />;
  if (q.isError) return <ReadError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const t = v.team;
  const candidates = (people.data?.people ?? []).filter(
    (p) => p.kind === 'human' && !t.members.includes(p.principal_id),
  );
  const chosen = pick || candidates[0]?.principal_id || '';
  const memberCols: ReadonlyArray<Column<(typeof v.members)[number]>> = [
    {
      key: 'n',
      header: 'Name',
      rowHeader: true,
      render: (m) => <Person name={m.display_name} to={personPath(m.principal_id)} />,
    },
    { key: 's', header: 'Status', render: (m) => <StatusPill status={m.status} /> },
    {
      key: 'a',
      header: <span className="ui-sr">Actions</span>,
      render: (m) =>
        rights.admin ? (
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            aria-label={`Remove ${m.display_name} from ${t.name}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate(m.principal_id)}
          >
            Remove
          </button>
        ) : null,
    },
  ];
  const roleCols: ReadonlyArray<Column<AccessBindingRow>> = [
    {
      key: 'r',
      header: label('concept', 'role'),
      rowHeader: true,
      render: (b) => <RoleName id={b.role_id} def={roleDef(b.role_id)} />,
    },
    { key: 'w', header: 'Where', render: (b) => scopeLabel(b.scope) },
    {
      key: 'u',
      header: 'Until',
      render: (b) => (b.expiry ? shortTime(b.expiry) : <span className="adm-muted">No end</span>),
    },
    {
      key: 'a',
      header: <span className="ui-sr">Actions</span>,
      render: (b) =>
        rights.deleteBinding ? (
          <DeleteObject
            kind="binding"
            id={b.binding_id}
            name={roleLabel(b.role_id, roleDef(b.role_id))}
            csrf={me.csrf_token}
            small
            onDeleted={refresh}
          />
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={t.name}
        crumbs={[{ label: label('screen', 'teams'), to: '/teams' }, { label: t.name }]}
        meta={`${t.members.length} ${t.members.length === 1 ? 'member' : 'members'} · ${t.roles} ${t.roles === 1 ? 'role' : 'roles'}`}
        renderLink={renderLink}
      />
      <div className="ui-split">
        <div className="adm-stack">
          <Card title={`Members (${v.members.length})`} flush>
            <Table
              caption={`Members of ${t.name}`}
              captionHidden
              columns={memberCols}
              rows={v.members}
              rowKey={(m) => m.principal_id}
              empty={<EmptyState title="No members yet">Add people to the team below.</EmptyState>}
            />
            {rights.admin && t.group_id ? (
              <form
                className="adm-tools"
                style={{ padding: '14px 16px' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chosen) add.mutate(chosen);
                }}
              >
                <label htmlFor={`${fid}-p`}>
                  <span className="ui-label">Add a member</span>
                  <select
                    id={`${fid}-p`}
                    className="ui-select"
                    value={chosen}
                    onChange={(e) => setPick(e.target.value)}
                  >
                    {candidates.map((p) => (
                      <option key={p.principal_id} value={p.principal_id}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="ui-btn" disabled={add.isPending || !chosen}>
                  Add member
                </button>
              </form>
            ) : null}
            {!t.group_id ? (
              <p className="ui-help" style={{ padding: '0 16px 14px' }}>
                This team has no member group: it was made outside the portal.
              </p>
            ) : null}
            {[add, remove].map((m, i) =>
              m.isError && errorText(m.error) ? (
                <p
                  key={i}
                  className="ui-help ui-help-bad"
                  role="alert"
                  style={{ padding: '0 16px' }}
                >
                  {errorText(m.error)}
                </p>
              ) : null,
            )}
          </Card>
          <Card title={`Roles (${v.bindings.length})`} flush>
            <Table
              caption={`Roles of ${t.name}`}
              captionHidden
              columns={roleCols}
              rows={v.bindings}
              rowKey={(b) => b.binding_id}
              empty={
                <EmptyState title="No roles yet">
                  A role given to the team reaches every member.
                </EmptyState>
              }
            />
          </Card>
          {rights.manage && t.group_id ? (
            <Card title="Give the team a role">
              <GiveRole
                me={me}
                who={`the ${t.name} team`}
                group={async () => t.group_id as string}
                onDone={refresh}
              />
            </Card>
          ) : null}
        </div>
        <PropertiesPanel
          rows={[
            { label: 'Name', value: t.name },
            { label: 'Kind', value: CLASS_WORDS[t.classification] },
            { label: 'Members', value: t.members.length },
            { label: 'Roles', value: t.roles },
          ]}
          actions={
            rights.deleteTeam ? (
              <DeleteObject
                kind="team"
                id={t.team_id}
                name={t.name}
                csrf={me.csrf_token}
                onDeleted={() => {
                  refresh();
                  navigate('/teams');
                }}
              />
            ) : (
              <p className="ui-help">Changing the team needs a factory admin.</p>
            )
          }
        />
      </div>
      {ov.dialog}
    </>
  );
}
