import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { STATUS_TEXT, levelTitle } from '../vocab';

export function ProjectDetailPage({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: 10_000,
  });
  if (q.isPending) return <Loading what="the project" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const { project, repos, s0 } = q.data;
  const latest = s0[0];
  return (
    <>
      <p className="crumbs">
        <Link to="/">Projects</Link>
      </p>
      <h1>{project.name}</h1>
      <dl className="facts facts-wide">
        <div>
          <dt>Project id</dt>
          <dd>
            <code>{project.project_id}</code>
          </dd>
        </div>
        <div>
          <dt>Level</dt>
          <dd>{levelTitle(project.level)}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{project.tier ?? 'Not signed yet'}</dd>
        </div>
        <div>
          <dt>Latest onboarding</dt>
          <dd>
            {latest ? (
              <>
                <Badge tone={STATUS_TEXT[latest.record.status].tone}>
                  {STATUS_TEXT[latest.record.status].label}
                </Badge>{' '}
                <Link to={`/s0/${latest.record.s0_id}`}>open</Link>
              </>
            ) : (
              'None'
            )}
          </dd>
        </div>
      </dl>

      <p className="actions">
        <Link to={`/projects/${project.project_id}/readiness`}>Readiness record</Link>
        <Link to={`/projects/${project.project_id}/ledger`}>Ledger entries</Link>
      </p>

      <h2>Repos</h2>
      {repos.length === 0 ? (
        <p className="muted">No repo yet.</p>
      ) : (
        <ul className="plain" aria-label="Repos">
          {repos.map((r) => (
            <li key={r.repo_id}>
              <code>{r.repo_ref}</code>
              <span className="muted">
                {' '}
                &middot; signed level:{' '}
                {r.onboarding_level === 'none' ? 'none yet' : levelTitle(r.onboarding_level)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Onboarding records</h2>
      {s0.length === 0 ? (
        <p className="muted">No onboarding has been requested.</p>
      ) : (
        <ul className="plain" aria-label="Onboarding records">
          {s0.map((o) => (
            <li key={o.record.s0_id}>
              <Link to={`/s0/${o.record.s0_id}`}>
                {levelTitle(o.record.requested_level)} onboarding, {shortTime(o.record.created_at)}
              </Link>{' '}
              <Badge tone={STATUS_TEXT[o.record.status].tone}>
                {STATUS_TEXT[o.record.status].label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
