import type {
  AssistantBudgetView,
  AssistantFlag,
  Citation,
  Draft,
  ProposalButton,
  ThreadGrounding,
  Turn,
} from '@aisdlc/contracts';
import { useState, type FormEvent } from 'react';
import { Guarded } from '../access';
import { ApiError, api } from '../api';
import { Link } from '../router';
import { Pill, useToast } from '../ui';

// The pieces of a conversation with the assistant (PLAN M18; portal-config §4), shared by the onboarding assistant
// beside the S0 page and "Ask the factory". The assistant's words are TEXT (never HTML); a citation is a chip that
// opens what it cites; a proposal is a button that looks like the page's own and goes through the same access layer:
// a `navigate` one opens a page, a `call` one posts to the bff route it names under the person's session, and the PDP
// decides that route again. A draft is text the person copies into a card; the person still submits the card.

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

const FLAG_TEXT: Readonly<Record<AssistantFlag, string>> = {
  planted_instruction: 'Repo text carried an instruction: quoted as data and ignored',
  outside_view: 'Asked about something outside your view',
  secret_requested: 'A secret was asked for: secrets stay on the security card',
  stale_head: 'The head moved since the census: nothing is said about the new head',
  proposal_dropped: 'An action on something outside this context was dropped',
  secret_masked: 'A secret in your message was masked before it was stored or sent',
};

/** Where a record citation leads in the portal, or `null` when nothing there shows it. */
export function citationHref(c: Citation, projectId: string): string | null {
  if (c.kind === 'file') return null;
  if (c.kind === 'ledger') return `/projects/${encodeURIComponent(projectId)}/ledger`;
  const [kind, rest = ''] = [
    c.ref.slice(0, c.ref.indexOf(':')),
    c.ref.slice(c.ref.indexOf(':') + 1),
  ];
  switch (kind) {
    case 'card':
      return `/cards/${rest}`;
    case 's0':
      return `/s0/${rest}`;
    case 'item':
      return `/items/${rest}`;
    case 'step':
      return `/s0/${rest.split('/')[0] ?? ''}`;
    case 'project':
      return `/projects/${encodeURIComponent(rest.startsWith('census/') ? projectId : rest)}`;
    default:
      return null;
  }
}

export function citationLabel(c: Citation): string {
  if (c.kind === 'file') {
    const lines = c.line_from === c.line_to ? `${c.line_from}` : `${c.line_from}-${c.line_to}`;
    return `${c.path}:${lines} @ ${short(c.commit_sha)}`;
  }
  return c.ref;
}

function CitationChip({ c, n, projectId }: { c: Citation; n: number; projectId: string }) {
  const href = citationHref(c, projectId);
  const body = (
    <>
      <sup>{n}</sup> {citationLabel(c)}
    </>
  );
  return href ? (
    <Link className="asst-cite" to={href} title={`${c.kind} citation`}>
      {body}
    </Link>
  ) : (
    <span className="asst-cite" title={`${c.kind} citation`}>
      {body}
    </span>
  );
}

function ProposalView({ b, csrf, primary }: { b: ProposalButton; csrf: string; primary: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cls = `ui-btn ui-btn-sm${primary ? ' ui-btn-primary' : ''}`;
  return (
    <Guarded action={b.pdp_action} resource={b.resource} label={b.label}>
      {b.kind === 'navigate' ? (
        <Link className={cls} to={b.route.path}>
          {b.label}
        </Link>
      ) : (
        <button
          type="button"
          className={cls}
          disabled={busy}
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            api
              .callProposal(b.route.path, csrf)
              .then(() => toast(`${b.label}: done`, 'ok'))
              .catch((e: unknown) =>
                toast(e instanceof ApiError ? e.message : `${b.label} failed`, 'bad'),
              )
              .finally(() => setBusy(false));
          }}
        >
          {b.label}
        </button>
      )}
    </Guarded>
  );
}

function DraftBlock({ d }: { d: Draft }) {
  const toast = useToast();
  return (
    <div className="asst-draft" data-draft={d.draft_id}>
      <div className="ui-eyebrow">
        Draft · {d.title}
        {d.card ? ` · for card ${d.card.replace(/^C/, '')}` : ''}
      </div>
      <pre className="asst-draft-text">{d.text}</pre>
      <div className="asst-row">
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(d.text)
              .then(() => toast('Draft copied: paste it into the card and submit it there', 'ok'))
              .catch(() => toast('The draft could not be copied', 'bad'));
          }}
        >
          Copy{d.card ? ` for card ${d.card.replace(/^C/, '')}` : ''}
        </button>
      </div>
      {d.lint.length > 0 ? (
        <p className="asst-fine">
          Text checks noted: {d.lint.join(', ')}. Read it before you use it.
        </p>
      ) : null}
      <p className="asst-fine">
        Nothing is sent: you put it on a card and decide the card yourself.
      </p>
    </div>
  );
}

