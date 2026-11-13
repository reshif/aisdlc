import { useQuery } from '@tanstack/react-query';
import {
  pdpResource,
  type GateRequirement,
  type GithubAppRow,
  type GithubAppsView,
  type OnboardRepo,
} from '@aisdlc/contracts';
import { Guarded } from '../access';
import { api } from '../api';
import { describeError, shortTime } from '../format';
import { Link } from '../router';
import { Card, Pill, Table, type PillTone } from '../ui';
import { LEVEL_TEXT } from '../vocab';

// P2-4 (docs/design/portal-review.md): the GitHub Apps panel of the Integrations page, read only. Each App the
// deployment uses, what its installation grants against what its jobs need, whether its key loaded (never the key),
// its last good answer, and whether the registered repos' default branches require `aisdlc/gate` from gate-check's
// App; then the repos the factory App can see and where each stands. Creating or rotating an App is the command
// line's (`./setup-github-apps`): keys never pass through the portal.

const JOB_TEXT: Readonly<Record<string, string>> = {
  read: 'read (Census, bundle)',
  push: 'push (agent branches, Draft PRs)',
  tracker: 'tracker issues',
  'gate-relay': 'gate-relay deployments',
  'gate-check': 'gate-check (aisdlc/gate)',
};

const GATE_TEXT: Readonly<Record<GateRequirement, { text: string; tone: PillTone }>> = {
  required: { text: 'required from gate-check', tone: 'ok' },
  other_source: { text: 'required, but not pinned to gate-check', tone: 'bad' },
  not_required: { text: 'not required', tone: 'bad' },
  unknown: { text: 'unknown', tone: 'mute' },
};

const perms = (p: Readonly<Record<string, string>>): string =>
  Object.entries(p)
    .map(([n, l]) => `${n}:${l}`)
    .join(', ') || 'none';

