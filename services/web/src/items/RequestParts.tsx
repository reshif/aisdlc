import type { InjectionFlag, TaintedText } from '@aisdlc/contracts';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, KeyValue, Pill } from '../ui';

// What intake did with a request (FL S1 1.1, 1.2, B27), in the words the Ask-for-work receipt (P1-1) and the item
// page's Request tab (P2-1) both use: the text as the factory keeps it with its taint mark, the injection check, and
// the de-dupe links. Everything shown is from the answer; nothing is guessed.

const short = (hex: string): string => `${hex.slice(0, 12)}…`;

/** 1.1: the text as kept (normalised), its taint mark and provenance. `null` text: withheld, the hash shown. */
export function RequestTextCard({
  text,
  withheldSha,
  name,
  testId,
}: {
  text: TaintedText | null;
  /** The text is there but the person's data class does not reach it: its hash. */
  withheldSha?: string | null;
  name: (principal: string) => string;
  testId: string;
}) {
  if (text === null) {
    return (
      <Card title="The request text (1.1)" testId={testId}>
        {withheldSha ? (
          <p className="muted">
            The text is content of the work: it needs data class D1 on this project. Its hash is{' '}
            <code>sha256 {short(withheldSha)}</code>. <Link to="/me/access">See my access</Link>
          </p>
        ) : (
          <p className="muted">This item was raised by the factory: there is no request text.</p>
        )}
      </Card>
    );
  }
  return (
    <Card title="The text, as the factory keeps it (1.1)" testId={testId}>
      <pre className="ask-text" aria-label="The normalised text">
        {text.text}
      </pre>
      <KeyValue
        label="Taint mark"
        rows={[
          [
            'Taint',
            <>
              <Pill tone="warn">{text.taint}</Pill> {text.origin}: read as data, never obeyed
            </>,
          ],
          [
            'Channel',
            `${text.provenance.channel}${text.provenance.channel === 'N1' ? ' (portal Ask)' : ''}`,
          ],
          ['Received', shortTime(text.provenance.received_at)],
          ['From', name(text.provenance.submitted_by)],
          ['As sent', <code key="raw">sha256 {short(text.provenance.raw_sha256)}</code>],
          ['Normalised', <code key="norm">sha256 {short(text.provenance.normalised_sha256)}</code>],
        ]}
      />
    </Card>
  );
}

/** B27: the injection scan. `flags` are the text's (absent when the text is withheld: the rules stay). */
export function InjectionCard({
  suspected,
  flags,
  rules,
  testId,
}: {
  suspected: boolean;
  flags: readonly InjectionFlag[];
  rules?: readonly string[];
  testId: string;
}) {
  return (
    <Card title="Injection check (B27)" testId={testId}>
      {suspected ? (
        <>
          <p>
            <Pill tone="bad">flagged</Pill> The text looks like it tries to instruct the factory. It
            is fenced as data, and the G0 card shows these flags to its decider.
          </p>
          <ul className="plain" aria-label="Injection flags">
            {flags.length > 0
              ? flags.map((f) => (
                  <li key={`${f.rule}:${f.line}`}>
                    <code>{f.rule}</code> on line {f.line}
                  </li>
                ))
              : (rules ?? []).map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
          </ul>
        </>
      ) : (
        <p>
          <Pill tone="ok">none</Pill> Nothing in the text looks like an instruction to the factory.
        </p>
      )}
    </Card>
  );
}

/** 1.2: earlier items with the same text (linked, never merged), and items that may touch the same files. */
export function DuplicatesCard({
  links,
  conflicts = [],
  testId,
}: {
  links: readonly string[];
  conflicts?: readonly string[];
  testId: string;
}) {
  const item = (id: string) => (
    <li key={id}>
      <Link to={`/items/${id}`}>item {id.replace(/-/g, '').slice(0, 8)}</Link>
    </li>
  );
  return (
    <Card title="Duplicates (1.2)" testId={testId}>
      {links.length === 0 ? (
        <p className="muted">No earlier item on this repo has the same text.</p>
      ) : (
        <>
          <p>The same text was asked for before. The item is linked to:</p>
          <ul className="plain" aria-label="Linked items">
            {links.map(item)}
          </ul>
        </>
      )}
      {conflicts.length > 0 ? (
        <>
          <p>Open items on the same repo that may touch the same files:</p>
          <ul className="plain" aria-label="Possible conflicts">
            {conflicts.map(item)}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
