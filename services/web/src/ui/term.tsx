import { useId, useState } from 'react';
import {
  codeShows,
  lookupTerm,
  term as termOf,
  type GlossaryFamily,
  type GlossaryValue,
  type Term as GlossaryTerm,
} from '@aisdlc/contracts';

// The glossary on a screen (glossary.md §21): a value of a contract enum is shown by its plain label, with the
// one-sentence tooltip, and the code only where the glossary keeps it ("secondary": a small grey chip after the
// label; "audit": only on the audit screens). A component never prints a code itself.

/** Where a term is shown: an ordinary screen, or the audit screens (Decision log & audit, packs, exports). */
export type Audience = 'screen' | 'audit';

/** A code as a small grey monospace chip after its label (glossary §1: "Approve the plan `G3`"). */
export function CodeChip({ code }: { code: string }) {
  return <span className="ui-code">{code}</span>;
}

/**
 * The tooltip as a control: hover shows it (`title`), and a tap or Enter shows it as a note, so it works on a phone
 * and from the keyboard (glossary: "shown on hover, focus or tap").
 */
export function InfoTip({ about, text }: { about: string; text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="ui-info">
      <button
        type="button"
        className="ui-info-btn"
        aria-label={`About ${about}`}
        aria-expanded={open}
        aria-controls={id}
        title={text}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 11v6M12 7.5v.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span id={id} role="note" className={open ? 'ui-info-note' : 'ui-sr'}>
        {text}
      </span>
    </span>
  );
}

/**
 * A glossary term: its label, the tooltip on hover and focus (as `title` and a screen-reader description), and the
 * code chip when `showCode` is on and the glossary keeps the code for that audience.
 */
export function Term<F extends GlossaryFamily>({
  family,
  value,
  showCode = false,
  audience = 'screen',
}: {
  family: F;
  value: GlossaryValue<F>;
  showCode?: boolean;
  audience?: Audience;
}) {
  return (
    <TermView t={termOf(family, value)} code={value} showCode={showCode} audience={audience} />
  );
}

/** A value off the wire the compiler cannot check: an unknown value reads "Unknown", never the raw code. */
export function WireTerm({
  family,
  value,
  showCode = false,
  audience = 'screen',
}: {
  family: GlossaryFamily;
  value: string;
  showCode?: boolean;
  audience?: Audience;
}) {
  const t = lookupTerm(family, value);
  if (!t) return <span className="ui-term">Unknown</span>;
  return <TermView t={t} code={value} showCode={showCode} audience={audience} />;
}

function TermView({
  t,
  code,
  showCode,
  audience,
}: {
  t: GlossaryTerm;
  code: string;
  showCode: boolean;
  audience: Audience;
}) {
  const chip = showCode && codeShows(t, audience);
  return (
    <span className="ui-term" title={t.explain}>
      {t.label}
      {chip ? (
        <>
          {' '}
          <CodeChip code={code} />
        </>
      ) : null}
    </span>
  );
}
