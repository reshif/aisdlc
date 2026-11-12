import { useQueryClient } from '@tanstack/react-query';
import type { ClaimVerdict, InstructionReview, LightClaim, LightQuestion } from '@aisdlc/contracts';
import { useEffect, useState } from 'react';
import { api, type CardDetailWire } from '../api';
import { Badge } from '../components/Badge';
import { ErrorNote } from '../components/Notice';
import { DecideShell } from './DecideShell';
import { Check, DecidersLine, Hash, Section } from './shared';

// Card 2, Light 0.2 (PLAN M16; OB §4, §6.2 row 0.2; DEC-11 refined): the factory's claims about the
// repo, each with its evidence, for the person to affirm, correct or mark unknown; the intent and
// practices questions, answered in their own words; and each instruction file as the factory
// template read it, section by section (taken, never taken with the reason, or drafted), with the
// proposed text the person affirms with the step-up. The person may edit the text here (the
// factory secret-scans it before storing anything); an edit changes the card, so the decision is
// made afresh. Factory rules always win: repo text only adds repo detail inside them.

interface FileView {
  path: string;
  state: 'absent' | 'data';
  proposed_by: string;
  sections: InstructionReview['sections'];
  missing_required: string[];
  proposed: InstructionReview['proposed'];
  affirmable: boolean;
  required: boolean;
}
interface C2View {
  repo: string;
  proposal: { proposal_hash: string; census_hash: string; template_hash: string };
  claims: LightClaim[];
  claims_dropped: number;
  claims_truncated: boolean;
  lf6: { min_affirmed_or_unknown_pct: number };
  intent_questions: LightQuestion[];
  practice_questions: LightQuestion[];
  instructions: FileView[];
  step_up: { bound_hash: string | null };
}

const VERDICT_TEXT: Readonly<Record<ClaimVerdict, string>> = {
  affirm: 'True',
  correct: 'Wrong: I correct it',
  unknown: 'I do not know',
};
const REASON_TEXT: Readonly<Record<string, string>> = {
  tools: 'grants or names tools',
  permissions: 'grants permissions',
  network: 'opens network access',
  rule_override: 'tries to override factory rules',
  factory_state: 'states factory settings (tier, lane, gate, budget)',
  secrets: 'holds a secret',
  not_in_template: 'has no place in the factory template',
};
const VERDICT_TONE = { accepted: 'good', rejected: 'bad', drafted: 'neutral' } as const;

