import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { explain, label, type Level } from '@aisdlc/contracts';
import { useId, useState, type FormEvent } from 'react';
import { api, type OnboardInput } from '../api';
import { describeError } from '../format';
import { Link, useNavigate } from '../router';
import { Card, EmptyState, PageHeader, Stepper } from '../ui';
import './onboard.css';

// Onboard a repo, step 1 (screen-map §2.10): pick a repo the factory's GitHub App can see and the level wanted; the
// onboarding agent starts by itself once the factory has read the repo. Whether the person may onboard is the
// server's call (`project.onboard`); the page says so before they try.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** The project's short name a repo name suggests: lower case, anything else a dash. */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');

/** A first onboarding asks for Read only or Small changes; All work is a level-up of a repo at Small changes. */
const FIRST_LEVELS: readonly Level[] = ['census', 'light'];

export const ONBOARD_STEPS = (current: number) =>
  ['Pick a repo', 'Agent works', 'One summary', 'Sign off'].map((l, i) => ({
    id: String(i + 1),
    label: l,
    state:
      i < current ? ('done' as const) : i === current ? ('current' as const) : ('todo' as const),
  }));

export function OnboardStart({ csrf, mayOnboard }: { csrf: string; mayOnboard: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ids = { owner: useId(), name: useId(), slug: useId(), level: useId() };
  const asked = (() => {
    try {
      const r = new URLSearchParams(window.location.search).get('repo') ?? '';
      const [o, n] = r.split('/');
      return o && n && OWNER.test(o) && NAME.test(n) ? `${o}/${n}` : '';
    } catch {
      return '';
    }
  })();
  const repos = useQuery({ queryKey: ['onboard-repos'], queryFn: api.onboardRepos, retry: false });
  const [repo, setRepo] = useState(asked);
  const [typed, setTyped] = useState(false);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>('census');
  const [problem, setProblem] = useState<string | null>(null);
  const full = typed ? `${owner.trim()}/${name.trim()}` : repo;
  const repoName = full.split('/')[1] ?? '';
  const project = slug ?? slugOf(repoName);

  const m = useMutation({
    mutationFn: (input: OnboardInput) => api.onboard(input, csrf),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/onboard/${r.s0_id}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const [o, n] = full.split('/');
    if (!o || !n || !OWNER.test(o) || !NAME.test(n)) {
      setProblem('Choose a repo, or type its owner and name.');
      return;
    }
    if (!SLUG.test(project)) {
      setProblem('The project name may hold lower-case letters, digits, dashes and underscores.');
      return;
    }
    setProblem(null);
    m.mutate({
      project_id: project as OnboardInput['project_id'],
      repo: full as OnboardInput['repo'],
      level,
    });
  }

  const list = repos.data?.repos ?? [];
  return (
    <>
      <PageHeader
        title="Onboard a repo"
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: 'Onboard a repo' }]}
        renderLink={(to, l) => <Link to={to}>{l}</Link>}
        meta="Pick a repo. The onboarding agent reads it, proposes fixes as pull requests, and you sign off once."
      />
      <Stepper label="Onboarding steps" steps={ONBOARD_STEPS(0)} />
      {!mayOnboard ? (
        <p className="ui-help" role="note" data-testid="may-not-onboard">
          You do not have the right to onboard a repo. You can still try; the factory decides and
          tells you why if it says no.
        </p>
      ) : null}
      <form onSubmit={submit} noValidate aria-label="Onboard a repo">
        <Card title="1. Pick a repo">
          {repos.isPending ? (
            <p className="ui-help">Reading the repos the GitHub App can see…</p>
          ) : null}
          {repos.isError ? (
            <p className="ui-help" role="note">
              The repos the GitHub App can see could not be read ({describeError(repos.error)}).
              Type the repo below.
            </p>
          ) : null}
          {repos.data && list.length === 0 ? (
            <EmptyState title="No repos visible">
              Install the factory&rsquo;s GitHub App on a repo (only select repositories), then come
              back. This list reads again by itself.
            </EmptyState>
          ) : null}
          {list.length > 0 && !typed ? (
            <fieldset className="ob-repos">
              <legend className="ui-label">Repos the GitHub App can see</legend>
              {list.map((r) => {
                const off = r.registered || r.archived;
                return (
                  <div key={r.full_name} className="ob-repo">
                    <input
                      type="radio"
                      name="repo"
                      id={`repo-${r.full_name}`}
                      value={r.full_name}
                      checked={repo === r.full_name}
                      disabled={off}
                      onChange={() => {
                        setRepo(r.full_name);
                        setSlug(null);
                      }}
                    />
                    <label htmlFor={`repo-${r.full_name}`}>
                      {r.full_name}
                      <span className="ui-help">
                        {r.private ? 'Private' : 'Public'}
                        {r.registered ? ' · already a project' : r.archived ? ' · archived' : ''}
                      </span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          <p>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => setTyped(!typed)}
            >
              {typed ? 'Choose from the list' : 'The repo is not listed: type it'}
            </button>
          </p>
          {typed ? (
            <div className="ob-row">
              <div>
                <label className="ui-label" htmlFor={ids.owner}>
                  Repository owner
                </label>
                <input
                  id={ids.owner}
                  className="ui-input"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="ui-label" htmlFor={ids.name}>
                  Repository name
                </label>
                <input
                  id={ids.name}
                  className="ui-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="How much agents may do">
          <fieldset>
            <legend className="ui-sr">Onboarding level</legend>
            {FIRST_LEVELS.map((l) => (
              <div className="ob-repo" key={l}>
                <input
                  type="radio"
                  name="level"
                  id={`${ids.level}-${l}`}
                  checked={level === l}
                  onChange={() => setLevel(l)}
                  aria-describedby={`${ids.level}-${l}-d`}
                />
                <label htmlFor={`${ids.level}-${l}`}>
                  {label('level', l)}
                  <span className="ui-help" id={`${ids.level}-${l}-d`}>
                    {explain('level', l)}
                  </span>
                </label>
              </div>
            ))}
            <p className="ui-help">
              {label('level', 'full')}: reached later by raising the level of a repo at{' '}
              {label('level', 'light')}.
            </p>
          </fieldset>
          <label className="ui-label" htmlFor={ids.slug}>
            Project name
          </label>
          <input
            id={ids.slug}
            className="ui-input"
            value={project}
            onChange={(e) => setSlug(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${ids.slug}-d`}
          />
          <p className="ui-help" id={`${ids.slug}-d`}>
            Lower-case letters, digits and dashes. Used when this creates the project.
          </p>
        </Card>
        {problem ? (
          <p className="ui-help ui-help-bad" role="alert">
            {problem}
          </p>
        ) : null}
        {m.isError ? (
          <p className="ui-help ui-help-bad" role="alert">
            {describeError(m.error)}
          </p>
        ) : null}
        <button type="submit" className="ui-btn ui-btn-primary" disabled={m.isPending}>
          {m.isPending ? 'Starting…' : 'Start onboarding'}
        </button>
      </form>
    </>
  );
}
