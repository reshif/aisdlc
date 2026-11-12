import {
  pdpResource,
  type DriftFinding,
  type DriftHistoryRow,
  type Level,
  type PortalProjectDriftView,
  type RepoDriftView,
  type ServedFile,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Guarded } from '../access';
import { api } from '../api';
import { ErrorNote, Loading, PageError } from '../components/Notice';
import { describeError, shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  KeyValue,
  PageHead,
  Pill,
  Table,
  Timeline,
  useToast,
  type Column,
  type PillTone,
  type TimelineKind,
} from '../ui';
import { levelTitle } from '../vocab';

// After onboarding (PLAN M16; OB §4.2, §8; DEC-21; the design reference's project "Drift" tab). Per repo: the
// readiness record's status, the polls (no webhooks: detection latency is the poll interval), what drifted and what
// that does, what the factory serves for each affirmed file, the one-click restore with the bypass re-attestation,
// the level-up and re-sign requests, and the history. The re-affirm card is its own page (the step-up may leave it).
// Every button is a hint from the access layer; the bff and core decide, and core checks the slot and the facts again.

const STATUS_TONE: Record<string, PillTone> = {
  active: 'ok',
  stale: 'warn',
  suspended: 'bad',
  expired: 'warn',
  superseded: 'mute',
  proposed: 'info',
};

const FILE_TEXT: Record<ServedFile['state'], { text: string; tone: PillTone }> = {
  affirmed: { text: 'affirmed text in git', tone: 'ok' },
  pending_projection: { text: 'pack PR not merged yet', tone: 'info' },
  drift: { text: 'drift: serving the affirmed text', tone: 'warn' },
  absent: { text: 'deleted: serving the affirmed text', tone: 'warn' },
};

const KIND_TEXT: Record<DriftFinding['kind'], string> = {
  instruction_text: 'Instruction file',
  pack_file: 'Pack file',
  codeowners: 'CODEOWNERS',
  protect_main: 'protect-main',
  required_check: 'Required check',
};

const short = (h: string | null) => (h ? h.slice(0, 12) : '—');

