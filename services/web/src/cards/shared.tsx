import { useId, type ReactNode } from 'react';
import type { CardDeciders } from '@aisdlc/contracts';

/** A checkbox with its words beside it; the label is the whole sentence the person attests to. */
export function Check({
  checked,
  onChange,
  disabled,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id}>{children}</label>
      {hint ? (
        <p id={`${id}-hint`} className="muted hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled one-line text input. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  disabled,
  type = 'text',
  min,
  max,
  invalid,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
  type?: 'text' | 'date';
  min?: string;
  max?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        min={min}
        max={max}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={
          [hint ? `${id}-hint` : '', describedBy ?? ''].join(' ').trim() || undefined
        }
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="muted hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <section className="card-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** A short hash for reading, with the whole of it available to a copy or a screen reader. */
export function Hash({ value, label }: { value: string; label?: string }) {
  return (
    <code className="hash" title={value} aria-label={label ? `${label} ${value}` : value}>
      {value}
    </code>
  );
}

export const ids = (text: string): string[] => [
  ...new Set(text.split(/[\s,]+/).filter((x) => x !== '')),
];

export const PRINCIPAL_RE = /^[A-Za-z0-9_.@-]{1,128}$/;

export function nameOf(names: Readonly<Record<string, string>>, id: string): string {
  const n = names[id];
  return n && n !== id ? `${n} (${id})` : id;
}

/** Who decides, in a sentence: the people, and what it means for how the decision is stamped. */
export function DecidersLine({
  who,
  names,
  what,
}: {
  who: CardDeciders;
  names: Readonly<Record<string, string>>;
  what: string;
}) {
  if (who.error !== null) {
    return (
      <p className="muted">
        Who decides {what}: not known right now ({who.error}). Nobody can decide it until that is
        known.
      </p>
    );
  }
  if (who.holders.length === 0) {
    return <p className="muted">Nobody holds the role that decides {what} yet.</p>;
  }
  return (
    <p>
      {what[0]?.toUpperCase()}
      {what.slice(1)} is decided by {who.holders.map((h) => nameOf(names, h)).join(', ')}
      {who.single_operator && !who.t2
        ? '. Only one person holds that role, so they decide alone and the ledger entry says so (sod_waiver).'
        : who.single_operator && who.t2
          ? '. A T2 project needs two people here, and only one holds the role, so nobody can decide it yet.'
          : '.'}
    </p>
  );
}

/** A flat record of counts and states as words (`status: ok, open: 0`): readable, and it wraps. */
export function countsText(o: Record<string, unknown> | null | undefined): string {
  if (!o) return 'none';
  return (
    Object.entries(o)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
      .join(', ') || 'none'
  );
}
