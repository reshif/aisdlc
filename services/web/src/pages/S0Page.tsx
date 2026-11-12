import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { CardList } from '../components/CardList';
import { Callout, ErrorNote, PageError, Loading } from '../components/Notice';
import { StepList } from '../components/StepList';
import { shortTime } from '../format';
import { Link } from '../router';
import { QUIET_STATUSES, STATUS_TEXT, levelTitle, stepName } from '../vocab';

/** How often the page asks again while something can still change. */
export const POLL_MS = 3000;

const APP_MISSING = /App not installed/i;

/**
 * One S0 record: the status in words, the steps 0.1 to 0.5 with their states, what the driver is
 * waiting for, and the cards. Polls (no websockets yet); polling stops once nothing can change.
 */
export function S0Page({ id, pollMs = POLL_MS }: { id: string; pollMs?: number }) {
  const s0 = useQuery({
    queryKey: ['s0', id],
    queryFn: () => api.s0(id),
    refetchInterval: (q) =>
      q.state.data && QUIET_STATUSES.has(q.state.data.record.status) ? false : pollMs,
  });
  const cards = useQuery({
    queryKey: ['s0', id, 'cards'],
    queryFn: () => api.cards(id),
    refetchInterval: s0.data && QUIET_STATUSES.has(s0.data.record.status) ? false : pollMs,
  });
  const revision = useQuery({
    queryKey: ['s0', id, 'revision'],
    queryFn: () => api.s0Revision(id),
    refetchInterval: s0.data && QUIET_STATUSES.has(s0.data.record.status) ? false : pollMs,
  });
  const projectId = s0.data?.record.project_id;
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.project(projectId as string),
    enabled: projectId !== undefined,
  });

  if (s0.isPending) return <Loading what="the onboarding" />;
  if (s0.isError) return <PageError error={s0.error} retry={() => void s0.refetch()} />;

  const { record, steps, waiting } = s0.data;
  const status = STATUS_TEXT[record.status];
  const repo =
    project.data?.repos.find((r) => r.repo_id === record.repo_id)?.repo_ref ?? record.repo_id;
  const openCards = (cards.data ?? []).filter((c) => c.status === 'open');
  const blocked = steps.filter((s) => s.state === 'blocked');
  const appMissing = waiting !== null && APP_MISSING.test(waiting);

  return (
    <>
      <p className="crumbs">
        <Link to="/">Projects</Link> /{' '}
        <Link to={`/projects/${record.project_id}`}>{record.project_id}</Link>
      </p>
      <h1>Onboarding of {repo}</h1>
      <p className="status-line" aria-live="polite" data-status={record.status}>
        <Badge tone={status.tone}>{status.label}</Badge> <span>{status.meaning}</span>
      </p>
      <dl className="facts facts-wide">
        <div>
          <dt>Level asked for</dt>
          <dd>{levelTitle(record.requested_level)}</dd>
        </div>
        <div>
          <dt>Highest level it can sign</dt>
          <dd>{levelTitle(record.signable_level)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{shortTime(record.created_at)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{shortTime(record.updated_at)}</dd>
        </div>
      </dl>

      {appMissing ? (
        <Callout title="0.1 waiting: App not installed">
          <p>
            The factory cannot read <code>{repo}</code> because its GitHub App is not installed on
            it.
          </p>
          <ol>
            <li>
              On GitHub, open the factory App and choose <strong>Install</strong>.
            </li>
            <li>
              Choose <strong>Only select repositories</strong> and pick <code>{repo}</code> only.
            </li>
            <li>Come back here. This page checks again by itself.</li>
          </ol>
          <p className="muted">
            The App only reads. Until it is installed, requests for this repo are held.
          </p>
        </Callout>
      ) : waiting ? (
        <Callout title="Waiting">
          <p>{waiting}</p>
        </Callout>
      ) : null}

      {record.status === 'blocked' ? (
        <Callout title="Blocked">
          {blocked.length > 0 ? (
            <ul className="plain">
              {blocked.map((s) => (
                <li key={s.step}>
                  {stepName(s.step)}: <code>{s.blocked_cause}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>A step is blocked.</p>
          )}
        </Callout>
      ) : null}
      {record.status === 'parked' ? (
        <Callout title="Parked">
          <p>Nobody answered in time (5 business days), so the onboarding was parked.</p>
        </Callout>
      ) : null}
      {record.status === 'rejected' ? (
        <Callout title="Rejected">
          <p>
            The owner rejected the onboarding
            {record.rejected_at ? ` at step ${stepName(record.rejected_at)}` : ''}.
          </p>
        </Callout>
      ) : null}

      {revision.data?.revision && !revision.data.revision.published ? (
        <Callout title="Settings revision pending">
          <p>
            {revision.data.revision.status === 'pending'
              ? 'Card 4 proposed this project’s role map and settings. They take effect only when they are approved and published, and the last card cannot open until then.'
              : revision.data.revision.outcome === 'approve'
                ? 'The settings were approved and are being published.'
                : 'The settings were not approved, so they are not in force.'}
          </p>
          <p>
            <Link to={`/revisions/${revision.data.revision.gate_instance_id}`}>
              {revision.data.revision.may_decide
                ? 'Decide the settings revision'
                : 'Look at the settings revision'}
            </Link>
          </p>
        </Callout>
      ) : null}

      <h2>Steps</h2>
      <StepList steps={steps} waiting={appMissing ? null : waiting} />

      <h2>
        Cards {openCards.length > 0 ? <span className="count">{openCards.length} open</span> : null}
      </h2>
      <p>
        <Link to={`/projects/${record.project_id}/ledger?s0=${record.s0_id}`}>
          Ledger entries of this onboarding
        </Link>
      </p>
      {cards.isError ? <ErrorNote error={cards.error} retry={() => void cards.refetch()} /> : null}
      {cards.data ? (
        <CardList cards={cards.data} />
      ) : cards.isPending ? (
        <Loading what="cards" />
      ) : null}
    </>
  );
}