function FileReview({ file, cardId, csrf }: { file: FileView; cardId: string; csrf: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(file.proposed.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.editInstructions(
        cardId,
        { path: file.path, text, base_text_sha256: file.proposed.text_sha256 },
        csrf,
      );
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['card', cardId] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const tid = `c2-file-${file.path.replace(/\W/g, '-')}`;
  return (
    <Section title={file.path} id={tid}>
      <p>
        {file.state === 'absent'
          ? 'The repository has no such file: the factory drafted one from the template.'
          : 'Each section of the repository file, as the factory template reads it.'}{' '}
        {file.proposed_by !== 'factory' ? `The text below is ${file.proposed_by}'s edit.` : ''}
      </p>
      <table className="table" aria-label={`Sections of ${file.path}`}>
        <thead>
          <tr>
            <th scope="col">Section</th>
            <th scope="col">Lines</th>
            <th scope="col">Verdict</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {file.sections.map((s) => (
            <tr key={s.index}>
              <th scope="row">{s.heading ?? (s.level === 0 ? '(preamble)' : '(withheld)')}</th>
              <td>
                {s.line_start}–{s.line_end}
              </td>
              <td>
                <Badge tone={VERDICT_TONE[s.verdict]}>{s.verdict}</Badge>
              </td>
              <td>{s.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {file.missing_required.length > 0 ? (
        <p className="muted">
          Required and missing from the file: {file.missing_required.join(', ')}.
        </p>
      ) : null}
      <h3>Proposed text</h3>
      {file.proposed.text === null ? (
        <p className="notice notice-bad">
          The text holds a secret, so the factory stored none of it. Rotate the secret and edit the
          text here.
        </p>
      ) : (
        <pre className="proposed-text" aria-label={`Proposed text of ${file.path}`}>
          {file.proposed.text}
        </pre>
      )}
      <p>
        {file.affirmable ? (
          <Badge tone="good">can be affirmed</Badge>
        ) : (
          <Badge tone="bad">{`cannot be affirmed: ${file.proposed.blocked ?? 'no text'}`}</Badge>
        )}{' '}
        {file.proposed.text_sha256 ? (
          <Hash value={file.proposed.text_sha256} label="text hash" />
        ) : null}
      </p>
      {file.proposed.lint.length > 0 ? (
        <ul aria-label={`Lint findings of ${file.path}`}>
          {file.proposed.lint.map((f) => (
            <li key={`${f.rule}-${f.line}`}>
              line {f.line}: {f.rule} ({f.severity})
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <div className="field">
          <label htmlFor={`${tid}-edit`}>Your text for {file.path}</label>
          <textarea
            id={`${tid}-edit`}
            rows={14}
            maxLength={64 * 1024}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="muted hint">
            The factory checks it for secrets before it stores anything, and checks every section
            against its template. You never push to the repository.
          </p>
          <button type="button" onClick={() => void save()} disabled={busy || text.trim() === ''}>
            Save this text
          </button>{' '}
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          {error ? <ErrorNote error={error} /> : null}
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Edit the text
        </button>
      )}
    </Section>
  );
}

interface Draft {
  verdicts: Record<string, ClaimVerdict | ''>;
  corrections: Record<string, string>;
  intent: Record<string, string>;
  practices: Record<string, string>;
  attested: boolean;
}
const EMPTY_DRAFT: Draft = {
  verdicts: {},
  corrections: {},
  intent: {},
  practices: {},
  attested: false,
};
function readDraft(key: string): Draft {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return EMPTY_DRAFT;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      verdicts: d.verdicts ?? {},
      corrections: d.corrections ?? {},
      intent: d.intent ?? {},
      practices: d.practices ?? {},
      attested: d.attested === true,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function C2Form({ card, csrf }: { card: CardDetailWire; csrf: string }) {
  const v = card.view as unknown as C2View;
  // The step-up may leave the page for the identity provider: what the person typed is kept in this
  // browser tab until they come back (a draft for this proposal only, never sent anywhere).
  const key = `c2-draft:${card.summary.card_id}:${v.proposal.proposal_hash}`;
  const [draft] = useState<Draft>(() => readDraft(key));
  const [verdicts, setVerdicts] = useState<Record<string, ClaimVerdict | ''>>(draft.verdicts);
  const [corrections, setCorrections] = useState<Record<string, string>>(draft.corrections);
  const [intent, setIntent] = useState<Record<string, string>>(draft.intent);
  const [practices, setPractices] = useState<Record<string, string>>(draft.practices);
  const [attested, setAttested] = useState(draft.attested);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ verdicts, corrections, intent, practices, attested }),
      );
    } catch {
      // no storage (a private window): the draft is simply not kept
    }
  }, [key, verdicts, corrections, intent, practices, attested]);

  // Every file that can be affirmed is affirmed: the step-up is bound to exactly that set.
  const affirm = v.instructions.filter((f) => f.affirmable);
  const answered = (qs: LightQuestion[], a: Record<string, string>) =>
    qs.every((q) => (a[q.question_id] ?? '').trim() !== '');
  const blocked = [
    ...(v.claims.every((c) => (verdicts[c.claim_id] ?? '') !== '')
      ? []
      : ['Give every claim a verdict.']),
    ...(v.claims.some(
      (c) => verdicts[c.claim_id] === 'correct' && (corrections[c.claim_id] ?? '').trim() === '',
    )
      ? ['Say what is true for each claim you correct.']
      : []),
    ...(answered(v.intent_questions, intent) ? [] : ['Answer every intent question.']),
    ...(answered(v.practice_questions, practices) ? [] : ['Answer every practices question.']),
    ...(attested ? [] : ['Attest the practices.']),
    ...(affirm.some((f) => f.path === 'AGENTS.md')
      ? []
      : ['AGENTS.md cannot be affirmed yet: edit its text.']),
  ];
  const content = {
    proposal_hash: v.proposal.proposal_hash,
    claims: v.claims.map((c) => {
      const verdict = verdicts[c.claim_id] || 'unknown';
      return {
        claim_id: c.claim_id,
        verdict,
        ...(verdict === 'correct' ? { correction: (corrections[c.claim_id] ?? '').trim() } : {}),
      };
    }),
    intent_answers: v.intent_questions.map((q) => ({
      question_id: q.question_id,
      answer: (intent[q.question_id] ?? '').trim(),
    })),
    practices: {
      attested,
      answers: v.practice_questions.map((q) => ({
        question_id: q.question_id,
        answer: (practices[q.question_id] ?? '').trim(),
      })),
    },
    instructions: affirm.map((f) => ({ path: f.path, text_sha256: f.proposed.text_sha256 })),
  };
  const questions = (
    qs: LightQuestion[],
    a: Record<string, string>,
    set: (x: Record<string, string>) => void,
    prefix: string,
  ) =>
    qs.map((q) => (
      <div className="field" key={q.question_id}>
        <label htmlFor={`${prefix}-${q.question_id}`}>{q.text}</label>
        <textarea
          id={`${prefix}-${q.question_id}`}
          rows={2}
          maxLength={2000}
          value={a[q.question_id] ?? ''}
          onChange={(e) => set({ ...a, [q.question_id]: e.target.value })}
        />
      </div>
    ));
  return (
    <>
      <p>
        What the factory read in {v.repo}. Factory rules always win: what you affirm here only adds
        detail about this repository, and reaches agents as guidance, never as instructions.
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="this card" />
      <Section title="Claims about the repository" id="c2-claims">
        <p className="muted">
          At least {v.lf6.min_affirmed_or_unknown_pct}% must be true or unknown.
          {v.claims_dropped > 0
            ? ` ${v.claims_dropped} claim(s) without evidence were left out.`
            : ''}
        </p>
        {v.claims.map((c) => (
          <fieldset className="options" key={c.claim_id}>
            <legend>{c.text}</legend>
            <p className="muted">
              Evidence: {c.evidence.map((e) => `${e.path}:${e.line}`).join(', ')}
            </p>
            {(['affirm', 'correct', 'unknown'] as const).map((verdict) => (
              <label key={verdict} className="radio">
                <input
                  type="radio"
                  name={`claim-${c.claim_id}`}
                  value={verdict}
                  checked={verdicts[c.claim_id] === verdict}
                  onChange={() => setVerdicts({ ...verdicts, [c.claim_id]: verdict })}
                />{' '}
                {VERDICT_TEXT[verdict]}
              </label>
            ))}
            {verdicts[c.claim_id] === 'correct' ? (
              <div className="field">
                <label htmlFor={`corr-${c.claim_id}`}>What is true</label>
                <textarea
                  id={`corr-${c.claim_id}`}
                  rows={2}
                  maxLength={1000}
                  value={corrections[c.claim_id] ?? ''}
                  onChange={(e) => setCorrections({ ...corrections, [c.claim_id]: e.target.value })}
                />
              </div>
            ) : null}
          </fieldset>
        ))}
      </Section>
      <Section title="What the repository is for" id="c2-intent">
        {questions(v.intent_questions, intent, setIntent, 'intent')}
      </Section>
      <Section title="How you work" id="c2-practices">
        {questions(v.practice_questions, practices, setPractices, 'prac')}
        <Check checked={attested} onChange={setAttested}>
          These answers describe how this repository is worked on.
        </Check>
      </Section>
      {v.instructions.map((f) => (
        <FileReview key={f.path} file={f} cardId={card.summary.card_id} csrf={csrf} />
      ))}
      <DecideShell
        card={card}
        csrf={csrf}
        content={content}
        blocked={blocked}
        approveLabel="Affirm (with the step-up)"
      />
    </>
  );
}
