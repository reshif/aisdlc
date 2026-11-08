import { useState } from 'react';
import type { CardDetailWire } from '../api';
import { DecideShell } from './DecideShell';
import { DecidersLine, Section } from './shared';

// The security card, one finding (OB §5.3 item 11): counts only, never the value, the fingerprint or
// the path. The person rotates the credential first, then says what became of the finding.

interface SecrView {
  repo: string;
  ordinal: number;
  of: number;
  counts: Record<string, number>;
  states: Array<'rotated' | 'false_positive' | 'accepted_test_fixture'>;
  guidance: string;
}

const STATE_TEXT = {
  rotated: 'Rotated: I replaced the credential, the old one no longer works',
  false_positive: 'False positive: this is not a credential',
  accepted_test_fixture: 'Accepted test fixture: it is a fake value kept on purpose',
} as const;

export function SecrForm({ card, csrf }: { card: CardDetailWire; csrf: string }) {
  const v = card.view as unknown as SecrView;
  const [state, setState] = useState<SecrView['states'][number] | ''>('');
  const [reason, setReason] = useState('');
  const blocked = [
    ...(state === '' ? ['Choose what became of the finding.'] : []),
    ...(reason.trim() === '' ? ['Say what you did, in a sentence.'] : []),
  ];
  return (
    <>
      <p>
        Finding {v.ordinal} of {v.of} in {v.repo}. The value is never shown here and is never put in
        an issue.
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="this card" />
      <Section title="Findings in the history" id="secr-counts">
        <ul className="plain" aria-label="Finding counts">
          {Object.entries(v.counts).map(([k, n]) => (
            <li key={k}>
              {k.replace(/_/g, ' ')}: <strong>{n}</strong>
            </li>
          ))}
        </ul>
        <p>{v.guidance}</p>
      </Section>
      <Section title="What became of it" id="secr-decide">
        <fieldset className="options">
          <legend>State of this finding</legend>
          {v.states.map((s) => (
            <label key={s} className="radio">
              <input
                type="radio"
                name="finding-state"
                value={s}
                checked={state === s}
                onChange={() => setState(s)}
              />{' '}
              {STATE_TEXT[s]}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="secr-reason">
            What you did (kept with the finding, never shown here again)
          </label>
          <textarea
            id="secr-reason"
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Section>
      <DecideShell
        card={card}
        csrf={csrf}
        content={{ state, reason: reason.trim() }}
        blocked={blocked}
        approveLabel="Record this decision"
        onlyApprove
      />
    </>
  );
}
