import { useMutation, useQueryClient } from '@tanstack/react-query';
import { label, type DeletionPreview, type Level, type ProjectDetail } from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { api, type Me } from '../api';
import { describeError } from '../format';
import { useNavigate } from '../router';
import { Card, ConfirmDelete, KeyValue, Table } from '../ui';
import { onboardApi } from '../onboard/api';

// The onboarded repo's whole life (intent §6; screen-map §3): run onboarding again, sign again, raise the level, and
// delete a repo or the whole project ("delete means delete": the preview says what goes, the person types the name).
// Every act is the server's decision (`project.onboard`, `repo.delete`, `project.delete`); the factory admin's
// override reason travels in its header and is recorded.

// TODO(portal v2 merge): replace this delete flow with the People squad's shared `<DeleteObject kind id name csrf
// onDeleted />` from `services/web/src/admin` (v2/screens-people) once it is on main; same routes, same preview.

type Target = { kind: 'project' | 'repo'; id: string; name: string } | null;

export function Lifecycle({ d, me }: { d: ProjectDetail; me: Me }) {
  const csrf = me.csrf_token;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target>(null);
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const reasonId = useId();
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

  async function ask(t: NonNullable<Target>) {
    setError(undefined);
    setNote(null);
    setPreview(null);
    try {
      setPreview(await onboardApi.deletionPreview(t.kind, t.id, csrf));
      setTarget(t);
    } catch (e) {
      setNote(describeError(e));
    }
  }

  const del = useMutation({
    mutationFn: (t: NonNullable<Target>) =>
      onboardApi.remove(t.kind, t.id, { reason: reason.trim(), confirm: t.id }, csrf),
    onSuccess: async (_r, t) => {
      setTarget(null);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      if (t.kind === 'project') navigate('/projects');
      else await qc.invalidateQueries({ queryKey: ['project', project] });
    },
    onError: (e) => setError(describeError(e)),
  });

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
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-danger"
                      onClick={() => void ask({ kind: 'repo', id: r.repo_id, name: r.repo_ref })}
                    >
                      {label('concept', 'delete')} repo {r.repo_ref}
                    </button>
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
        <button
          type="button"
          className="ui-btn ui-btn-danger"
          onClick={() => void ask({ kind: 'project', id: project, name: d.project.name })}
        >
          {label('concept', 'delete')} project {d.project.name}
        </button>
        {note ? (
          <p className="ui-help ui-help-bad" role="alert">
            {note}
          </p>
        ) : null}
      </Card>
      {target && preview ? (
        <ConfirmDelete
          open
          kind={target.kind}
          name={target.id}
          busy={del.isPending}
          {...(error ? { error } : {})}
          onClose={() => setTarget(null)}
          onConfirm={() => del.mutate(target)}
          consequences={
            <>
              {preview.blockers.length > 0 ? (
                <p className="ui-help ui-help-bad" role="alert">
                  {preview.blockers.map((b) => b.message).join(' ')}
                </p>
              ) : null}
              <KeyValue
                rows={[
                  ['Record entries removed', preview.counts.record_events_removed],
                  ['Record entries redacted', preview.counts.record_events_redacted],
                  ['Stored files removed', preview.counts.objects],
                  [
                    'Decision log entries kept as hashes only',
                    preview.counts.ledger_entries_redacted,
                  ],
                ]}
              />
              <label className="ui-label" htmlFor={reasonId}>
                Why (recorded)
              </label>
              <input
                id={reasonId}
                className="ui-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="ui-help">Type {target.id} below to confirm.</p>
            </>
          }
        />
      ) : null}
    </>
  );
}
