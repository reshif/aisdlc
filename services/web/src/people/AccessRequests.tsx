import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { label, roleDef, type AccessChange } from '@aisdlc/contracts';
import { useState } from 'react';
import { adminApi, errorText, useOverride } from '../admin';
import { api, type AccessGrantWire, type Me, type PreparedRevision } from '../api';
import { StepUpBox, useStepUp } from '../cards/StepUp';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, PageHeader, PropertiesPanel, Table, type Column } from '../ui';
import { ReadError } from './People';
import {
  GrantStatusPill,
  PeopleNav,
  RoleName,
  peopleRights,
  scopeLabel,
  useIsFactoryAdmin,
} from './shared';

// Access requests (screen map §2.13; N21): a request for a role, or a grant or removal someone proposed, waits for
// an answer from whoever holds the scope's admin role (the factory admins for the whole factory), never the person
// asking or the person it names. Approving writes the role at once; both answers go in the decision log. A factory
// admin may answer any request alone, their own too, with a reason that is recorded with the decision.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;
export const requestPath = (id: string) => `/access/grants/${encodeURIComponent(id)}`;

/** The names the screen can show: the directory's when the person may read it, else the ids as they are. */
function useNames(me: Me): (id: string) => string {
  const q = useQuery({
    queryKey: ['people'],
    queryFn: adminApi.people,
    enabled: peopleRights(me).read,
  });
  const m = new Map((q.data?.people ?? []).map((p) => [p.principal_id as string, p.display_name]));
  return (id) => m.get(id) ?? id;
}

function forWhom(c: AccessChange, name: (id: string) => string): string {
  if (c.op === 'revoke') return `Remove from ${c.group_id}`;
  return c.target.kind === 'principal'
    ? name(c.target.principal_id)
    : `${label('concept', 'team')} ${c.target.team_id}`;
}

export function AccessRequestsPage({ me }: { me: Me }) {
  const q = useQuery({ queryKey: ['access-grants'], queryFn: api.accessGrants });
  const name = useNames(me);
  const [show, setShow] = useState<'waiting' | 'answered'>('waiting');
  const rows = (q.data?.grants ?? []).filter((g) =>
    show === 'waiting' ? g.status === 'pending' : g.status !== 'pending',
  );
  const cols: ReadonlyArray<Column<AccessGrantWire>> = [
    {
      key: 'w',
      header: 'For',
      rowHeader: true,
      render: (g) => <Link to={requestPath(g.grant_id)}>{forWhom(g.change, name)}</Link>,
    },
    {
      key: 'r',
      header: label('concept', 'role'),
      render: (g) => (
        <>
          {g.change.op === 'revoke' ? 'Remove ' : ''}
          <RoleName id={g.change.role_id} def={roleDef(g.change.role_id)} />
        </>
      ),
    },
    { key: 's', header: 'Where', render: (g) => scopeLabel(g.change.scope) },
    { key: 'b', header: 'Asked by', render: (g) => name(g.proposed_by) },
    { key: 'y', header: 'Why', render: (g) => g.reason },
    { key: 't', header: 'When', render: (g) => shortTime(g.proposed_at) },
    { key: 'st', header: 'Status', render: (g) => <GrantStatusPill status={g.status} /> },
    {
      key: 'a',
      header: <span className="ui-sr">Actions</span>,
      render: (g) =>
        g.may_decide ? (
          <Link to={requestPath(g.grant_id)} className="ui-btn ui-btn-sm ui-btn-primary">
            Answer
          </Link>
        ) : null,
    },
  ];
  const waiting = (q.data?.grants ?? []).filter((g) => g.status === 'pending').length;
  return (
    <>
      <PageHeader
        title={label('screen', 'access_requests')}
        crumbs={[{ label: label('screen', 'people_roles') }]}
        meta="Requests for a role and proposed changes, waiting for an answer from someone other than the person asking."
        renderLink={renderLink}
        actions={
          <Link to="/me/access#ask" className="ui-btn">
            Ask for a role
          </Link>
        }
      />
      <PeopleNav me={me} />
      <div className="adm-filters" role="group" aria-label="Show">
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          aria-pressed={show === 'waiting'}
          onClick={() => setShow('waiting')}
        >
          Waiting ({waiting})
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          aria-pressed={show === 'answered'}
          onClick={() => setShow('answered')}
        >
          Answered
        </button>
      </div>
      {q.isPending ? (
        <Loading what="the access requests" />
      ) : q.isError ? (
        <ReadError error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Card flush>
          <Table
            caption="Access requests"
            captionHidden
            columns={cols}
            rows={rows}
            rowKey={(g) => g.grant_id}
            empty={
              <EmptyState title={show === 'waiting' ? 'Nothing waiting' : 'Nothing answered yet'}>
                {show === 'waiting'
                  ? 'You see your own requests, the ones that name you, and those you may answer.'
                  : 'Answered requests stay here with their answer.'}
              </EmptyState>
            }
          />
        </Card>
      )}
    </>
  );
}

