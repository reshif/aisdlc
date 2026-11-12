import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FLEET_REF,
  GRANTABLE_ROLES,
  accessResourceOf,
  roleDef,
  scopeKey,
  type AccessBindingRow,
  type AccessChange,
  type GrantScope,
  type PrincipalSummary,
  type Team,
} from '@aisdlc/contracts';
import { useState, type FormEvent } from 'react';
import { Guarded } from '../access';
import { api, type AccessGrantWire, type Me, type PreparedRevision } from '../api';
import { StepUpBox, useStepUp } from '../cards/StepUp';
import { ErrorNote } from '../components/Notice';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, KeyValue, Modal, PageHead, Pill, Table, type Column } from '../ui';

// Role-binding grants, revokes and access requests (portal-review P1-6). What is grantable is the role catalogue's
// roles no project slot maps to (`GRANTABLE_ROLES`): the slot roles of a project change with its role map in Project
// settings (card 4), never here. Every grant and revoke is a proposal: an M1 gate at the scope's admin slot (the
// factory's for the fleet) decides it, never the proposer or the person granted, and the server asks the PDP for
// `access.manage` on the scope at every step. The buttons here are hints (`Guarded`).

const FLEET: GrantScope = { kind: 'fleet', ref: FLEET_REF };
const scopeText = (s: { kind: string; ref: string }): string =>
  s.kind === 'fleet' ? 'whole factory' : `${s.kind} ${s.ref}`;

/** The scopes this person may manage access on, from `/api/me` (a hint; the server decides). */
export function managedScopes(me: Me): GrantScope[] {
  const out: GrantScope[] = [];
  if (me.actions.fleet.includes('access.manage')) out.push(FLEET);
  for (const p of me.actions.projects) {
    if (p.actions.includes('access.manage'))
      out.push({ kind: 'project', ref: p.project_id as never });
  }
  return out;
}

const changeText = (c: AccessChange): string =>
  c.op === 'grant'
    ? `grant ${c.role_id} to ${c.target.kind === 'principal' ? c.target.principal_id : `team ${c.target.team_id}`} on ${scopeText(c.scope)}${c.expiry ? ` until ${shortTime(c.expiry)}` : ''}`
    : `revoke ${c.role_id} from ${c.group_id} on ${scopeText(c.scope)}`;

const STATUS_TONE = {
  pending: 'warn',
  approved: 'info',
  applied: 'ok',
  rejected: 'bad',
  ended: 'mute',
} as const;

function ScopePicker({
  scopes,
  value,
  onChange,
  label = 'Scope',
}: {
  scopes: readonly GrantScope[];
  value: GrantScope;
  onChange: (s: GrantScope) => void;
  label?: string;
}) {
  return (
    <label>
      {label}{' '}
      <select
        value={scopeKey(value)}
        onChange={(e) => {
          const s = scopes.find((x) => scopeKey(x) === e.target.value);
          if (s) onChange(s);
        }}
      >
        {scopes.map((s) => (
          <option key={scopeKey(s)} value={scopeKey(s)}>
            {scopeText(s)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Propose a grant: who, which role, where, until when, why. */
export function GrantPanel({
  me,
  principals,
  teams,
}: {
  me: Me;
  principals: readonly PrincipalSummary[] | null;
  teams: readonly Team[] | null;
}) {
  const qc = useQueryClient();
  const scopes = managedScopes(me);
  const [scope, setScope] = useState<GrantScope>(scopes[0] ?? FLEET);
  const roles = GRANTABLE_ROLES.filter((r) => r.scope_kinds.includes(scope.kind));
  const [role, setRole] = useState<string>('');
  const [kind, setKind] = useState<'principal' | 'team'>('principal');
  const [who, setWho] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => {
      const roleId = role || roles[0]?.role_id || '';
      const change: AccessChange = {
        op: 'grant',
        target:
          kind === 'principal'
            ? { kind: 'principal', principal_id: who as never }
            : { kind: 'team', team_id: who as never },
        role_id: roleId as never,
        scope,
        expiry: until === '' ? null : new Date(`${until}T00:00:00.000Z`).toISOString(),
      };
      return api.proposeAccess({ change, reason }, me.csrf_token);
    },
    onSuccess: () => {
      setWho('');
      setReason('');
      void qc.invalidateQueries({ queryKey: ['access-grants'] });
    },
  });
  if (scopes.length === 0) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <Card title="Grant a role" testId="grant-panel">
      <p className="muted">
        For roles beyond a project&rsquo;s role map: a viewer, an auditor, another factory admin.
        The role map&rsquo;s slots change in Project settings. The grant waits for an M1 decided by
        someone else at the scope&rsquo;s admin slot.
      </p>
      <form className="pg-form" onSubmit={submit} aria-label="Grant a role">
        <ScopePicker scopes={scopes} value={scope} onChange={setScope} />
        <label>
          Role{' '}
          <select value={role || roles[0]?.role_id || ''} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {r.role_id}
              </option>
            ))}
          </select>
        </label>
        <label>
          To{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as 'principal' | 'team')}>
            <option value="principal">a person</option>
            <option value="team">a team</option>
          </select>
        </label>
        {kind === 'principal' && principals ? (
          <label>
            Person{' '}
            <select value={who} onChange={(e) => setWho(e.target.value)} required>
              <option value="">choose…</option>
              {principals.map((p) => (
                <option key={p.principal_id} value={p.principal_id}>
                  {p.display_name} ({p.principal_id})
                </option>
              ))}
            </select>
          </label>
        ) : kind === 'team' && teams ? (
          <label>
            Team{' '}
            <select value={who} onChange={(e) => setWho(e.target.value)} required>
              <option value="">choose…</option>
              {teams.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            {kind === 'principal' ? 'Principal id' : 'Team id'}{' '}
            <input value={who} onChange={(e) => setWho(e.target.value)} required />
          </label>
        )}
        <label>
          Ends (optional){' '}
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <label>
          Reason <input value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
        <Guarded
          action="access.manage"
          resource={accessResourceOf(scope)}
          label="Propose the grant"
        >
          <button
            type="submit"
            className="ui-btn ui-btn-primary"
            disabled={send.isPending || who === '' || reason.trim() === ''}
          >
            Propose the grant
          </button>
        </Guarded>
      </form>
      {send.isError ? <ErrorNote error={send.error} /> : null}
      {send.isSuccess ? (
        <p role="status">
          Proposed: waiting for {send.data.deciders.join(', ')}.{' '}
          <Link to={`/access/grants/${send.data.grant_id}`}>Open it</Link>
        </p>
      ) : null}
    </Card>
  );
}