export function TurnView({
  turn,
  csrf,
  projectId,
  who,
}: {
  turn: Turn;
  csrf: string;
  projectId: string;
  who: string;
}) {
  if (turn.role === 'person') {
    return (
      <li className="asst-turn asst-me" data-seq={turn.seq}>
        <div className="asst-who">{who}</div>
        <div className="asst-text">{turn.text ?? '(erased)'}</div>
        {turn.flags.includes('secret_masked') ? (
          <p className="asst-fine">{FLAG_TEXT.secret_masked}.</p>
        ) : null}
      </li>
    );
  }
  return (
    <li
      className={`asst-turn asst-bot asst-${turn.kind}`}
      data-seq={turn.seq}
      data-kind={turn.kind}
    >
      <div className="asst-who">
        Assistant · read-only
        {turn.grounding_sha ? ` · grounded on ${short(turn.grounding_sha)}` : ' · record only'}
        {turn.kind === 'refusal' ? (
          <>
            {' '}
            <Pill tone="warn" plain>
              refused
            </Pill>
          </>
        ) : null}
      </div>
      <div className="asst-text">{turn.text ?? '(erased)'}</div>
      {turn.citations.length > 0 ? (
        <div className="asst-cites" aria-label="Citations">
          {turn.citations.map((c, i) => (
            <CitationChip key={i} c={c} n={i + 1} projectId={projectId} />
          ))}
        </div>
      ) : null}
      {turn.drafts.map((d) => (
        <DraftBlock key={d.draft_id} d={d} />
      ))}
      {turn.proposals.length > 0 ? (
        <div className="asst-props" role="group" aria-label="Suggested actions">
          <span className="asst-fine">Buttons call the normal routes; the PDP decides.</span>
          {turn.proposals.map((b, i) => (
            <ProposalView key={i} b={b} csrf={csrf} primary={i === 0} />
          ))}
        </div>
      ) : null}
      {turn.flags.filter((f) => f !== 'secret_masked').length > 0 ? (
        <ul className="asst-flags" aria-label="What the factory noticed">
          {turn.flags
            .filter((f) => f !== 'secret_masked')
            .map((f) => (
              <li key={f}>{FLAG_TEXT[f]}</li>
            ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Composer({
  label,
  placeholder,
  pending,
  onAsk,
}: {
  label: string;
  placeholder: string;
  pending: boolean;
  onAsk: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || pending) return;
    onAsk(t);
    setText('');
  };
  return (
    <form className="asst-composer" onSubmit={submit}>
      <label className="ui-sr" htmlFor="asst-in">
        {label}
      </label>
      <textarea
        id="asst-in"
        className="asst-input"
        rows={2}
        maxLength={2000}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
        }}
      />
      <button
        type="submit"
        className="ui-btn ui-btn-primary"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? 'Asking…' : 'Ask'}
      </button>
    </form>
  );
}

/** The day budget, in words and a meter. Unknown is said as unknown, never as plenty left. */
export function BudgetLine({ budget }: { budget: AssistantBudgetView | null | undefined }) {
  if (!budget) return <p className="asst-fine">Budget today (assistant_user_day): unknown.</p>;
  const used = budget.used_cost_micro_usd / budget.max_cost_micro_usd;
  const left = Math.max(
    0,
    Math.round((1 - Math.max(used, budget.used_tokens / budget.max_tokens)) * 100),
  );
  return (
    <p className="asst-fine asst-budget" data-exhausted={budget.exhausted}>
      Budget today (<code>assistant_user_day</code>):{' '}
      {budget.exhausted ? (
        <strong>spent; it resets at 00:00 UTC</strong>
      ) : (
        <>
          {left}% left, resets at 00:00 UTC{' '}
          <meter min={0} max={100} value={left} aria-label="Budget left today" />
        </>
      )}
    </p>
  );
}

export function GroundingLine({ g }: { g: ThreadGrounding | null | undefined }) {
  if (!g || g.census_sha === null) {
    return <p className="asst-fine">No census to ground on: answers come from the record only.</p>;
  }
  return (
    <p className="asst-fine" data-stale={g.stale}>
      {g.repo ? <code>{g.repo}</code> : null} · grounded on <code>{short(g.census_sha)}</code>
      {g.stale ? (
        <strong> · the head moved: I answer nothing about the new head until a re-census</strong>
      ) : null}
    </p>
  );
}

export const assistantErrorText = (e: unknown): string =>
  e instanceof ApiError
    ? e.status === 403
      ? 'You cannot use the assistant here: it answers only people who can see this project.'
      : e.message
    : 'The assistant could not answer.';
