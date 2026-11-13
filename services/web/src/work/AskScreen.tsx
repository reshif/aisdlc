import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LaneValues,
  label,
  pdpResource,
  type Lane,
  type PortalAskRequest,
  type PortalRequestReceipt,
  type ProjectSummary,
} from '@aisdlc/contracts';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Guarded, useMe } from '../access';
import { api, type Me } from '../api';
import { describeError } from '../format';
import { DuplicatesCard, InjectionCard, RequestTextCard } from '../items/RequestParts';
import { Link } from '../router';
import { Card, EmptyState, KeyValue, Modal, PageHeader, Pill } from '../ui';
import { ELIGIBILITY_REASON_TEXT } from '../vocab';
import { listText, wire } from './words';
import './work.css';

// Ask for work (screen-map §2.8): a project I may ask on, its repo, what I need (data, never instructions), the track
// I expect if any. After sending: what intake did with it, in words: the text as kept, possible prompt injection,
// duplicates, the track it runs on and why, and who decides it first. The same form is the page (`/ask`) and the
// modal the "Ask for work" button opens. The button is the PDP's hint (`work.request` on the project); the bff and
// core ask again, and a refusal is shown as one. An unsent draft stays in this browser only.

/** A request is a few paragraphs, not a document (intake refuses longer text). */
const MAX_TEXT = 20_000;
const DRAFT_KEY = 'aisdlc.ask.draft';

interface Draft {
  readonly project: string;
  readonly text: string;
}

const readDraft = (): Draft | null => {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
};
const writeDraft = (d: Draft | null) => {
  try {
    if (d === null || d.text.trim() === '') window.localStorage.removeItem(DRAFT_KEY);
    else window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // a private window or blocked storage: the draft is simply not kept
  }
};

/** Projects where `/api/me` says the person may ask for work (a hint). */
const askableOf = (me: Me): ReadonlySet<string> =>
  new Set(
    me.actions.projects.filter((p) => p.actions.includes('work.request')).map((p) => p.project_id),
  );

export function AskScreen({ project, csrf }: { project: string | null; csrf: string }) {
  const [receipt, setReceipt] = useState<PortalRequestReceipt | null>(null);
  return (
    <div className="wk-page">
      <PageHeader
        title={label('screen', 'ask_for_work')}
        meta="Say what you need on a project's repo. The factory reads it as data, checks it, and tells you how it handles it and who decides it first."
      />
      {receipt ? (
        <Receipt receipt={receipt} again={() => setReceipt(null)} />
      ) : (
        <AskPanel project={project} csrf={csrf} done={setReceipt} />
      )}
    </div>
  );
}

