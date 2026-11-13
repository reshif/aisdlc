import { label, term, type StatusWord } from '@aisdlc/contracts';
import { useId, type ReactNode } from 'react';

// The readiness scorecard (skeleton screen 4: "the floors, like a service scorecard") and the stepper of a flow
// with several steps (onboarding, a settings change: change, preview, approve). The state of a requirement is
// a word with its mark; unknown is said and treated as not met, never a tick (glossary §1).

export type ScoreState = Extract<
  StatusWord,
  'met' | 'not_met' | 'unknown' | 'not_evaluated' | 'na' | 'recorded'
>;

export interface ScoreItem {
  readonly id: string;
  /** A glossary label ("Tests run and pass", "Main branch protected"). */
  readonly label: string;
  readonly state: ScoreState;
  /** "84% confirmed (90% needed)". */
  readonly detail?: ReactNode;
}

const MARK: Readonly<Record<ScoreState, ReactNode>> = {
  met: <path d="m6 12.5 4 4 8-9" />,
  not_met: <path d="M7 7l10 10M17 7 7 17" />,
  unknown: <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 16.5v.5" />,
  not_evaluated: <path d="M7 12h10" />,
  na: <path d="M7 12h10" />,
  recorded: <path d="M8 8h8M8 12h8M8 16h5" />,
};

export function ScoreMark({ state }: { state: ScoreState }) {
  return (
    <svg
      className={`ui-mark ui-mark-${state}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {MARK[state]}
    </svg>
  );
}

export function Scorecard({
  title,
  items,
  summary,
  footer,
}: {
  title: string;
  items: readonly ScoreItem[];
  /** The overall result in words ("Readiness 2 of 4: small changes"). */
  summary?: ReactNode;
  footer?: ReactNode;
}) {
  const id = useId();
  const met = items.filter((i) => i.state === 'met').length;
  const counted = items.filter((i) => i.state !== 'na' && i.state !== 'not_evaluated').length;
  return (
    <section className="ui-score" aria-labelledby={id}>
      <div className="ui-score-hd">
        <h2 id={id}>{title}</h2>
        <span className="ui-score-n">
          {met} of {counted} {label('status', 'met').toLowerCase()}
        </span>
      </div>
      {summary ? <p className="ui-score-sum">{summary}</p> : null}
      <ul className="ui-score-grid">
        {items.map((i) => {
          const s = term('status', i.state);
          return (
            <li key={i.id} className={`ui-score-item ui-score-${i.state}`}>
              <ScoreMark state={i.state} />
              <span className="ui-score-t">{i.label}</span>
              <span className="ui-score-s" title={s.explain}>
                {s.label}
              </span>
              {i.detail ? <span className="ui-score-d">{i.detail}</span> : null}
            </li>
          );
        })}
      </ul>
      {footer ? <div className="ui-score-ft">{footer}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------- Stepper

export type StepState = 'done' | 'current' | 'todo' | 'blocked';

export interface StepperStep {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: ReactNode;
}

const STEP_TEXT: Readonly<Record<StepState, string>> = {
  done: 'done',
  current: 'current step',
  todo: 'not started',
  blocked: label('status', 'blocked').toLowerCase(),
};

export function Stepper({
  steps,
  label: name,
}: {
  steps: readonly StepperStep[];
  /** The accessible name of the list ("Onboarding steps"). */
  label: string;
}) {
  return (
    <ol className="ui-stepper" aria-label={name}>
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={`ui-stepper-step ui-stepper-${s.state}`}
          {...(s.state === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span className="ui-stepper-n" aria-hidden="true">
            {s.state === 'done' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="m5 12.5 4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              i + 1
            )}
          </span>
          <span className="ui-stepper-t">
            {s.label}
            <span className="ui-sr">, {STEP_TEXT[s.state]}</span>
          </span>
          {s.detail ? <span className="ui-stepper-d">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