const ORIGIN_TEXT = {
  role_map: 'role map (Project settings)',
  access_grant: 'decided grant',
  other: 'identity',
} as const;

/** The bindings at one scope, each a revoke proposal away unless the role map owns it. */
export function BindingsPanel({ me }: { me: Me }) {
  const qc = useQueryClient();
  const scopes = managedScopes(me);
  const [scope, setScope] = useState<GrantScope>(scopes[0] ?? FLEET);
  const [revoking, setRevoking] = useState<AccessBindingRow | null>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['access-bindings', scopeKey(scope)],
    queryFn: () => api.accessBindings(scopeKey(scope)),
    enabled: scopes.length > 0,
  });
  const revoke = useMutation({
    mutationFn: (b: AccessBindingRow) =>
      api.proposeAccess(
        {
          change: {
            op: 'revoke',
            binding_id: b.binding_id,
            group_id: b.group_id,
            role_id: b.role_id,
            scope: b.scope,
          },
          reason,
        },
        me.csrf_token,
      ),
    onSuccess: () => {
      setRevoking(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['access-grants'] });
    },
  });
  if (scopes.length === 0) return null;
  const cols: ReadonlyArray<Column<AccessBindingRow>> = [
    { key: 'r', header: 'Role', rowHeader: true, render: (b) => <code>{b.role_id}</code> },
    { key: 'g', header: 'Group', render: (b) => <code>{b.group_id}</code> },
    { key: 'm', header: 'Members', render: (b) => b.members.join(', ') || 'none' },
    { key: 'e', header: 'Ends', render: (b) => (b.expiry ? shortTime(b.expiry) : 'no end date') },
    { key: 'o', header: 'From', render: (b) => ORIGIN_TEXT[b.origin] },
    {
      key: 'a',
      header: 'Action',
      render: (b) =>
        b.origin === 'role_map' ? (
          <span className="muted">change it in Project settings</span>
        ) : (
          <Guarded action="access.manage" resource={accessResourceOf(b.scope)} label="Revoke">
            <button type="button" className="ui-btn" onClick={() => setRevoking(b)}>
              Revoke
            </button>
          </Guarded>
        ),
    },
  ];
  return (
    <Card title="Bindings" testId="bindings-panel">
      <div className="pg-filters">
        <ScopePicker scopes={scopes} value={scope} onChange={setScope} label="At" />
      </div>
      <Read q={q} what="the bindings">
        {(v) => (
          <Table
            caption={`Bindings on ${scopeText(scope)}`}
            columns={cols}
            rows={v.bindings}
            rowKey={(b) => b.binding_id}
            empty={
              <EmptyState title="No binding here">Nobody holds a role at this scope.</EmptyState>
            }
          />
        )}
      </Read>
      <Modal
        open={revoking !== null}
        title="Propose a revoke"
        onClose={() => setRevoking(null)}
        footer={
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={revoke.isPending || reason.trim() === ''}
            onClick={() => revoking && revoke.mutate(revoking)}
          >
            Propose the revoke
          </button>
        }
      >
        {revoking ? (
          <>
            <p>
              Revoke <code>{revoking.role_id}</code> from <code>{revoking.group_id}</code> on{' '}
              {scopeText(revoking.scope)}. Someone else at the scope&rsquo;s admin slot decides it.
            </p>
            <label className="pg-form">
              Reason <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {revoke.isError ? <ErrorNote error={revoke.error} /> : null}
          </>
        ) : null}
      </Modal>
    </Card>
  );
}

