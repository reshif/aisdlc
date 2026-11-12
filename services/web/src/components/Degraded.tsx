import type { DegradedView } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Link } from '../router';

// The degraded states a work screen states first (PLAN M19; portal coverage §4). Shown above the page, read from the
// bff's `/api/degraded` for the projects on it:
//   - the kill switch: a kill on the project, or a kill switch that could not be asked, which reads KILLED (AR9);
//   - the Notary down: decisions cannot be signed, so they are refused (fail closed); operator actions are in force
//     and wait for the backfill; its health unknown is said as unknown;
//   - a read model the page is served from that could not catch up: the page may be behind.
// A check that cannot be made at all is said too, and reads as stopped, never as fine.

export type ReadModelName = 'work_item' | 'floor' | 'session_activity';

export function KillNotices({ kills }: { kills: DegradedView['kills'] }) {
  const shown = kills.filter((k) => k.killed);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((k) => (
        <div
          key={k.project_id}
          className="notice notice-bad"
          role="alert"
          data-testid="kill-notice"
        >
          {k.state === 'killed' ? (
            <p>
              <b>Kill active on {k.project_id}.</b> Agent work is stopped and admission is closed;
              items stay where they are.
              {k.kill_ids.length > 0 ? ` Kill ${k.kill_ids.join(', ')}.` : ''}
            </p>
          ) : (
            <p>
              <b>Kill switch unreachable: {k.project_id} is treated as killed.</b> No agent work is
              admitted until it answers ({k.message ?? 'no answer'}).
            </p>
          )}
          <Link to="/kill">Kill switch</Link>
        </div>
      ))}
    </>
  );
}

export function NotaryNotice({ notary }: { notary: DegradedView['notary'] }) {
  const pending =
    notary.pending_ops_actions > 0
      ? ` ${notary.pending_ops_actions} operator action(s) are in force and wait to be ledgered; they are backfilled when it answers.`
      : ' Operator actions taken now are in force at once and are ledgered when it answers.';
  if (notary.state === 'down' || notary.state === 'degraded') {
    return (
      <div className="notice notice-bad" role="alert" data-testid="notary-notice">
        <p>
          <b>The Notary is {notary.state === 'down' ? 'unreachable' : 'degraded'}.</b> Decisions
          need its signature, so they are refused until it answers (nothing is decided without it).
          {pending}
        </p>
      </div>
    );
  }
  if (notary.state === 'unknown') {
    return (
      <div className="notice notice-attention" role="status" data-testid="notary-notice">
        <p>
          <b>The Notary&rsquo;s health is unknown</b>
          {notary.detail_code === 'stale' ? ' (its last reading is older than two minutes)' : ''}. A
          decision that cannot be signed is refused, never taken without it.
          {notary.pending_ops_actions > 0 ? pending : ''}
        </p>
      </div>
    );
  }
  if (notary.pending_ops_actions > 0) {
    return (
      <div className="notice notice-attention" role="status" data-testid="notary-notice">
        <p>
          <b>Backfill in progress.</b>
          {pending}
        </p>
      </div>
    );
  }
  return null;
}

export function StaleNotices({
  models,
  names,
}: {
  models: DegradedView['read_models'];
  names: readonly ReadModelName[];
}) {
  const stale = models.filter((m) => m.stale && names.includes(m.name as ReadModelName));
  if (stale.length === 0) return null;
  return (
    <div className="notice notice-attention" role="status" data-testid="stale-notice">
      <p>
        <b>This page may be behind the record.</b>{' '}
        {stale.map((m) => m.reason ?? `the ${m.name} read model is behind`).join('; ')}. What it
        shows is the last state that was read.
      </p>
    </div>
  );
}

/** Every degraded state for the projects on a page, and the read models it is served from. */
export function DegradedBanners({
  projects,
  readModels,
}: {
  projects: readonly string[];
  readModels: readonly ReadModelName[];
}) {
  const key = [...new Set(projects)].sort();
  const q = useQuery({
    queryKey: ['degraded', key],
    queryFn: () => api.degraded(key),
    refetchInterval: 15_000,
  });
  if (q.isPending) return null;
  if (q.isError) {
    return (
      <div className="notice notice-bad" role="alert" data-testid="degraded-unknown">
        <p>
          <b>The factory&rsquo;s state could not be read.</b> Whether a kill is active, the Notary
          answers and this page is current is unknown: treat agent work as stopped.
        </p>
      </div>
    );
  }
  const v = q.data;
  return (
    <div className="degraded">
      <KillNotices kills={v.kills} />
      <NotaryNotice notary={v.notary} />
      <StaleNotices models={v.read_models} names={readModels} />
    </div>
  );
}