function AskPanel({
  project,
  csrf,
  done,
}: {
  project: string | null;
  csrf: string;
  done: (r: PortalRequestReceipt) => void;
}) {
  const me = useMe();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  if (projects.isPending) return <p className="wk-muted">Loading your projects…</p>;
  if (projects.isError) {
    return (
      <p role="alert" className="wk-bad">
        Your projects could not load. Nothing was sent.{' '}
        <button type="button" className="ui-btn ui-btn-sm" onClick={() => void projects.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  const askable = askableOf(me);
  const list = projects.data;
  if (list.length === 0) {
    return (
      <EmptyState title="No project to ask on">
        You can see no project yet. <Link to="/me/access">What can I do?</Link>
      </EmptyState>
    );
  }
  if (!list.some((p) => askable.has(p.project.project_id))) {
    return (
      <EmptyState title="You may not ask for work yet">
        None of your roles lets you ask for work on a project. A project admin can make you a
        requester. <Link to="/me/access">See my access</Link>
      </EmptyState>
    );
  }
  const draft = readDraft();
  const initial =
    (project !== null && list.some((p) => p.project.project_id === project)
      ? project
      : draft && askable.has(draft.project)
        ? draft.project
        : list.find((p) => askable.has(p.project.project_id))?.project.project_id) ??
    (list[0] as ProjectSummary).project.project_id;
  return (
    <AskForm
      projects={list}
      initial={initial}
      askable={askable}
      csrf={csrf}
      done={done}
      draft={draft}
    />
  );
}

function AskForm({
  projects,
  initial,
  askable,
  csrf,
  done,
  draft,
}: {
  projects: readonly ProjectSummary[];
  initial: string;
  askable: ReadonlySet<string>;
  csrf: string;
  done: (r: PortalRequestReceipt) => void;
  draft: Draft | null;
}) {
  const qc = useQueryClient();
  const ids = {
    project: useId(),
    repo: useId(),
    text: useId(),
    lane: useId(),
    help: useId(),
    problem: useId(),
  };
  const [projectId, setProjectId] = useState(initial);
  const repos = projects.find((p) => p.project.project_id === projectId)?.repos ?? [];
  const [repo, setRepo] = useState(repos[0]?.repo_ref ?? '');
  const [text, setText] = useState(draft?.project === initial ? draft.text : '');
  const [lane, setLane] = useState<Lane | ''>('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => writeDraft({ project: projectId, text }), [projectId, text]);
  const send = useMutation({
    mutationFn: (b: PortalAskRequest) => api.askForWork(b, csrf),
    onSuccess: (r) => {
      writeDraft(null);
      void qc.invalidateQueries({ queryKey: ['items'] });
      done(r);
    },
  });
  const mayHere = askable.has(projectId);

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
    <form
      className="wk-form"
      onSubmit={submit}
      noValidate
      {...(problem ? { 'aria-describedby': ids.problem } : {})}
      data-testid="ask-form"
    >
      {problem ? (
        <p className="wk-bad" role="alert" id={ids.problem}>
          {problem}
        </p>
      ) : null}
      <div className="wk-two">
        <div className="wk-field">
          <label htmlFor={ids.project} className="ui-label">
            {label('concept', 'project')}
          </label>
          <select
            id={ids.project}
            className="ui-input ui-select"
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
        <div className="wk-field">
          <label htmlFor={ids.repo} className="ui-label">
            {label('concept', 'repo')}
          </label>
          {repos.length === 0 ? (
            <p className="wk-muted" id={ids.repo}>
              This project has no repo yet.
            </p>
          ) : (
            <select
              id={ids.repo}
              className="ui-input ui-select"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            >
              {repos.map((r) => (
                <option key={r.repo_id} value={r.repo_ref}>
                  {r.repo_ref}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="wk-field">
        <label htmlFor={ids.text} className="ui-label">
          What do you need?
        </label>
        <textarea
          id={ids.text}
          className="ui-input"
          rows={7}
          maxLength={MAX_TEXT}
          value={text}
          aria-describedby={ids.help}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="ui-help" id={ids.help}>
          Start with one line that says what you need. The text is{' '}
          {label('concept', 'taint').toLowerCase()}: the factory reads it and never obeys it. Do not
          paste secrets: a request that holds one is refused. Your draft is kept in this browser
          until you send it.
        </p>
      </div>
      <div className="wk-field">
        <label htmlFor={ids.lane} className="ui-label">
          Track you expect (optional)
        </label>
        <select
          id={ids.lane}
          className="ui-input ui-select"
          value={lane}
          onChange={(e) => setLane(e.target.value as Lane | '')}
        >
          <option value="">No preference: the factory picks the track</option>
          {LaneValues.map((l) => (
            <option key={l} value={l}>
              {wire('lane', l)}
            </option>
          ))}
        </select>
      </div>
      <p className="wk-hint" data-testid="ask-hint">
        {mayHere
          ? 'When you send it, the factory checks for duplicates and possible prompt injection, picks the track this repo allows, and tells you who decides it first.'
          : 'None of your roles lets you ask for work on this project. Choose another project, or ask a project admin.'}
      </p>
      {send.isError ? (
        <p role="alert" className="wk-bad">
          {describeError(send.error)} Nothing was sent.
        </p>
      ) : null}
      <div className="wk-actions">
        <Guarded
          action="work.request"
          resource={pdpResource.project(projectId)}
          label={label('screen', 'ask_for_work')}
        >
          <button
            type="submit"
            className="ui-btn ui-btn-primary"
            disabled={send.isPending || !mayHere}
            aria-busy={send.isPending}
          >
            {label('screen', 'ask_for_work')}
          </button>
        </Guarded>
      </div>
    </form>
  );
}

/** What intake did with the request: everything here is from the answer, nothing is guessed. */
function Receipt({ receipt: r, again }: { receipt: PortalRequestReceipt; again: () => void }) {
  const name = (p: string) => r.principal_names[p] ?? 'someone';
  return (
    <div className="wk-page">
      <Card
        title={r.duplicate ? 'This request was already received' : 'Request received'}
        testId="ask-receipt"
      >
        <p role="status">
          {r.item_id !== null
            ? 'A work item was made. Follow it on its page.'
            : 'It waits: no work item is made until this repo is ready for the track.'}
        </p>
        <p className="wk-actions">
          {r.item_id !== null ? (
            <Link to={`/items/${r.item_id}`} className="ui-btn ui-btn-primary">
              Open the work item
            </Link>
          ) : null}
          <button type="button" className="ui-btn" onClick={again}>
            Ask for something else
          </button>
        </p>
      </Card>

      <Card title={label('concept', 'lane')} testId="receipt-lane">
        <KeyValue
          rows={[
            ['You asked for', wire('lane', r.asked_lane)],
            [
              'It runs as',
              `${wire('lane', r.proposed_lane)} (the factory confirms it when it sizes the work)`,
            ],
            [
              'Allowed on this repo',
              <>
                <Pill tone={r.verdict.eligible ? 'ok' : 'warn'}>
                  {r.verdict.eligible ? 'Yes' : 'No'}
                </Pill>{' '}
                {ELIGIBILITY_REASON_TEXT[r.verdict.reason]}.
              </>,
            ],
          ]}
        />
      </Card>

      <Card title="Who decides it first" testId="receipt-deciders">
        {r.deciders.length === 0 ? (
          <p className="wk-muted">No work item exists yet, so no approval is open for anyone.</p>
        ) : (
          <ul className="wk-list" aria-label="Who decides first">
            {r.deciders.map((d) => (
              <li key={d.gate}>
                <strong>{wire('gate', d.gate)}</strong>
                {d.holders === null ? (
                  <span>
                    <Pill tone="bad">{label('status', 'unknown')}</Pill> who decides could not be
                    read
                  </span>
                ) : d.holders.length === 0 ? (
                  <span>
                    <Pill tone="warn">Nobody</Pill> nobody holds the role yet
                  </span>
                ) : (
                  <span>
                    {listText(d.holders.map(name))}{' '}
                    <span className="wk-muted">({wire('roleSlot', d.slot)})</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RequestTextCard text={r.request_text} name={name} testId="receipt-text" />
      <InjectionCard
        suspected={r.injection.suspected}
        flags={r.request_text.flags}
        testId="receipt-injection"
      />
      <DuplicatesCard links={r.dedupe_links} testId="receipt-dedupe" />
    </div>
  );
}

/**
 * "Ask for work": a button that opens the form in a modal, guarded by `work.request` on the project (or the first
 * project the person may ask on). A person who may ask nowhere sees it locked with the reason.
 */
export function AskForWorkLink({
  me,
  project,
  primary,
}: {
  me: Me;
  project?: string;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState<PortalRequestReceipt | null>(null);
  const target =
    project ?? me.actions.projects.find((p) => p.actions.includes('work.request'))?.project_id;
  const resource = target === undefined ? pdpResource.fleet() : pdpResource.project(target);
  const text = label('screen', 'ask_for_work');
  return (
    <>
      <Guarded action="work.request" resource={resource} label={text}>
        <button
          type="button"
          className={primary ? 'ui-btn ui-btn-primary' : 'ui-btn'}
          onClick={() => {
            setReceipt(null);
            setOpen(true);
          }}
        >
          {text}
        </button>
      </Guarded>
      <Modal open={open} title={text} onClose={() => setOpen(false)}>
        {receipt ? (
          <div className="wk-page">
            <p role="status">
              {receipt.duplicate ? 'This request was already received.' : 'Request received.'}
            </p>
            {receipt.item_id ? (
              <Link
                to={`/items/${receipt.item_id}`}
                className="ui-btn ui-btn-primary"
                onClick={() => setOpen(false)}
              >
                Open the work item
              </Link>
            ) : (
              <p>It waits until this repo is ready for the track.</p>
            )}
          </div>
        ) : (
          <AskPanel project={project ?? null} csrf={me.csrf_token} done={setReceipt} />
        )}
      </Modal>
    </>
  );
}