const GRANT_COLS: ReadonlyArray<Column<AccessGrantWire>> = [
  {
    key: 'c',
    header: 'Change',
    rowHeader: true,
    render: (g) => <Link to={`/access/grants/${g.grant_id}`}>{changeText(g.change)}</Link>,
  },
  { key: 'o', header: 'Asked as', render: (g) => (g.origin === 'request' ? 'request' : 'grant') },
  { key: 'p', header: 'By', render: (g) => g.proposed_by },
  { key: 't', header: 'When', render: (g) => shortTime(g.proposed_at) },
  {
    key: 's',
    header: 'State',
    render: (g) => (
      <>
        <Pill tone={STATUS_TONE[g.status]}>{g.status}</Pill>
        {g.may_decide ? <Pill tone="gate">yours to decide</Pill> : null}
      </>
    ),
  },
];

/** Every proposal the person may see: their own, the ones naming them, those on scopes they manage. */
export function GrantsList({ only }: { only?: (g: AccessGrantWire) => boolean }) {
  const q = useQuery({ queryKey: ['access-grants'], queryFn: api.accessGrants });
  return (
    <Read q={q} what="the access proposals">
      {(v) => {
        const rows = only ? v.grants.filter(only) : v.grants;
        return (
          <Card title={`${rows.length} proposals`} flush>
            <Table
              caption="Grants, revokes and access requests"
              captionHidden
              columns={GRANT_COLS}
              rows={rows}
              rowKey={(g) => g.grant_id}
              empty={<EmptyState title="Nothing yet">No grant, revoke or request.</EmptyState>}
            />
          </Card>
        );
      }}
    </Read>
  );
}

export function AccessRequestsPage({ me }: { me: Me }) {
  return (
    <>
      <PageHead
        eyebrow="Admin"
        title="Access requests"
        sub="Grants, revokes and access requests, each waiting for (or decided by) an M1 at the scope's admin slot. Nobody decides their own."
        actions={
          <Link to="/me/access" className="ui-btn">
            Ask for a role
          </Link>
        }
      />
      <GrantsList />
      {managedScopes(me).length > 0 ? null : (
        <p className="muted">
          You manage access nowhere: you see your own requests and the ones that name you.
        </p>
      )}
    </>
  );
}

