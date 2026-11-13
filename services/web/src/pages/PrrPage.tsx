import { useQuery } from '@tanstack/react-query';
import { AutonomyValues, type Autonomy, type PrrVersionView } from '@aisdlc/contracts';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { Hash } from '../cards/shared';
import { shortTime } from '../format';
import { Link } from '../router';
import { AreaLevels } from './AreaLevels';

const rank = (a: Autonomy): number => AutonomyValues.indexOf(a);

/** Which caps bind the effective autonomy (the lowest wins); none: it is held by probation. */
export function bindingCaps(
  a: Readonly<{
    tier_cap: Autonomy;
    level_cap: Autonomy;
    readiness_cap: Autonomy;
    posture_cap: Autonomy | null;
    effective: Autonomy;
  }>,
): string[] {
  const caps: Array<[string, Autonomy | null]> = [
    ['tier', a.tier_cap],
    ['level', a.level_cap],
    ['readiness', a.readiness_cap],
    ['posture', a.posture_cap],
  ];
  const hits = caps.filter(([, c]) => c !== null && rank(c) === rank(a.effective)).map(([n]) => n);
  return hits.length > 0 ? hits : ['probation'];
}

const STATUS_TONE = {
  proposed: 'attention',
  active: 'good',
  stale: 'attention',
  suspended: 'bad',
  expired: 'bad',
  superseded: 'neutral',
} as const;

const STATUS_TEXT = {
  proposed: 'Proposed: waiting for the M4 sign-off',
  active: 'Active',
  stale: 'Stale: the repository moved on, new work goes human-led',
  suspended: 'Suspended: a control was loosened, new work goes human-led',
  expired: 'Expired: past its fresh-until date, new work goes human-led',
  superseded: 'Superseded by a newer version',
} as const;

const cap = (c: Autonomy | null): string => c ?? 'none (green)';

function Record({ v, repo }: { v: PrrVersionView; repo: string }) {
  const r = v.record;
  const a = r.autonomy;
  const binds = bindingCaps(a);
  const gaps = {
    total: r.gaps.length,
    blocking: r.gaps.filter((g) => g.severity === 'blocking').length,
    waived: r.gaps.filter((g) => g.status === 'waived').length,
    open: r.gaps.filter((g) => g.status === 'open').length,
  };
  return (
    <article
      aria-label={`Readiness record of ${repo}`}
      className="prr"
      data-status={v.effective_status}
    >
      <h2>{repo}</h2>
      <p className="status-line">
        <Badge tone={STATUS_TONE[v.effective_status]}>{v.effective_status}</Badge>{' '}
        <span>{STATUS_TEXT[v.effective_status]}</span>
      </p>
      {v.effective_status !== v.status ? (
        <p className="muted">
          Recorded as {v.status}; it has passed its fresh-until date, so the factory treats it as
          expired.
        </p>
      ) : null}
      <dl className="facts facts-wide">
        <div>
          <dt>Level signed</dt>
          <dd data-testid="prr-level">
            {r.level.signed}
            {r.level.signed !== r.level.requested ? ` (asked for ${r.level.requested})` : ''}
          </dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd data-testid="prr-tier">
            {r.tier.value} (floor {r.tier.floor})
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{r.version}</dd>
        </div>
        <div>
          <dt>Record hash</dt>
          <dd>
            <Hash value={r.record_hash} label="record hash" />
          </dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{shortTime(r.issued_at)}</dd>
        </div>
        <div>
          <dt>Fresh until</dt>
          <dd>{shortTime(r.fresh_until)}</dd>
        </div>
        <div>
          <dt>Review by</dt>
          <dd>{r.review_by ? shortTime(r.review_by) : 'no review date at this level'}</dd>
        </div>
        <div>
          <dt>Made active</dt>
          <dd>{v.activated_at ? shortTime(v.activated_at) : 'not yet'}</dd>
        </div>
      </dl>

      <h3>Pillars</h3>
      <table className="table" aria-label="Pillars">
        <thead>
          <tr>
            <th scope="col">Pillar</th>
            <th scope="col">Level (0 to 4)</th>
          </tr>
        </thead>
        <tbody>
          {r.pillars.map((p) => (
            <tr key={p.pillar}>
              <th scope="row">{p.pillar}</th>
              <td>{p.level}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Composite</th>
            <td data-testid="prr-composite">
              {r.composite} <span className="muted">(the lowest pillar, never an average)</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Per-area levels</h3>
      <p className="muted">
        Levels and floors are judged per area, a part of the repository with its own manifest
        (DEC-25). M4 signed this table with the record.
      </p>
      <AreaLevels record={r} repo={repo} />

      <h3>What the factory may do</h3>
      <p>
        Effective autonomy: <strong data-testid="prr-effective">{a.effective}</strong>. Caps: tier{' '}
        {cap(a.tier_cap)}, level {cap(a.level_cap)}, readiness {cap(a.readiness_cap)}, posture{' '}
        {cap(a.posture_cap)}. Binding: {binds.join(', ')}.
      </p>
      <p>
        Lanes open for agent work:{' '}
        <strong data-testid="prr-lanes">
          {a.lanes_eligible.length === 0 ? 'none' : a.lanes_eligible.join(', ')}
        </strong>
        .
      </p>

      <h3>Gaps</h3>
      <p>
        {gaps.total} gap{gaps.total === 1 ? '' : 's'}: {gaps.open} open, {gaps.blocking} blocking,{' '}
        {gaps.waived} waived.
      </p>
      {r.gaps.length > 0 ? (
        <table className="table" aria-label="Gaps">
          <thead>
            <tr>
              <th scope="col">Gap</th>
              <th scope="col">Severity</th>
              <th scope="col">Disposition</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {r.gaps.map((g) => (
              <tr key={g.gap_id}>
                <th scope="row">
                  <code>{g.gap_id}</code>
                </th>
                <td>{g.severity}</td>
                <td>{g.disposition ?? 'not decided'}</td>
                <td>{g.status.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </article>
  );
}

/** The readiness record of a project (PLAN M8.4): read-only, from the record. */
export function PrrPage({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['prr', project], queryFn: () => api.prr(project) });
  if (q.isPending) return <Loading what="the readiness record" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <p className="crumbs">
        <Link to="/">Projects</Link> / <Link to={`/projects/${project}`}>{project}</Link>
      </p>
      <h1>Readiness record of {project}</h1>
      {q.data.repos.length === 0 ? (
        <p className="muted">This project has no repository yet.</p>
      ) : null}
      {q.data.repos.map((r) => (
        <section key={r.repo} aria-label={r.repo}>
          {r.governing ? (
            <Record v={r.governing} repo={r.repo} />
          ) : (
            <>
              <h2>{r.repo}</h2>
              <p className="muted" data-testid="prr-none">
                No record has been made active for this repository, so new work for it waits. A
                record becomes active only when its M4 sign-off is decided.
              </p>
            </>
          )}
          {r.proposed ? (
            <p className="notice notice-attention">
              Version {r.proposed.version} (
              <Hash value={r.proposed.record_hash} label="proposed record hash" />) is waiting for
              its M4 sign-off. <Link to={`/s0/${r.proposed.s0_id}`}>Open the onboarding</Link>
            </p>
          ) : null}
        </section>
      ))}
      <p>
        <Link to={`/projects/${project}/ledger`}>Ledger entries of this project</Link>
      </p>
    </>
  );
}
