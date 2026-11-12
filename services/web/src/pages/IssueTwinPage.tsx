import {
  gapMarker,
  pdpResource,
  type IssueTwinCandidate,
  type IssueTwinDisposition,
  type IssueTwinRepoView,
  type IssueTwinRowView,
  type IssueTwinState,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Guarded } from '../access';
import { api } from '../api';
import { ErrorNote, Loading, PageError } from '../components/Notice';
import { describeError, shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  Modal,
  PageHead,
  Pill,
  Stat,
  Stats,
  Table,
  useToast,
  type Column,
  type PillTone,
} from '../ui';

// The GitHub issue twin (PLAN M16; design reference `issues`; OB §7; DEC-20(a)). Gaps live in the factory record;
// each GitHub issue is a twin, filed only from a batch a person approved, and its state comes back as a signal that
// never closes a gap by itself. The screen shows, per repo: the twins and their sync state, the approved batches (with
// the hash of the bodies the ledger binds), the security gaps that are never filed, and the "Propose a batch" form
// over the gaps no batch has disposed of. Every button is a hint from the access layer; the bff and core decide.

const STATE_TONE: Record<IssueTwinState, PillTone> = {
  pending: 'mute',
  open: 'info',
  closed_verified: 'ok',
  closed_unverified: 'warn',
  lost: 'bad',
};
const STATE_TEXT: Record<IssueTwinState, string> = {
  pending: 'approved, not filed yet',
  open: 'open',
  closed_verified: 'closed and verified',
  closed_unverified: 'closed, not verified',
  lost: 'lost (deleted or transferred)',
};

function note(t: IssueTwinRowView): string | null {
  if (t.state === 'closed_verified' && t.recheck?.sha)
    return `verified at ${t.recheck.sha.slice(0, 7)}`;
  if (t.state === 'closed_unverified')
    return 'closed by a person; the re-check did not pass; the gap stays open';
  if (t.via === 'reconciled') return 'found by its marker';
  if (t.via === 'linked') return 'a duplicate a person linked';
  return null;
}

