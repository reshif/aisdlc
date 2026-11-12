import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LANE_LABELS,
  LaneValues,
  pdpResource,
  type Lane,
  type PortalAskRequest,
  type PortalRequestReceipt,
  type ProjectSummary,
} from '@aisdlc/contracts';
import { useId, useState, type FormEvent } from 'react';
import { Guarded, useMe } from '../access';
import { api } from '../api';
import { ErrorNote, Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, GateTag, KeyValue, PageHead, Pill, laneText } from '../ui';
import {
  ELIGIBILITY_REASON_TEXT,
  ELIGIBILITY_ROUTE_TEXT,
  INTAKE_STATE_TEXT,
  levelTitle,
} from '../vocab';

// Ask for work (P1-1; portal-coverage §2 `ask`, FL S1 1.1 to 1.4): a requester sends a request to a project and a
// repo, with an optional lane hint. The answer is intake's receipt: the text as the factory keeps it (normalised,
// taint-marked, with the injection flags), the de-dupe links, the lane it runs as and why (the eligibility verdict,
// and the level that would open the asked lane), and who decides G0 and G1. The button is the PDP's hint
// (`work.request` on the project); the bff and core ask again, and a refusal is shown as one.

/** A request is a few paragraphs, not a document (1.1 refuses longer text; `MAX_REQUEST_TEXT_CHARS`). */
const MAX_TEXT = 20_000;

const short = (hex: string): string => `${hex.slice(0, 12)}…`;

export function AskForWorkPage({ project, csrf }: { project: string | null; csrf: string }) {
  const me = useMe();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [receipt, setReceipt] = useState<PortalRequestReceipt | null>(null);
  if (projects.isPending) return <Loading what="your projects" />;
  if (projects.isError) {
    return <PageError error={projects.error} retry={() => void projects.refetch()} />;
  }
  const askable = new Set(
    me.actions.projects.filter((p) => p.actions.includes('work.request')).map((p) => p.project_id),
  );
  const list = projects.data;
  return (
    <>
      <PageHead
        eyebrow="Work"
        title="Ask for work"
        sub="Say what you need on a project's repo. The factory reads it as data, checks it, and tells you how it routes it and who decides it first."
        actions={
          <Link to="/ask" className="ui-btn">
            Not sure? Ask the factory
          </Link>
        }
      />
      {receipt ? (
        <Receipt receipt={receipt} again={() => setReceipt(null)} />
      ) : list.length === 0 ? (
        <EmptyState title="No project to ask on">
          You can see no project yet. <Link to="/me/access">What can I do?</Link>
        </EmptyState>
      ) : (
        <AskForm
          projects={list}
          initial={
            (project !== null && list.some((p) => p.project.project_id === project)
              ? project
              : list.find((p) => askable.has(p.project.project_id))?.project.project_id) ??
            (list[0] as ProjectSummary).project.project_id
          }
          askable={askable}
          csrf={csrf}
          done={setReceipt}
        />
      )}
    </>
  );
}