/** One request, to read and answer: approve or reject, with the identity check when the answer needs one. */
export function AccessRequestPage({ id, me }: { id: string; me: Me }) {
  const qc = useQueryClient();
  const csrf = me.csrf_token;
  const q = useQuery({ queryKey: ['access-grant', id], queryFn: () => api.accessGrant(id) });
  const name = useNames(me);
  const admin = useIsFactoryAdmin();
  const ov = useOverride();
  const [prep, setPrep] = useState<PreparedRevision | null>(null);
  /** The override's reason, when the factory admin answers outside the slot (sent with every step). */
  const [reason, setReason] = useState<string | undefined>(undefined);
  const needsProof = prep?.step_up?.required === true;
  const stepUp = useStepUp(needsProof ? (prep?.step_up?.bound_hash ?? null) : null, csrf);
  const read = useMutation({
    mutationFn: async (why: string | undefined) => {
      const p = await adminApi.prepareAccess(id, csrf, why);
      await adminApi.accessEvidence(
        id,
        { nonce: p.nonce, evidence_hash: p.evidence_hash },
        csrf,
        why,
      );
      return { p, why };
    },
    onSuccess: ({ p, why }) => {
      setPrep(p);
      setReason(why);
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!prep) throw new Error('Read the request first.');
      return adminApi.decideAccess(
        id,
        {
          nonce: prep.nonce,
          decision,
          ...(needsProof && stepUp.proof ? { step_up: { proof: stepUp.proof } } : {}),
        },
        csrf,
        reason,
      );
    },
    onSuccess: () => {
      setPrep(null);
      stepUp.clear();
      void qc.invalidateQueries({ queryKey: ['access-grant', id] });
      void qc.invalidateQueries({ queryKey: ['access-grants'] });
      void qc.invalidateQueries({ queryKey: ['access'] });
      void qc.invalidateQueries({ queryKey: ['people'] });
    },
  });
  if (q.isPending) return <Loading what="the request" />;
  if (q.isError) return <ReadError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const c = v.change;
  const pending = v.status === 'pending';
  const title =
    c.op === 'grant' ? `${forWhom(c, name)} asks for a role` : `Remove a role from ${c.group_id}`;
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[
          { label: label('screen', 'access_requests'), to: '/access-requests' },
          { label: forWhom(c, name) },
        ]}
        status={<GrantStatusPill status={v.status} />}
        meta={`Asked by ${name(v.proposed_by)} · ${shortTime(v.proposed_at)}`}
        renderLink={renderLink}
      />
      <div className="ui-split">
        <div className="adm-stack">
          <Card title="What it changes">
            <p>
              {c.op === 'grant' ? 'Gives ' : 'Takes away '}
              <strong>
                <RoleName id={c.role_id} def={roleDef(c.role_id)} />
              </strong>{' '}
              {c.op === 'grant' ? 'to' : 'from'} <strong>{forWhom(c, name)}</strong> on{' '}
              <strong>{scopeLabel(c.scope)}</strong>
              {c.op === 'grant' && c.expiry ? `, until ${shortTime(c.expiry)}` : ''}.
            </p>
            <p className="adm-muted">Why: {v.reason}</p>
          </Card>
          {pending ? (
            <Card title="Your answer" testId="grant-decide">
              {v.may_decide || reason !== undefined ? (
                prep === null ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={read.isPending}
                    onClick={() => read.mutate(undefined)}
                  >
                    I have read it; answer now
                  </button>
                ) : (
                  <div className="adm-stack">
                    {reason !== undefined ? (
                      <p className="adm-note">
                        Answering as factory admin. Your reason goes in the decision log: “{reason}”
                      </p>
                    ) : null}
                    {needsProof ? (
                      <StepUpBox s={stepUp} boundHash={prep.step_up?.bound_hash ?? null} />
                    ) : null}
                    <div className="adm-acts">
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
                  </div>
                )
              ) : admin ? (
                <>
                  <p className="ui-help">
                    You are not one of the people who answer this
                    {v.proposed_by === me.principal.principal_id ? ' (it is your own request)' : ''}
                    . As factory admin you may answer it anyway; your reason is recorded.
                  </p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={read.isPending}
                    onClick={() =>
                      void ov
                        .withReason('Answer as factory admin', async (why) => read.mutateAsync(why))
                        .catch(() => undefined)
                    }
                  >
                    Answer as factory admin
                  </button>
                </>
              ) : (
                <p className="ui-help">
                  You do not answer this one.{' '}
                  {v.deciders.length === 0
                    ? 'Nobody can answer it now.'
                    : `${v.deciders.map(name).join(', ')} can.`}
                </p>
              )}
              {[read, decide].map((m, i) =>
                m.isError && errorText(m.error) ? (
                  <p key={i} className="ui-help ui-help-bad" role="alert">
                    {errorText(m.error)}
                  </p>
                ) : null,
              )}
              {stepUp.error ? (
                <p className="ui-help ui-help-bad" role="alert">
                  {errorText(stepUp.error)}
                </p>
              ) : null}
            </Card>
          ) : null}
          {decide.isSuccess ? (
            <p className="adm-status" role="status">
              Your answer is in the decision log
              {decide.data.applied ? ' and the role is changed.' : '.'}
              {decide.data.apply_error ? ` Not applied yet: ${decide.data.apply_error}` : ''}
            </p>
          ) : null}
        </div>
        <PropertiesPanel
          rows={[
            { label: 'For', value: forWhom(c, name) },
            {
              label: label('concept', 'role'),
              value: <RoleName id={c.role_id} def={roleDef(c.role_id)} />,
            },
            { label: 'Where', value: scopeLabel(c.scope) },
            { label: 'Asked by', value: name(v.proposed_by) },
            { label: 'Status', value: <GrantStatusPill status={v.status} /> },
            {
              label: 'Who answers',
              value: pending
                ? v.deciders.length === 0
                  ? 'Nobody now'
                  : v.deciders.map(name).join(', ')
                : '—',
            },
          ]}
        />
      </div>
      {ov.dialog}
    </>
  );
}
