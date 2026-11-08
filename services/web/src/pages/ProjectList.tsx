import { useQuery } from '@tanstack/react-query';
import type { ProjectSummary } from '@aisdlc/contracts';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ErrorNote, Loading } from '../components/Notice';
import { Link } from '../router';
import { STATUS_TEXT, levelTitle } from '../vocab';

export function ProjectRow({ p }: { p: ProjectSummary }) {
  const s0 = p.latest_s0;
  return (
    <li className="card" data-project={p.project.project_id}>
      <div className="card-head">
        <Link to={`/projects/${p.project.project_id}`} className="card-link">
          {p.project.name}
        </Link>
        {s0 ? (
          <Badge tone={STATUS_TEXT[s0.status].tone}>{STATUS_TEXT[s0.status].label}</Badge>
        ) : (
          <Badge tone="neutral">No onboarding</Badge>
        )}
      </div>
      <dl className="facts">
        <div>
          <dt>Repos</dt>
          <dd>{p.repos.length === 0 ? 'none yet' : p.repos.map((r) => r.repo_ref).join(', ')}</dd>
        </div>
        <div>
          <dt>Level</dt>
          <dd>{levelTitle(p.project.level)}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{p.project.tier ?? 'Not signed yet'}</dd>
        </div>
        {s0?.waiting ? (
          <div>
            <dt>Waiting</dt>
            <dd>{s0.waiting}</dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

export function ProjectListPage({ canOnboard }: { canOnboard: boolean }) {
  const q = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 10_000 });
  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        {canOnboard ? (
          <Link to="/onboard" className="btn">
            Onboard a repo
          </Link>
        ) : null}
      </div>
      {q.isPending ? <Loading what="projects" /> : null}
      {q.isError ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? (
        <p>
          No projects yet.{' '}
          {canOnboard ? (
            <Link to="/onboard">Onboard the first repo.</Link>
          ) : (
            'Ask a factory admin to onboard a repo.'
          )}
        </p>
      ) : null}
      {q.data && q.data.length > 0 ? (
        <ul className="cards" aria-label="Projects">
          {q.data.map((p) => (
            <ProjectRow key={p.project.project_id} p={p} />
          ))}
        </ul>
      ) : null}
    </>
  );
}
