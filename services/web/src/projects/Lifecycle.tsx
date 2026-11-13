import { useMutation, useQueryClient } from '@tanstack/react-query';
import { label, type Level, type ProjectDetail } from '@aisdlc/contracts';
import { api, type Me } from '../api';
import { describeError } from '../format';
import { useNavigate } from '../router';
import { DeleteObject } from '../admin';
import { Card, Table } from '../ui';

// The onboarded repo's whole life (intent §6; screen-map §3): run onboarding again, sign again, raise the level, and
// delete a repo or the whole project ("delete means delete": the preview says what goes, the person types the name).
// Every act is the server's decision (`project.onboard`, `repo.delete`, `project.delete`); the factory admin's
// override reason travels in its header and is recorded.

export function Lifecycle({ d, me }: { d: ProjectDetail; me: Me }) {
  const csrf = me.csrf_token;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const project = d.project.project_id;

  const again = useMutation({
    mutationFn: async (r: { repo: string; signed: Level | 'none'; to: Level }) => {
      if (r.signed === 'none') {
        // never signed: a new onboarding of the same repo replaces the unfinished one
        const x = await api.onboard(
          { project_id: project as never, repo: r.repo as never, level: r.to },
          csrf,
        );
        return x.s0_id;
      }
      const x = await api.onboardingVersion(
        project,
        { repo: r.repo, reason: r.to === r.signed ? 're_sign' : 'level_up', level: r.to },
        csrf,
      );
      return x.s0_id;
    },
    onSuccess: (s0) => navigate(`/onboard/${s0}`),
  });

  const deleted = async (kind: 'project' | 'repo') => {
    await qc.invalidateQueries({ queryKey: ['projects'] });
    if (kind === 'project') navigate('/projects');
    else await qc.invalidateQueries({ queryKey: ['project', project] });
  };

  return (
    <>
      <Card title="Repos" testId="repos" flush>
        <Table
          caption="Repos of this project"
          captionHidden
          rowKey={(r) => r.repo_id}
          rows={d.repos}
          empty={<p className="ui-help">No repo yet.</p>}
          columns={[
            { key: 'repo', header: 'Repo', rowHeader: true, render: (r) => r.repo_ref },
            {
              key: 'level',
              header: 'Signed level',
              render: (r) =>
                r.onboarding_level === 'none'
                  ? 'Not signed yet'
                  : label('level', r.onboarding_level),
            },
            {
              key: 'acts',
              header: 'Actions',
              render: (r) => {
                const signed = r.onboarding_level;
                return (
                  <div className="ob-acts">
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={again.isPending}
                      onClick={() =>
                        again.mutate({
                          repo: r.repo_ref,
                          signed,
                          to: signed === 'none' ? (d.project.level ?? 'census') : signed,
                        })
                      }
                    >
                      {signed === 'none' ? 'Run onboarding again' : 'Sign again'}
                    </button>
                    {signed !== 'none' && signed !== 'full' ? (
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm"
                        disabled={again.isPending}
                        onClick={() =>
                          again.mutate({
                            repo: r.repo_ref,
                            signed,
                            to: signed === 'census' ? 'light' : 'full',
                          })
                        }
                      >
                        Raise the level
                      </button>
                    ) : null}
                    <DeleteObject
                      kind="repo"
                      id={r.repo_id}
                      name={r.repo_ref}
                      csrf={csrf}
                      small
                      onDeleted={() => void deleted('repo')}
                    />
                  </div>
                );
              },
            },
          ]}
        />
        {again.isError ? (
          <p className="ui-help ui-help-bad" role="alert">
            {describeError(again.error)}
          </p>
        ) : null}
      </Card>
      <Card title="Delete this project">
        <p className="ui-help">
          Removes the project and everything of it from the factory. The repos on GitHub are not
          touched, and the fix PRs stay there.
        </p>
        <DeleteObject
          kind="project"
          id={project}
          name={d.project.name}
          csrf={csrf}
          onDeleted={() => void deleted('project')}
        />
      </Card>
    </>
  );
}