function Grant({ a }: { a: GithubAppRow }) {
  if (a.installation.state !== 'ok') {
    return <Pill tone="mute">unknown ({a.installation.reason})</Pill>;
  }
  const c = a.comparison;
  return (
    <>
      <div>{perms(a.installation.permissions)}</div>
      {c?.ok ? (
        <Pill tone="ok">exactly as required</Pill>
      ) : (
        <>
          {c && c.forbidden.length > 0 ? (
            <div>
              <Pill tone="bad">forbidden</Pill> {c.forbidden.join(', ')}
            </div>
          ) : null}
          {c && c.extra.length > 0 ? (
            <div>
              <Pill tone="warn">extra</Pill> {c.extra.join(', ')}
            </div>
          ) : null}
          {c && c.missing.length > 0 ? (
            <div>
              <Pill tone="warn">missing</Pill> {c.missing.join(', ')}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function AppsTable({ v }: { v: GithubAppsView }) {
  return (
    <Table
      caption="GitHub Apps"
      captionHidden
      columns={[
        {
          key: 'app',
          header: 'App',
          rowHeader: true,
          render: (a) => (
            <>
              <b>{a.kind === 'factory' ? 'factory' : 'gate-check'}</b>
              <div className="muted">App ID {a.app_id ?? 'unknown'}</div>
              <div className="muted">{a.login ?? ''}</div>
            </>
          ),
        },
        {
          key: 'jobs',
          header: 'Jobs',
          render: (a) => a.jobs.map((j) => JOB_TEXT[j] ?? j).join('; '),
        },
        {
          key: 'inst',
          header: 'Installation',
          render: (a) =>
            a.installation.state === 'ok' ? (
              <>
                {a.installation_id ?? '?'} · {a.installation.account_login}
                <div>
                  {a.installation.repository_selection === 'selected' ? (
                    <Pill tone="ok">selected repositories</Pill>
                  ) : (
                    <Pill tone="bad">all repositories</Pill>
                  )}
                  {a.installation.suspended ? <Pill tone="bad">suspended</Pill> : null}
                </div>
              </>
            ) : (
              <>
                {a.installation_id ?? 'unknown'} <Pill tone="mute">not read</Pill>
              </>
            ),
        },
        { key: 'req', header: 'Required', render: (a) => perms(a.required) },
        { key: 'grant', header: 'Granted', render: (a) => <Grant a={a} /> },
        {
          key: 'key',
          header: 'Key',
          render: (a) =>
            a.key_loaded ? <Pill tone="ok">loaded</Pill> : <Pill tone="bad">not loaded</Pill>,
        },
        {
          key: 'last',
          header: 'Last good call',
          render: (a) => (a.last_ok_at ? shortTime(a.last_ok_at) : 'none yet'),
        },
      ]}
      rows={v.apps}
      rowKey={(a) => `${a.kind}:${a.app_id ?? a.jobs.join(',')}`}
      empty={<p className="muted">No service reported a GitHub App.</p>}
    />
  );
}

export function GithubAppsCard() {
  const q = useQuery({ queryKey: ['github-apps'], queryFn: api.githubApps, retry: false });
  return (
    <Card title="GitHub Apps">
      {q.isPending ? (
        <p className="muted">Asking the services that hold the App keys…</p>
      ) : q.isError ? (
        <p className="muted" role="note">
          The GitHub Apps could not be read ({describeError(q.error)}).
        </p>
      ) : (
        <>
          {q.data.sources
            .filter((s) => s.state !== 'ok')
            .map((s) => (
              <p key={s.source} className="muted" role="note">
                {s.source}: {s.state === 'unreachable' ? 'did not answer' : 'not configured here'}{' '}
                (what it would report reads unknown)
              </p>
            ))}
          {q.data.apps.some((a) => a.shares_with_pusher) ? (
            <p role="alert">
              <Pill tone="bad">separation of duties</Pill> gate-check shares its App with the
              pushing job: the identity that pushes agent code can write aisdlc/gate.
            </p>
          ) : null}
          <AppsTable v={q.data} />
          <h3>Default branches: aisdlc/gate</h3>
          {q.data.gate_rule.length === 0 ? (
            <p className="muted">No repo is registered yet.</p>
          ) : (
            <ul aria-label="aisdlc/gate on the default branch">
              {q.data.gate_rule.map((g) => (
                <li key={g.repo}>
                  <code>{g.repo}</code> {g.branch ?? '(branch unknown)'}:{' '}
                  <Pill tone={GATE_TEXT[g.state].tone}>{GATE_TEXT[g.state].text}</Pill>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Create or replace the Apps on the factory host with <code>{q.data.setup_command}</code>{' '}
            (docs/getting-started.md §4). The factory never changes branch protection: requiring
            aisdlc/gate is done on GitHub.
          </p>
        </>
      )}
    </Card>
  );
}

function RepoStatus({ r }: { r: OnboardRepo }) {
  const o = r.onboarding;
  if (!o || o.state === 'unknown') return <Pill tone="mute">unknown</Pill>;
  if (o.state === 'archived') return <Pill tone="mute">archived</Pill>;
  if (o.state === 'not_onboarded') return <Pill>not onboarded</Pill>;
  if (o.state === 'onboarding') {
    return (
      <>
        <Pill tone="info">onboarding ({o.status})</Pill>
        {o.waiting ? <div className="muted">{o.waiting}</div> : null}
      </>
    );
  }
  return (
    <>
      <Pill tone="ok">onboarded</Pill>{' '}
      {o.level === null ? 'level unknown' : LEVEL_TEXT[o.level].title}
      <div className="muted">
        lanes: {o.lanes === null ? 'unknown' : o.lanes.length > 0 ? o.lanes.join(', ') : 'none'}
      </div>
    </>
  );
}

function RepoAction({ r }: { r: OnboardRepo }) {
  const o = r.onboarding;
  if (!o) return null;
  if (o.state === 'not_onboarded') {
    return (
      <Guarded action="project.onboard" resource={pdpResource.fleet()} label="Onboard">
        <Link to={`/onboard?repo=${encodeURIComponent(r.full_name)}`} className="ui-btn">
          Onboard
        </Link>
      </Guarded>
    );
  }
  if (o.state === 'onboarding') return <Link to={`/s0/${encodeURIComponent(o.s0_id)}`}>Open</Link>;
  if (o.state === 'onboarded') {
    return <Link to={`/projects/${encodeURIComponent(o.project_id)}`}>Open project</Link>;
  }
  return null;
}

export function RepositoriesCard() {
  const q = useQuery({ queryKey: ['onboard-repos'], queryFn: api.onboardRepos, retry: false });
  return (
    <Card title="Repositories the factory App can see" flush>
      {q.isPending ? (
        <p className="muted">Reading the App installation&rsquo;s repos…</p>
      ) : q.isError ? (
        <p className="muted" role="note">
          The installation&rsquo;s repos could not be read ({describeError(q.error)}).
        </p>
      ) : (
        <Table
          caption="Repositories"
          captionHidden
          columns={[
            {
              key: 'r',
              header: 'Repository',
              rowHeader: true,
              render: (r) => (
                <>
                  <code>{r.full_name}</code>
                  {r.private ? <span className="muted"> (private)</span> : null}
                </>
              ),
            },
            { key: 's', header: 'Status', render: (r) => <RepoStatus r={r} /> },
            { key: 'a', header: 'Action', render: (r) => <RepoAction r={r} /> },
          ]}
          rows={q.data.repos}
          rowKey={(r) => r.full_name}
          empty={<p className="muted">The App installation sees no repo yet.</p>}
        />
      )}
    </Card>
  );
}