function TwinsTable({
  project,
  repo,
  csrf,
}: {
  project: string;
  repo: IssueTwinRepoView;
  csrf: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const make = useMutation({
    mutationFn: (gap_id: string) =>
      api.issueTwinRequest(project, { repo: repo.repo, gap_id }, csrf),
    onSuccess: (r) => {
      toast(
        r.duplicate
          ? 'This gap already has a remediation request.'
          : 'Remediation request made (N6, L2): it goes to G0 like any request.',
      );
      void qc.invalidateQueries({ queryKey: ['issue-twin', project] });
    },
    onError: (e) => toast(describeError(e), 'bad'),
  });
  const cols: ReadonlyArray<Column<IssueTwinRowView>> = [
    {
      key: 'n',
      header: 'Issue',
      rowHeader: true,
      render: (t) =>
        t.number ? <span className="ui-mono">#{t.number}</span> : <span className="muted">—</span>,
    },
    {
      key: 't',
      header: 'Title',
      render: (t) => (
        <>
          <div>{t.title}</div>
          <div className="muted ui-mono">{gapMarker(t.gap_id)}</div>
        </>
      ),
    },
    {
      key: 'l',
      header: 'Label',
      render: (t) => (
        <Pill tone={t.severity === 'blocking' ? 'bad' : 'mute'}>{`gap:${t.severity}`}</Pill>
      ),
    },
    {
      key: 's',
      header: 'Sync',
      render: (t) => (
        <span data-testid={`twin-state-${t.criterion}`} data-state={t.state}>
          <Pill tone={STATE_TONE[t.state]}>{STATE_TEXT[t.state]}</Pill>
          {note(t) ? <div className="muted">{note(t)}</div> : null}
        </span>
      ),
    },
    {
      key: 'r',
      header: 'Remediation',
      render: (t) =>
        t.request ? (
          t.request.item_id ? (
            <Link to={`/items/${t.request.item_id}`}>Open the item</Link>
          ) : (
            <span className="muted">requested (held)</span>
          )
        ) : t.state === 'closed_verified' || t.state === 'lost' ? null : (
          <Guarded
            action="work.request"
            resource={pdpResource.project(project)}
            label="Make a request"
            mode="hide"
          >
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              disabled={make.isPending}
              onClick={() => make.mutate(t.gap_id)}
            >
              Make a request
            </button>
          </Guarded>
        ),
    },
  ];
  return (
    <Card
      title="Issues and their sync state"
      flush
      actions={
        <span className="muted">
          {repo.polled_at ? `last signal ${shortTime(repo.polled_at)}` : 'no signal yet'} · label
          factory:onboarding-gap
        </span>
      }
    >
      <Table
        caption={`Issue twins of ${repo.repo}`}
        captionHidden
        columns={cols}
        rows={repo.twins}
        rowKey={(t) => t.gap_id}
        empty={
          <p className="muted" style={{ padding: 16 }}>
            No twin is filed yet. Gaps stay in the readiness record until a batch is approved.
          </p>
        }
      />
    </Card>
  );
}

function ProposeBatch({
  project,
  repo,
  csrf,
  onClose,
}: {
  project: string;
  repo: IssueTwinRepoView;
  csrf: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, IssueTwinDisposition | 'leave'>>(() =>
    Object.fromEntries(repo.candidates.map((c) => [c.gap_id, c.default])),
  );
  const chosen = repo.candidates
    .map((c) => ({ gap_id: c.gap_id, disposition: rows[c.gap_id] ?? 'leave' }))
    .filter(
      (r): r is { gap_id: string; disposition: IssueTwinDisposition } => r.disposition !== 'leave',
    );
  const send = useMutation({
    mutationFn: () => api.issueTwinBatch(project, { repo: repo.repo, rows: chosen }, csrf),
    onSuccess: (r) => {
      toast(
        `Batch approved: ${r.filed} issue${r.filed === 1 ? '' : 's'} will be filed, ${r.tracked} tracked only.`,
      );
      void qc.invalidateQueries({ queryKey: ['issue-twin', project] });
      onClose();
    },
  });
  const cols: ReadonlyArray<Column<IssueTwinCandidate>> = [
    { key: 'g', header: 'Gap', rowHeader: true, render: (c) => <span>{c.title}</span> },
    {
      key: 'd',
      header: 'Disclosure',
      render: (c) => (
        <Pill tone={c.disclosure === 'pass' ? 'ok' : 'bad'}>
          {c.disclosure === 'pass' ? 'pass' : c.disclosure}
        </Pill>
      ),
    },
    {
      key: 'do',
      header: 'Do',
      render: (c) => (
        <select
          aria-label={`What to do with ${c.criterion}`}
          value={rows[c.gap_id] ?? 'leave'}
          onChange={(e) =>
            setRows((r) => ({ ...r, [c.gap_id]: e.target.value as IssueTwinDisposition | 'leave' }))
          }
        >
          {c.allowed.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
          <option value="leave">not in this batch</option>
        </select>
      ),
    },
  ];
  return (
    <Modal
      open
      title="Propose a batch"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={chosen.length === 0 || send.isPending}
            onClick={() => send.mutate()}
          >
            Approve batch
          </button>
        </>
      }
    >
      <p className="muted">
        Choose per row. Approving records the exact list and the hash of the rendered bodies on the
        ledger; the tracker files exactly that list, once. Security gaps are never filed and are not
        listed.
      </p>
      <Table
        caption={`Gaps of ${repo.repo} no batch has disposed of`}
        columns={cols}
        rows={repo.candidates}
        rowKey={(c) => c.gap_id}
      />
      {send.isError ? <ErrorNote error={send.error} /> : null}
    </Modal>
  );
}

function RepoTwin({
  project,
  repo,
  csrf,
}: {
  project: string;
  repo: IssueTwinRepoView;
  csrf: string;
}) {
  const [proposing, setProposing] = useState(false);
  const count = (s: IssueTwinState) => repo.twins.filter((t) => t.state === s).length;
  const filed = repo.twins.filter((t) => t.number !== null).length;
  const openBlocking = repo.twins.filter(
    (t) => t.state === 'open' && t.severity === 'blocking',
  ).length;
  return (
    <section aria-label={`Issue twin of ${repo.repo}`} className="twin-repo">
      <div className="twin-repo-hd">
        <h2 className="ui-mono">{repo.repo}</h2>
        {repo.prr_version !== null && repo.candidates.length > 0 ? (
          <Guarded
            action="config.propose"
            resource={pdpResource.project(project)}
            label="Propose a batch"
          >
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              onClick={() => setProposing(true)}
            >
              Propose a batch
            </button>
          </Guarded>
        ) : null}
      </div>
      {repo.prr_version === null ? (
        <EmptyState title="No readiness record governs this repo">
          <p className="muted">
            Nothing can be filed until an M4 sign-off makes a readiness record active.
          </p>
        </EmptyState>
      ) : (
        <>
          <Stats label={`Twins of ${repo.repo}`}>
            <Stat
              label="Twins filed"
              value={filed}
              detail={`from ${repo.batches.length} approved batch${repo.batches.length === 1 ? '' : 'es'}`}
            />
            <Stat label="Open" value={count('open')} detail={`${openBlocking} blocking`} />
            <Stat
              label="Closed and verified"
              value={count('closed_verified')}
              tone="ok"
              detail="re-checked at the default branch"
            />
            <Stat
              label="Closed, not verified"
              value={count('closed_unverified')}
              tone="warn"
              detail="gap stays open; not reopened"
            />
            <Stat
              label="Never filed"
              value={repo.private_only.length}
              tone="bad"
              detail="security: private only"
            />
          </Stats>
          <TwinsTable project={project} repo={repo} csrf={csrf} />
          <Card title="Approved batches" flush>
            <Table
              caption={`Approved batches of ${repo.repo}`}
              captionHidden
              columns={[
                {
                  key: 'a',
                  header: 'Approved',
                  rowHeader: true,
                  render: (b) => shortTime(b.approved_at),
                },
                { key: 'by', header: 'By', render: (b) => b.approved_by },
                { key: 'f', header: 'Issues', align: 'right', render: (b) => b.filed },
                { key: 't', header: 'Tracked', align: 'right', render: (b) => b.tracked },
                {
                  key: 'h',
                  header: 'Bodies hash',
                  render: (b) => <code title={b.bodies_hash}>{b.bodies_hash.slice(0, 10)}</code>,
                },
                {
                  key: 'l',
                  header: 'Ledger entry',
                  render: (b) => (
                    <code title={b.ledger_entry_id}>{b.ledger_entry_id.slice(0, 8)}</code>
                  ),
                },
              ]}
              rows={repo.batches}
              rowKey={(b) => b.batch_id}
              empty={
                <p className="muted" style={{ padding: 16 }}>
                  No batch approved yet.
                </p>
              }
            />
          </Card>
          {repo.private_only.length > 0 ? (
            <Card title="Kept in the factory only">
              <p className="muted">
                Security gaps are never filed as issues, on any repo. The security card is their
                channel.
              </p>
              <ul className="plain" aria-label="Security gaps never filed">
                {repo.private_only.map((g) => (
                  <li key={g.gap_id} className="ui-mono">
                    {g.criterion}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
      {proposing ? (
        <ProposeBatch
          project={project}
          repo={repo}
          csrf={csrf}
          onClose={() => setProposing(false)}
        />
      ) : null}
    </section>
  );
}

export function IssueTwinPage({ project, csrf }: { project: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['issue-twin', project],
    queryFn: () => api.issueTwin(project),
  });
  if (q.isPending) return <Loading what="the issue twin" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  return (
    <div className="twin-page">
      <PageHead
        eyebrow={project}
        title="GitHub issue twin"
        crumbs={[
          { label: 'Projects', to: '/' },
          { label: project, to: `/projects/${project}` },
          { label: 'Issue twin' },
        ]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        sub="Gaps live in the factory record. Each GitHub issue is a twin, filed only from a batch a person approved; its state comes back as a signal and never closes a gap by itself."
      />
      {v.repos.length === 0 ? (
        <EmptyState title="No repo yet">
          <p className="muted">The project has no registered repo, so there is nothing to file.</p>
        </EmptyState>
      ) : (
        v.repos.map((r) => <RepoTwin key={r.repo} project={project} repo={r} csrf={csrf} />)
      )}
      <Card title="Rules">
        <ul className="plain">
          <li>
            <b>Dedupe</b>, in order: the record’s gap → issue map, then the labelled issues by their
            marker, then a person linking a duplicate. GitHub search is never the source of truth.
          </li>
          <li>
            <b>Disclosure (SEC-OB-4).</b> No security issue on any repo; a content lint on every
            body.
          </li>
          <li>A fixable gap becomes an N6 request → S1 as L2 → G0.</li>
          <li>Edits to labels or titles on GitHub are ignored as data.</li>
        </ul>
      </Card>
    </div>
  );
}
