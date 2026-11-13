import { pdpResource } from '@aisdlc/contracts';
import { BreakersPanel } from './BreakersPanel';
import { useQuery } from '@tanstack/react-query';
import { useCan } from '../access';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { AskForWorkButton } from '../items/AskForWorkButton';
import { Link } from '../router';
import { Card } from '../ui';
import { STATUS_TEXT, levelTitle } from '../vocab';
import { DriftBanner } from './DriftPage';
import { AreaLevels } from './AreaLevels';

/**
 * The project's settings that are not settings (prototype: Settings, "Not a setting"): the per-area levels
 * (DEC-25) of each repository's active readiness record. Read under `project.view`, like the record itself.
 */
function AreaLevelSettings({ project }: { project: string }) {
  const can = useCan('project.view', pdpResource.project(project));
  const q = useQuery({
    queryKey: ['prr', project],
    queryFn: () => api.prr(project),
    enabled: can.state === 'allow',
  });
  if (can.state !== 'allow') return null;
  if (q.isPending) return <Loading what="the per-area levels" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  return (
    <Card title="Per-area levels (DEC-25)" testId="area-levels">
      <p className="muted">
        Not a setting: a level changes only with a new onboarding version signed at M4, never by M1.
        A repository reaches Full only as a level-up after a Light onboarding.
      </p>
      {q.data.repos.map((r) =>
        r.governing ? (
          <AreaLevels key={r.repo} record={r.governing.record} repo={r.repo} />
        ) : (
          <p key={r.repo} className="muted">
            <code>{r.repo}</code>: no active readiness record yet.
          </p>
        ),
      )}
    </Card>
  );
}

export function ProjectDetailPage({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: 10_000,
  });
  // the after-onboarding banner (M16): a read the person may not have; then there is simply no banner
  const drift = useQuery({
    queryKey: ['drift', id],
    queryFn: () => api.drift(id),
    refetchInterval: 30_000,
    retry: false,
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
      <p className="actions">
        <AskForWorkButton project={project.project_id} />
      </p>
      {drift.data ? <DriftBanner project={project.project_id} repos={drift.data.repos} /> : null}
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
        <Link to={`/projects/${project.project_id}/knowledge`}>Knowledge</Link>
        <Link to={`/projects/${project.project_id}/ledger`}>Ledger entries</Link>
        <Link to={`/projects/${project.project_id}/issues`}>Issue twin</Link>
        <Link to={`/projects/${project.project_id}/drift`}>Drift and readiness</Link>
        <Link to={`/projects/${project.project_id}/learn`}>What it has learned (9.4)</Link>
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

      <h2>Settings</h2>
      <p>
        <Link to={`/projects/${project.project_id}/settings`}>
          This project&rsquo;s gates, who decides them, release and limits
        </Link>{' '}
        <span className="muted">(each change is an M1 decided by the project&rsquo;s admins)</span>
      </p>
      <AreaLevelSettings project={project.project_id} />

      <h2>Breakers</h2>
      <BreakersPanel project={project.project_id} csrf={csrf} />

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