/** One grant, revoke or request as something to decide (prepare, the evidence viewed, the vote). */
export function AccessGrantPage({ id, csrf }: { id: string; csrf: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['access-grant', id], queryFn: () => api.accessGrant(id) });
  const [prep, setPrep] = useState<PreparedRevision | null>(null);
  // a vote that needs two people needs each to step up (RC-SEC-4): the proof is bound to the gate's hash
  const needsProof = prep?.step_up?.required === true;
  const stepUp = useStepUp(needsProof ? (prep?.step_up?.bound_hash ?? null) : null, csrf);
  const read = useMutation({
    mutationFn: async () => {
      const p = await api.prepareAccess(id, csrf);
      await api.accessEvidence(id, { nonce: p.nonce, evidence_hash: p.evidence_hash }, csrf);
      return p;
    },
    onSuccess: (p) => setPrep(p),
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!prep) throw new Error('read the change first');
      return api.decideAccess(
        id,
        {
          nonce: prep.nonce,
          decision,
          ...(needsProof && stepUp.proof ? { step_up: { proof: stepUp.proof } } : {}),
        },
        csrf,
      );
    },
    onSuccess: () => {
      setPrep(null);
      stepUp.clear();
      void qc.invalidateQueries({ queryKey: ['access-grant', id] });
      void qc.invalidateQueries({ queryKey: ['access-grants'] });
      void qc.invalidateQueries({ queryKey: ['access'] });
    },
  });
  return (
    <Read q={q} what="the proposal">
      {(v) => (
        <>
          <PageHead
            eyebrow="Admin · access M1"
            title={v.change.op === 'grant' ? 'A role grant' : 'A role revoke'}
            crumbs={[{ label: 'Access requests', to: '/access-requests' }, { label: 'proposal' }]}
            renderLink={(to, label) => <Link to={to}>{label}</Link>}
            sub="Decided at the scope's admin slot (the factory admins for the whole factory) by someone other than the proposer and the person granted."
          />
          <Card title="What it changes">
            <KeyValue
              rows={[
                ['Change', changeText(v.change)],
                ['Role', roleDef(v.change.role_id)?.description ?? <code>{v.change.role_id}</code>],
                ['Asked as', v.origin === 'request' ? 'an access request' : 'a grant'],
                ['Proposed by', v.proposed_by],
                ['Reason', v.reason],
                [
                  'State',
                  <Pill key="s" tone={STATUS_TONE[v.status]}>
                    {v.status}
                  </Pill>,
                ],
                [
                  'May decide now',
                  v.status !== 'pending'
                    ? '—'
                    : v.deciders.length === 0
                      ? 'nobody'
                      : v.deciders.join(', '),
                ],
                ['Subject', <ShortHash key="h" hash={v.subject_hash} />],
              ]}
            />
          </Card>
          {v.may_decide ? (
            <Card title="Your decision" testId="grant-decide">
              {prep === null ? (
                <button
                  type="button"
                  className="ui-btn"
                  disabled={read.isPending}
                  onClick={() => read.mutate()}
                >
                  I have read the change
                </button>
              ) : (
                <div className="pg-inline">
                  {needsProof ? (
                    <StepUpBox s={stepUp} boundHash={prep.step_up?.bound_hash ?? null} />
                  ) : null}
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={decide.isPending || (needsProof && !stepUp.proof)}
                    onClick={() => decide.mutate('approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="ui-btn"
                    disabled={decide.isPending || (needsProof && !stepUp.proof)}
                    onClick={() => decide.mutate('reject')}
                  >
                    Reject
                  </button>
                </div>
              )}
              {read.isError ? <ErrorNote error={read.error} /> : null}
              {decide.isError ? <ErrorNote error={decide.error} /> : null}
              {stepUp.error ? <ErrorNote error={stepUp.error} /> : null}
              {decide.isSuccess ? (
                <p role="status">
                  Your decision is on the ledger
                  {decide.data.applied ? '; the binding is changed.' : '.'}
                  {decide.data.apply_error ? ` Not applied yet: ${decide.data.apply_error}` : ''}
                </p>
              ) : null}
            </Card>
          ) : v.status === 'pending' ? (
            <p className="muted">You do not decide this one.</p>
          ) : null}
        </>
      )}
    </Read>
  );
}

/** My access: ask for a role (for yourself); someone at the scope's admin slot decides it. */
export function AccessRequestForm({
  me,
  project,
  roles,
}: {
  me: Me;
  project: string | null;
  /** The roles that would grant what was asked for, when the person came from a locked button. */
  roles: readonly string[];
}) {
  const qc = useQueryClient();
  const grantable = GRANTABLE_ROLES.filter((r) =>
    r.scope_kinds.some((k) => k === 'fleet' || (k === 'project' && project !== null)),
  );
  const first = grantable.find((r) => roles.includes(r.role_id)) ?? grantable[0];
  const [role, setRole] = useState(first?.role_id ?? '');
  const def = GRANTABLE_ROLES.find((r) => r.role_id === role);
  const scope: GrantScope | null =
    def?.scope_kinds.includes('project') && project !== null
      ? { kind: 'project', ref: project as never }
      : def?.scope_kinds.includes('fleet')
        ? FLEET
        : null;
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => {
      if (!scope) throw new Error('that role is not asked for here');
      return api.requestAccess({ role_id: role, scope, expiry: null, reason }, me.csrf_token);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['access-grants'] }),
  });
  if (grantable.length === 0) return null;
  return (
    <form
      className="pg-form"
      aria-label="Ask for a role"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <label>
        Role{' '}
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {grantable.map((r) => (
            <option key={r.role_id} value={r.role_id}>
              {r.role_id}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">On {scope ? scopeText(scope) : 'no scope this role allows'}.</p>
      <label>
        Why <input value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <button
        type="submit"
        className="ui-btn ui-btn-primary"
        disabled={send.isPending || reason.trim() === '' || scope === null}
      >
        Ask for it
      </button>
      {send.isError ? <ErrorNote error={send.error} /> : null}
      {send.isSuccess ? (
        <p role="status">
          Asked: {send.data.deciders.join(', ')} may decide it.{' '}
          <Link to={`/access/grants/${send.data.grant_id}`}>Follow it</Link>
        </p>
      ) : null}
    </form>
  );
}
