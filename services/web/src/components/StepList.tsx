import type { OnboardingStep } from '@aisdlc/contracts';
import { STEP_STATE_TEXT, stepName } from '../vocab';
import { Badge } from './Badge';

/**
 * Steps 0.1 to 0.5 with their state. A step that was not requested is `skip`, shown with its
 * reason (`not_requested`: the level asked for does not include it); a blocked one with its cause.
 */
export function StepList({
  steps,
  waiting,
}: {
  steps: readonly OnboardingStep[];
  waiting: string | null;
}) {
  return (
    <ol className="steps" aria-label="Onboarding steps">
      {steps.map((s) => {
        const t = STEP_STATE_TEXT[s.state];
        const waitingHere = waiting !== null && waiting.startsWith(`${s.step} `);
        return (
          <li
            key={s.step}
            className={`step step-${s.state}`}
            data-step={s.step}
            data-state={s.state}
          >
            <div className="step-head">
              <span className="step-name">{stepName(s.step)}</span>
              <Badge tone={t.tone}>{t.label}</Badge>
            </div>
            {s.state === 'skip' ? (
              <p className="muted step-note">
                Reason: <code>not_requested</code> (the requested level does not include this step)
              </p>
            ) : null}
            {s.state === 'blocked' && s.blocked_cause !== null ? (
              <p className="step-note">
                Blocked: <code>{s.blocked_cause}</code>
              </p>
            ) : null}
            {waitingHere ? <p className="step-note">{waiting}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
