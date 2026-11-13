import { useQuery } from '@tanstack/react-query';
import { label, lookupTerm } from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { api } from '../api';
import { ErrorNote } from '../components/Notice';
import { Link } from '../router';
import { EmptyState, PageHeader, Pill, Table } from '../ui';
import '../onboard/onboard.css';

// Projects (screen-map §2.7): every project the person may see, with its repo, level, risk and onboarding at a glance.
// The bff lists only what the PDP lets the person view (a private project is simply not there).

export function ProjectsPage({ canOnboard }: { canOnboard: boolean }) {
  const q = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 10_000 });
  const [find, setFind] = useState('');
  const id = useId();
  const rows = (q.data ?? []).filter((p) => {
    const f = find.trim().toLowerCase();
    return (
      f === '' ||
      p.project.name.toLowerCase().includes(f) ||
      p.project.project_id.includes(f) ||
      p.repos.some((r) => r.repo_ref.toLowerCase().includes(f))
    );
  });
  return (
    <>
      <PageHeader
        title="Projects"
        meta="The onboarded repos you may see."
        actions={
          canOnboard ? (
            <Link to="/onboard" className="ui-btn ui-btn-primary">
              Onboard a repo
            </Link>
          ) : null
        }
      />
      {q.isPending ? <p className="ui-help">Reading the projects…</p> : null}
      {q.isError ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            canOnboard ? (
              <Link to="/onboard" className="ui-btn ui-btn-primary">
                Onboard a repo
              </Link>
            ) : undefined
          }
        >
          {canOnboard ? 'Onboard a repo to start.' : 'Ask a factory admin to onboard a repo.'}
        </EmptyState>
      ) : null}
      {q.data && q.data.length > 0 ? (
        <>
          <label className="ui-label" htmlFor={id}>
            Find a project
          </label>
          <input
            id={id}
            className="ui-input"
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
          <Table
            caption="Projects"
            captionHidden
            rowKey={(p) => p.project.project_id}
            rows={rows}
            empty={<p className="ui-help">No project matches.</p>}
            columns={[
              {
                key: 'name',
                header: 'Project',
                rowHeader: true,
                render: (p) => (
                  <Link
                    to={`/projects/${p.project.project_id}`}
                    data-project={p.project.project_id}
                  >
                    {p.project.name}
                  </Link>
                ),
              },
              {
                key: 'repo',
                header: 'Repo',
                render: (p) =>
                  p.repos.length === 0 ? 'None yet' : p.repos.map((r) => r.repo_ref).join(', '),
              },
              {
                key: 'level',
                header: 'Level',
                render: (p) => (p.project.level ? label('level', p.project.level) : 'None yet'),
              },
              {
                key: 'tier',
                header: 'Risk',
                render: (p) => (p.project.tier ? label('tier', p.project.tier) : 'Not signed yet'),
              },
              {
                key: 'onboarding',
                header: 'Onboarding',
                render: (p) =>
                  p.latest_s0 ? (
                    <Link to={`/onboard/${p.latest_s0.s0_id}`}>
                      <Pill tone={p.latest_s0.status === 'done' ? 'ok' : 'info'}>
                        {lookupTerm('onboarding', p.latest_s0.status)?.label ?? 'Unknown'}
                      </Pill>
                    </Link>
                  ) : (
                    'None'
                  ),
              },
            ]}
          />
        </>
      ) : null}
    </>
  );
}