/** The banner a project shows while one of its repos is suspended, has drifted, or has expired. */
export function DriftBanner({
  project,
  repos,
}: {
  project: string;
  repos: readonly RepoDriftView[];
}) {
  const suspended = repos.filter((r) => r.prr?.status === 'suspended');
  const expired = repos.filter((r) => r.prr?.expired === true);
  const drifted = repos.filter(
    (r) => r.prr?.status !== 'suspended' && r.findings.some((f) => f.effect === 'reaffirm'),
  );
  if (suspended.length + expired.length + drifted.length === 0) return null;
  return (
    <div className="drift-banners">
      {suspended.length > 0 ? (
        <div className="notice notice-bad" role="alert" data-testid="drift-banner-suspended">
          <p>
            <b>Agent lanes are suspended</b> for {suspended.map((r) => r.repo).join(', ')}: a
            control on the default branch was loosened. New work goes to L8 (human-led) and the Push
            Broker refuses agent pushes until a person restores the record.{' '}
            <Link to={`/projects/${project}/drift`}>Restore</Link>
          </p>
        </div>
      ) : null}
      {expired.length > 0 ? (
        <div className="notice notice-attention" role="status" data-testid="drift-banner-expired">
          <p>
            The readiness record of {expired.map((r) => r.repo).join(', ')} has expired: Census-only
            behaviour until it is re-signed. <Link to={`/projects/${project}/drift`}>Re-sign</Link>
          </p>
        </div>
      ) : null}
      {drifted.length > 0 ? (
        <div className="notice notice-attention" role="status" data-testid="drift-banner-drift">
          <p>
            Instruction text changed in {drifted.map((r) => r.repo).join(', ')}: the factory keeps
            serving the affirmed text until a person re-affirms it.{' '}
            <Link to={`/projects/${project}/drift`}>Review</Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Findings({ project, repo }: { project: string; repo: RepoDriftView }) {
  const cols: ReadonlyArray<Column<DriftFinding>> = [
    { key: 'k', header: 'What', rowHeader: true, render: (f) => KIND_TEXT[f.kind] },
    {
      key: 's',
      header: 'Where',
      render: (f) => <span className="ui-mono">{f.subject ?? '—'}</span>,
    },
    { key: 'r', header: 'Why', render: (f) => f.reasons.join(', ') },
    {
      key: 'e',
      header: 'Effect',
      render: (f) =>
        f.effect === 'suspend' ? (
          <Pill tone="bad">suspends the record</Pill>
        ) : (
          <Pill tone="warn">re-affirm</Pill>
        ),
    },
    {
      key: 'a',
      header: '',
      render: (f) =>
        f.effect === 'reaffirm' && f.subject && f.observed ? (
          <Link
            to={`/projects/${project}/reaffirm/${encodeURIComponent(repo.repo)}/${encodeURIComponent(f.subject)}`}
          >
            Open the re-affirm card
          </Link>
        ) : null,
    },
  ];
  return (
    <Table
      caption={`What drifted in ${repo.repo}`}
      columns={cols}
      rows={repo.findings}
      rowKey={(f) => `${f.kind}|${f.subject ?? ''}`}
      empty={<p className="muted">No control or instruction drift at the last poll.</p>}
    />
  );
}

function Files({ repo }: { repo: RepoDriftView }) {
  const cols: ReadonlyArray<Column<ServedFile>> = [
    {
      key: 'p',
      header: 'File',
      rowHeader: true,
      render: (f) => <span className="ui-mono">{f.path}</span>,
    },
    {
      key: 's',
      header: 'State',
      render: (f) => (
        <span data-testid={`file-state-${f.path}`} data-state={f.state}>
          <Pill tone={FILE_TEXT[f.state].tone}>{FILE_TEXT[f.state].text}</Pill>
        </span>
      ),
    },
    {
      key: 'v',
      header: 'Served to agents',
      render: (f) => <span className="ui-mono">{short(f.served_sha256)}</span>,
    },
    {
      key: 'o',
      header: 'In git',
      render: (f) => <span className="ui-mono">{short(f.observed_sha256)}</span>,
    },
  ];
  return (
    <Table
      caption={`Affirmed files of ${repo.repo}`}
      columns={cols}
      rows={repo.files}
      rowKey={(f) => f.path}
      empty={<p className="muted">The record affirmed no instruction or pack file.</p>}
    />
  );
}

function Restore({ project, repo, csrf }: { project: string; repo: RepoDriftView; csrf: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [matches, setMatches] = useState(false);
  const [noApp, setNoApp] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      api.driftRestore(
        project,
        {
          repo: repo.repo,
          bypass: repo.restore.bypass,
          attestation: { bypass_matches_list: true, bypass_has_no_app: true },
        },
        csrf,
      ),
    onSuccess: () => {
      toast('Restored: the record is active again and the agent lanes are open.');
      void qc.invalidateQueries({ queryKey: ['drift', project] });
    },
  });
  const logins = repo.restore.bypass.logins;
  return (
    <Card title="Restore (DEC-21)" testId={`restore-${repo.repo}`}>
      <p className="muted">
        The re-check reads the code host again when you press Restore; it must pass. Then you
        re-attest the bypass list: the factory can never read who may bypass protect-main on GitHub.
        The kill switch is offered, never automatic.
      </p>
      <KeyValue
        label="The bypass list in force"
        rows={[
          [
            'Merge bypass list (codehost.merge_bypass)',
            logins.length === 0 ? (
              'Nobody: an unchecked merge here is unauthorised'
            ) : (
              <span className="ui-mono">{logins.map((l) => `@${l}`).join(', ')}</span>
            ),
          ],
        ]}
      />
      {repo.restore.why_not ? (
        <p className="muted" data-testid="restore-why-not">
          Not yet: {repo.restore.why_not}
        </p>
      ) : null}
      <fieldset className="drift-attest">
        <legend>Bypass re-attestation</legend>
        <label>
          <input type="checkbox" checked={matches} onChange={(e) => setMatches(e.target.checked)} />{' '}
          The bypass actors on the default branch’s rules on GitHub are exactly{' '}
          {logins.length === 0 ? 'nobody' : logins.map((l) => `@${l}`).join(', ')}.
        </label>
        <label>
          <input type="checkbox" checked={noApp} onChange={(e) => setNoApp(e.target.checked)} /> No
          App, the factory’s or any other, is a bypass actor.
        </label>
      </fieldset>
      <Guarded
        action="project.settings.edit"
        resource={pdpResource.project(project)}
        label="Restore"
      >
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!repo.restore.ready || !matches || !noApp || run.isPending}
          onClick={() => run.mutate()}
        >
          Restore
        </button>
      </Guarded>
      {run.isError ? <ErrorNote error={run.error} /> : null}
    </Card>
  );
}

function NewVersion({
  project,
  repo,
  csrf,
}: {
  project: string;
  repo: RepoDriftView;
  csrf: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const ask = useMutation({
    mutationFn: (b: { reason: 'level_up' | 're_sign'; level: Level }) =>
      api.onboardingVersion(project, { repo: repo.repo, ...b }, csrf),
    onSuccess: (r) => {
      toast(
        r.duplicate
          ? 'That onboarding was already requested.'
          : `A new onboarding at ${levelTitle(r.level)} is requested: 0.1 runs again at the current head.`,
      );
      void qc.invalidateQueries({ queryKey: ['drift', project] });
    },
    onError: (e) => toast(describeError(e), 'bad'),
  });
  const prr = repo.prr;
  if (!prr) return null;
  return (
    <Card title={prr.expired ? 'Re-sign' : 'Raise the onboarding level'}>
      {prr.expired ? (
        <>
          <p className="muted">
            The record passed its <span className="ui-mono">fresh_until</span> (
            {shortTime(prr.fresh_until)}): the repo has Census-only behaviour until a new version is
            signed at M4. Expiry never approves anything.
          </p>
          <Guarded action="project.onboard" resource={pdpResource.fleet()} label="Re-sign">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={ask.isPending}
              onClick={() => ask.mutate({ reason: 're_sign', level: prr.level })}
            >
              Re-sign at {levelTitle(prr.level)}
            </button>
          </Guarded>
        </>
      ) : repo.level_up.length === 0 ? (
        <p className="muted">Signed at the highest level.</p>
      ) : (
        <>
          <p className="muted">
            A level-up is a new onboarding version: 0.1 re-runs at the current head, then the cards
            of the new level, 0.4, 0.5 and M4. The signed version stays in force until that M4.
            Per-area levels (DEC-25) come with Full onboarding (M17).
          </p>
          <div className="actions">
            {repo.level_up.map((l) => (
              <Guarded
                key={l}
                action="project.onboard"
                resource={pdpResource.fleet()}
                label={`Request ${levelTitle(l)}`}
              >
                <button
                  type="button"
                  className="ui-btn"
                  disabled={ask.isPending}
                  onClick={() => ask.mutate({ reason: 'level_up', level: l })}
                >
                  Request {levelTitle(l)}
                </button>
              </Guarded>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * M17 (OB §8): a re-onboarding proposal knowledge defects raised in an area is a card for the admin slot. Accept is a
 * ledgered decision that starts a new onboarding from 0.1 at the signed level (cards, 0.4, 0.5 and M4 again); the
 * signed version stays in force until that M4. Decline closes it and changes nothing. Neither changes a level.
 */
function Reonboarding({
  project,
  repo,
  csrf,
}: {
  project: string;
  repo: RepoDriftView;
  csrf: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (b: { proposal_id: string; decision: 'accept' | 'decline' }) =>
      api.reonboardDecide(project, { repo: repo.repo, ...b, reason: reason.trim() }, csrf),
    onSuccess: (r) => {
      toast(
        r.decision === 'accept'
          ? 'Accepted: a new onboarding starts at 0.1; the signed record stays in force until its M4.'
          : 'Declined: the proposal is closed and nothing changed.',
      );
      setReason('');
      void qc.invalidateQueries({ queryKey: ['drift', project] });
    },
    onError: (e) => toast(describeError(e), 'bad'),
  });
  if (repo.reonboarding.length === 0) return null;
  const open = repo.reonboarding.filter((p) => p.status === 'proposed');
  const decided = repo.reonboarding.filter((p) => p.status !== 'proposed');
  return (
    <Card title="Re-onboarding proposed" testId={`reonboard-${repo.repo}`}>
      {open.map((p) => (
        <div key={p.proposal_id} className="drift-reonboard" data-testid="reonboard-open">
          <p>
            {p.count} knowledge defect{p.count === 1 ? '' : 's'} in area{' '}
            <span className="ui-mono">{p.area}</span> within {p.window_days} days (threshold{' '}
            {p.threshold}), proposed {shortTime(p.proposed_at)}.
          </p>
          <p className="muted">
            Accepting starts a new onboarding from 0.1 at the signed level: the cards, 0.4, 0.5 and
            M4 again. The signed record stays in force until that M4. A proposal never changes a
            level.
          </p>
          <label>
            Reason{' '}
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason for the decision"
            />
          </label>
          <div className="actions">
            <Guarded
              action="project.settings.edit"
              resource={pdpResource.project(project)}
              label="Accept"
            >
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={decide.isPending || reason.trim().length === 0}
                onClick={() => decide.mutate({ proposal_id: p.proposal_id, decision: 'accept' })}
              >
                Accept: re-onboard
              </button>
            </Guarded>
            <Guarded
              action="project.settings.edit"
              resource={pdpResource.project(project)}
              label="Decline"
            >
              <button
                type="button"
                className="ui-btn"
                disabled={decide.isPending || reason.trim().length === 0}
                onClick={() => decide.mutate({ proposal_id: p.proposal_id, decision: 'decline' })}
              >
                Decline
              </button>
            </Guarded>
          </div>
        </div>
      ))}
      {decided.length > 0 ? (
        <ul className="muted" data-testid="reonboard-decided">
          {decided.map((p) => (
            <li key={p.proposal_id}>
              <span className="ui-mono">{p.area}</span>: {p.status}
              {p.decision ? ` by ${p.decision.by} (${shortTime(p.decision.at)})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

const HISTORY_KIND: Record<DriftHistoryRow['type'], TimelineKind> = {
  evaluated: 'det',
  suspended: 'bad',
  restored: 'human',
  reaffirmed: 'human',
  version_requested: 'human',
  expired: 'det',
  activated: 'gate',
};

function RepoDrift({
  project,
  repo,
  csrf,
}: {
  project: string;
  repo: RepoDriftView;
  csrf: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const poll = useMutation({
    mutationFn: () => api.driftRecheck(project, repo.repo, csrf),
    onSuccess: () => {
      toast('Polled: the head, the rules and the affirmed files were read and recorded.');
      void qc.invalidateQueries({ queryKey: ['drift', project] });
    },
    onError: (e) => toast(describeError(e), 'bad'),
  });
  const prr = repo.prr;
  return (
    <section aria-label={`Drift of ${repo.repo}`} className="drift-repo">
      <div className="twin-repo-hd">
        <h2 className="ui-mono">{repo.repo}</h2>
        <Guarded action="config.propose" resource={pdpResource.project(project)} label="Poll now">
          <button
            type="button"
            className="ui-btn"
            disabled={poll.isPending}
            onClick={() => poll.mutate()}
          >
            Poll now
          </button>
        </Guarded>
      </div>
      {!prr ? (
        <EmptyState title="No readiness record governs this repo">
          <p className="muted">Drift is watched once an M4 sign-off makes a record active.</p>
        </EmptyState>
      ) : (
        <>
          <KeyValue
            label={`Readiness of ${repo.repo}`}
            rows={[
              [
                'Status',
                <span
                  key="s"
                  data-testid="prr-status"
                  data-status={prr.expired ? 'expired' : prr.status}
                >
                  <Pill tone={STATUS_TONE[prr.expired ? 'expired' : prr.status] ?? 'neutral'}>
                    {prr.expired ? 'expired' : prr.status}
                  </Pill>
                </span>,
              ],
              ['Signed level', `${levelTitle(prr.level)} (version ${prr.version})`],
              ['Fresh until', shortTime(prr.fresh_until)],
              [
                'Default branch head',
                <span key="h" className="ui-mono">
                  {short(repo.head_sha)}
                </span>,
              ],
              [
                'Affirmed files polled',
                repo.files_polled_at ? shortTime(repo.files_polled_at) : 'not yet',
              ],
              ['Rules polled', repo.rules_polled_at ? shortTime(repo.rules_polled_at) : 'not yet'],
            ]}
          />
          <Card title="What drifted" flush>
            <Findings project={project} repo={repo} />
          </Card>
          <Card title="What the factory serves" flush>
            <Files repo={repo} />
          </Card>
          {prr.status === 'suspended' && !prr.expired ? (
            <Restore project={project} repo={repo} csrf={csrf} />
          ) : null}
          <Reonboarding project={project} repo={repo} csrf={csrf} />
          <NewVersion project={project} repo={repo} csrf={csrf} />
          <Card title="History">
            {repo.history.length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <Timeline
                label={`History of ${repo.repo}`}
                events={repo.history.map((h, i) => ({
                  id: `${h.at}-${i}`,
                  when: shortTime(h.at),
                  kind: HISTORY_KIND[h.type],
                  title: h.summary,
                  ...(h.by || h.ledger_entry_id
                    ? {
                        meta: [
                          h.by ? `by ${h.by}` : null,
                          h.ledger_entry_id ? `ledger ${h.ledger_entry_id.slice(0, 8)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      }
                    : {}),
                }))}
              />
            )}
          </Card>
        </>
      )}
    </section>
  );
}

export function DriftPage({ project, csrf }: { project: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['drift', project],
    queryFn: () => api.drift(project),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <Loading what="drift and readiness" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v: PortalProjectDriftView = q.data;
  return (
    <div className="drift-page">
      <PageHead
        eyebrow={project}
        title="Drift and readiness"
        crumbs={[
          { label: 'Projects', to: '/' },
          { label: project, to: `/projects/${project}` },
          { label: 'Drift' },
        ]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        sub="No webhooks: the factory polls, records what it saw, and only tightens on its own. A loosened control suspends the record; lifting it is a person’s one-click restore with the bypass re-attestation."
      />
      <DriftBanner project={project} repos={v.repos} />
      {v.repos.length === 0 ? (
        <EmptyState title="No repo yet">
          <p className="muted">The project has no registered repo.</p>
        </EmptyState>
      ) : (
        v.repos.map((r) => <RepoDrift key={r.repo} project={project} repo={r} csrf={csrf} />)
      )}
      <Card title="What a loosened control does">
        <ul className="plain">
          <li>
            <b>Suspension.</b> protect-main loosened, a required check removed or unpinned from its
            App, CODEOWNERS gone, broken or changed: the record goes suspended; agent lanes close
            and new items go L8 through the 1.4 rule.
          </li>
          <li>
            <b>In flight.</b> The Push Broker refuses agent pushes; human-led L8 is not stopped.
          </li>
          <li>
            <b>Instruction drift</b> never suspends: the last affirmed text keeps being served and a
            re-affirm card opens.
          </li>
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- the re-affirm card

export function ReaffirmPage({
  project,
  repo,
  path,
  csrf,
}: {
  project: string;
  repo: string;
  path: string;
  csrf: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['reaffirm', project, repo, path],
    queryFn: () => api.driftReaffirmView(project, repo, path),
  });
  const [proof, setProof] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  // back from the identity provider: collect the proof of the step-up, once
  const collected = useRef(false);
  useEffect(() => {
    if (collected.current) return;
    const attempt = new URLSearchParams(window.location.search).get('step_up');
    if (!attempt) return;
    collected.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    api
      .stepUpCollect(attempt)
      .then((got) => {
        setProof(got.proof);
        setNote('Your identity is confirmed. Re-affirm below.');
      })
      .catch(() => setNote('The identity confirmation could not be collected. Confirm again.'));
  }, []);

  const send = useMutation({
    mutationFn: (p: { text_sha256: string; proof: string }) =>
      api.driftReaffirm(
        project,
        { repo, path, text_sha256: p.text_sha256, step_up: { proof: p.proof } },
        csrf,
      ),
    onSuccess: () => {
      setDone(true);
      toast('Re-affirmed: agents now receive this text as guidance.');
      void qc.invalidateQueries({ queryKey: ['drift', project] });
    },
    onError: (e) => setProblem(e),
  });

  if (q.isPending) return <Loading what="the re-affirm card" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const bound = v.bound_hash;

  async function confirmIdentity() {
    if (!bound) return;
    setProblem(null);
    try {
      const got = await api.stepUpStart(
        { subject_hash: bound, return_to: window.location.pathname },
        csrf,
      );
      if (got.status === 'redirect') {
        window.location.assign(got.authorize_url);
        return;
      }
      setProof(got.proof);
      setNote('Your identity is confirmed. Re-affirm below.');
    } catch (e) {
      setProblem(e);
    }
  }

  return (
    <div className="drift-page">
      <PageHead
        eyebrow={`${repo} · ${path}`}
        title="Re-affirm instruction text"
        crumbs={[
          { label: 'Projects', to: '/' },
          { label: project, to: `/projects/${project}` },
          { label: 'Drift', to: `/projects/${project}/drift` },
          { label: 'Re-affirm' },
        ]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        sub="The file changed on the default branch. Until a person re-affirms it, agents keep receiving the last affirmed text as guidance and the new text only as data. A GitHub review never affirms."
      />
      <KeyValue
        label="What is compared"
        rows={[
          [
            'Head',
            <span key="h" className="ui-mono">
              {short(v.head_sha)}
            </span>,
          ],
          [
            'Affirmed text',
            <span key="a" className="ui-mono">
              {short(v.affirmed_sha256)}
            </span>,
          ],
          [
            'Text in git',
            <span key="r" className="ui-mono">
              {short(v.repo_sha256)}
            </span>,
          ],
        ]}
      />
      <div className="drift-diff">
        <Card title="Affirmed (served now)">
          {v.affirmed_text === null ? (
            <p className="muted">The record holds this text by hash only.</p>
          ) : (
            <pre className="ui-mono" aria-label="Affirmed text">
              {v.affirmed_text}
            </pre>
          )}
        </Card>
        <Card title="In git now (data until affirmed)">
          {v.secret_hit ? (
            <p className="notice notice-bad" role="alert">
              The shared secret ruleset hit this text: it is not shown and cannot be affirmed.
            </p>
          ) : v.repo_text === null ? (
            <p className="muted">The file is gone at the head.</p>
          ) : (
            <pre className="ui-mono" aria-label="Text in git">
              {v.repo_text}
            </pre>
          )}
        </Card>
      </div>
      {v.lint.length > 0 ? (
        <Card title="Content lint">
          <ul className="plain" aria-label="Lint findings">
            {v.lint.map((l) => (
              <li key={`${l.rule}-${l.line}`}>
                <Pill tone={l.severity === 'blocking' ? 'bad' : 'warn'}>{l.severity}</Pill>{' '}
                <span className="ui-mono">{l.rule}</span> line {l.line}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {v.why_not ? (
        <p className="notice notice-attention" role="status">
          {v.why_not}
        </p>
      ) : done ? (
        <p className="notice notice-good" role="status">
          Re-affirmed. <Link to={`/projects/${project}/drift`}>Back to drift</Link>
        </p>
      ) : (
        <div className="actions">
          {note ? <p role="status">{note}</p> : null}
          <Guarded
            action="project.settings.edit"
            resource={pdpResource.project(project)}
            label="Re-affirm (with the step-up)"
          >
            {proof === null ? (
              <button type="button" className="ui-btn" onClick={() => void confirmIdentity()}>
                Confirm your identity
              </button>
            ) : (
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={send.isPending || !bound}
                onClick={() => bound && send.mutate({ text_sha256: bound, proof })}
              >
                Re-affirm (with the step-up)
              </button>
            )}
          </Guarded>
        </div>
      )}
      {problem ? <ErrorNote error={problem} /> : null}
    </div>
  );
}