function AskForm({
  projects,
  initial,
  askable,
  csrf,
  done,
}: {
  projects: readonly ProjectSummary[];
  initial: string;
  askable: ReadonlySet<string>;
  csrf: string;
  done: (r: PortalRequestReceipt) => void;
}) {
  const qc = useQueryClient();
  const ids = { project: useId(), repo: useId(), text: useId(), lane: useId(), help: useId() };
  const [projectId, setProjectId] = useState(initial);
  const repos = projects.find((p) => p.project.project_id === projectId)?.repos ?? [];
  const [repo, setRepo] = useState(repos[0]?.repo_ref ?? '');
  const [text, setText] = useState('');
  const [lane, setLane] = useState<Lane | ''>('');
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (b: PortalAskRequest) => api.askForWork(b, csrf),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['items'] });
      done(r);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const found =
      repo === ''
        ? 'Choose the repo the work is on.'
        : text.trim() === ''
          ? 'Say what you need first.'
          : null;
    setProblem(found);
    if (found !== null) return;
    send.mutate({
      project_id: projectId as PortalAskRequest['project_id'],
      repo: repo as PortalAskRequest['repo'],
      text: text.trim(),
      ...(lane === '' ? {} : { lane }),
    });
  }

  return (
    <Card title="Your request" testId="ask-form">
      <form onSubmit={submit} noValidate aria-describedby={problem ? 'ask-problem' : undefined}>
        {problem ? (
          <p className="notice notice-bad" role="alert" id="ask-problem">
            {problem}
          </p>
        ) : null}
        <div className="row">
          <div className="field">
            <label htmlFor={ids.project}>Project</label>
            <select
              id={ids.project}
              value={projectId}
              onChange={(e) => {
                const next = e.target.value;
                setProjectId(next);
                setRepo(
                  projects.find((p) => p.project.project_id === next)?.repos[0]?.repo_ref ?? '',
                );
              }}
            >
              {projects.map((p) => (
                <option key={p.project.project_id} value={p.project.project_id}>
                  {p.project.name}
                  {askable.has(p.project.project_id) ? '' : ' (you may not ask here)'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.repo}>Repo</label>
            {repos.length === 0 ? (
              <p className="muted" id={ids.repo}>
                This project has no repo yet.
              </p>
            ) : (
              <select id={ids.repo} value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.repo_id} value={r.repo_ref}>
                    {r.repo_ref}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.text}>What do you need?</label>
          <textarea
            id={ids.text}
            rows={6}
            maxLength={MAX_TEXT}
            value={text}
            aria-describedby={ids.help}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="muted" id={ids.help}>
            The text is data: the factory reads it, never obeys it. Do not paste secrets: a request
            that holds one is refused.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.lane}>Lane hint (optional)</label>
          <select id={ids.lane} value={lane} onChange={(e) => setLane(e.target.value as Lane | '')}>
            <option value="">No preference: the factory classifies it</option>
            {LaneValues.map((l) => (
              <option key={l} value={l}>
                {LANE_LABELS[l] === null ? l : `${l} ${LANE_LABELS[l]}`}
              </option>
            ))}
          </select>
        </div>
        {send.isError ? <ErrorNote error={send.error} /> : null}
        <div className="actions">
          <Guarded
            action="work.request"
            resource={pdpResource.project(projectId)}
            label="Send the request"
          >
            <button
              type="submit"
              className="ui-btn ui-btn-primary"
              disabled={send.isPending}
              aria-busy={send.isPending}
            >
              Send the request
            </button>
          </Guarded>
        </div>
      </form>
    </Card>
  );
}

/** What intake did with the request: everything here is from the answer, nothing is guessed. */
function Receipt({ receipt: r, again }: { receipt: PortalRequestReceipt; again: () => void }) {
  const t = r.request_text;
  const name = (p: string) => r.principal_names[p] ?? p;
  const opensAt =
    r.verdict.eligible || r.lane_opens_at === null
      ? null
      : r.verdict.reason === 'level_too_low'
        ? `${r.asked_lane} opens at ${levelTitle(r.lane_opens_at)}.`
        : `${r.asked_lane} opens at ${levelTitle(r.lane_opens_at)} at the earliest; ${ELIGIBILITY_REASON_TEXT[r.verdict.reason]}.`;
  return (
    <>
      <div className="notice notice-good" role="status" data-testid="ask-receipt">
        <p>
          <strong>
            {r.duplicate ? 'This request was already received.' : 'Request received.'}
          </strong>{' '}
          {INTAKE_STATE_TEXT[r.state]}.
        </p>
        <p className="actions">
          {r.item_id !== null ? (
            <Link to={`/items/${r.item_id}`} className="ui-btn ui-btn-primary">
              Open the work item
            </Link>
          ) : null}
          <button type="button" className="ui-btn" onClick={again}>
            Ask for something else
          </button>
        </p>
      </div>

      <Card title="Lane" testId="receipt-lane">
        <KeyValue
          rows={[
            ['You asked for', laneText(r.asked_lane)],
            [
              'It runs as',
              <>
                {laneText(r.proposed_lane)}{' '}
                <span className="muted">
                  (proposed: 1.3 classifies the request and G0 binds the lane)
                </span>
              </>,
            ],
            [
              'Readiness check (1.4)',
              <>
                <Pill tone={r.verdict.eligible ? 'ok' : 'warn'}>
                  {r.verdict.eligible ? 'eligible' : 'not eligible'}
                </Pill>{' '}
                {ELIGIBILITY_REASON_TEXT[r.verdict.reason]};{' '}
                {ELIGIBILITY_ROUTE_TEXT[r.verdict.route]}.
              </>,
            ],
            [
              'Readiness record',
              r.verdict.prr === null
                ? 'none active'
                : `version ${r.verdict.prr.version}, ${levelTitle(r.verdict.prr.level)}, ${r.verdict.prr.status}`,
            ],
            ...(opensAt === null ? [] : ([['What would open it', opensAt]] as const)),
          ]}
        />
      </Card>

      <Card title="Who decides it first" testId="receipt-deciders">
        {r.deciders.length === 0 ? (
          <p className="muted">No work item exists yet, so no gate is open for anyone.</p>
        ) : (
          <ul className="plain" aria-label="Who decides G0 and G1">
            {r.deciders.map((d) => (
              <li key={d.gate}>
                <GateTag gate={d.gate} showTitle />{' '}
                {d.holders === null ? (
                  <span>
                    <Pill tone="bad">unknown</Pill> {d.reason ?? 'who decides could not be read'}
                  </span>
                ) : d.holders.length === 0 ? (
                  <span>
                    <Pill tone="warn">nobody</Pill> nobody holds the {d.slot} role yet
                  </span>
                ) : (
                  <span>
                    {d.holders.map(name).join(', ')} <span className="muted">({d.slot} role)</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          The item first needs your Ready decision (1.6); then they decide triage and intent. You
          follow it on the item page.
        </p>
      </Card>

      <Card title="Your text, as the factory keeps it (1.1)" testId="receipt-text">
        <pre className="ask-text" aria-label="The normalised text">
          {t.text}
        </pre>
        <KeyValue
          label="Taint mark"
          rows={[
            [
              'Taint',
              <>
                <Pill tone="warn">{t.taint}</Pill> {t.origin}: read as data, never obeyed
              </>,
            ],
            ['Channel', `${t.provenance.channel} (portal Ask)`],
            ['Received', shortTime(t.provenance.received_at)],
            ['From', name(t.provenance.submitted_by)],
            ['As sent', <code key="raw">sha256 {short(t.provenance.raw_sha256)}</code>],
            ['Normalised', <code key="norm">sha256 {short(t.provenance.normalised_sha256)}</code>],
          ]}
        />
      </Card>

      <Card title="Injection check (B27)" testId="receipt-injection">
        {r.injection.suspected ? (
          <>
            <p>
              <Pill tone="bad">flagged</Pill> The text looks like it tries to instruct the factory.
              It is fenced as data, and the G0 card shows these flags to its decider.
            </p>
            <ul className="plain" aria-label="Injection flags">
              {t.flags.map((f) => (
                <li key={`${f.rule}:${f.line}`}>
                  <code>{f.rule}</code> on line {f.line}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            <Pill tone="ok">none</Pill> Nothing in the text looks like an instruction to the
            factory.
          </p>
        )}
      </Card>

      <Card title="Duplicates (1.2)" testId="receipt-dedupe">
        {r.dedupe_links.length === 0 ? (
          <p className="muted">No earlier item on this repo has the same text.</p>
        ) : (
          <>
            <p>The same text was asked for before. The new item is linked to:</p>
            <ul className="plain" aria-label="Linked items">
              {r.dedupe_links.map((id) => (
                <li key={id}>
                  <Link to={`/items/${id}`}>item {id.replace(/-/g, '').slice(0, 8)}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </>
  );
}
