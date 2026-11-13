import { label, term, type GateId, type HandoffId, type StageId } from '@aisdlc/contracts';
import { useId, type ReactNode } from 'react';
import { CodeChip } from './term';

// Home's "needs you" table, the work item's stage strip and properties panel (skeleton screens 1 and 3). Every
// word a person reads comes from the glossary; the item's title and the project's name are data.

// ---------------------------------------------------------------- Needs you

/** What a row asks of the person, as a glossary value (never a code on screen; the gate's chip on request). */
export type NeedsYouKind =
  | { readonly kind: 'gate'; readonly gate: GateId }
  | { readonly kind: 'questions' }
  | { readonly kind: 'handoff'; readonly handoff: HandoffId }
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'access' };

export interface NeedsYouRow {
  readonly id: string;
  readonly kind: NeedsYouKind;
  /** The item's or card's title (data, shown as it is). */
  readonly what: string;
  readonly project: string;
  /** The item number, if the row is about an item. */
  readonly item?: string;
  readonly due: {
    /** "Due in 2 h", "Overdue by 1 working day" (the caller formats it, glossary §1). */
    readonly text: string;
    readonly overdue?: boolean;
    /** ISO time, for the order and the tooltip. */
    readonly at?: string;
  };
  readonly to: string;
  /** The one verb (defaults per kind: Decide, Answer, Choose, Review, Answer). */
  readonly verb?: string;
}

const KIND_TEXT = (k: NeedsYouKind): string => {
  switch (k.kind) {
    case 'gate':
      return label('gate', k.gate);
    case 'questions':
      return label('phase', 'Clarifying');
    case 'handoff':
      return label('handoff', k.handoff);
    case 'onboarding':
      return label('gate', 'M4');
    case 'access':
      return label('concept', 'access_request');
  }
};

const KIND_TIP = (k: NeedsYouKind): string => {
  switch (k.kind) {
    case 'gate':
      return term('gate', k.gate).explain;
    case 'questions':
      return term('phase', 'Clarifying').explain;
    case 'handoff':
      return term('handoff', k.handoff).explain;
    case 'onboarding':
      return term('gate', 'M4').explain;
    case 'access':
      return term('concept', 'access_request').explain;
  }
};

const DEFAULT_VERB: Readonly<Record<NeedsYouKind['kind'], string>> = {
  gate: 'Decide',
  questions: 'Answer',
  handoff: 'Choose',
  onboarding: 'Review',
  access: 'Answer',
};

/** Overdue first, then by due time; a row with no time last. */
export function orderNeedsYou(rows: readonly NeedsYouRow[]): NeedsYouRow[] {
  return [...rows].sort((a, b) => {
    if (!!a.due.overdue !== !!b.due.overdue) return a.due.overdue ? -1 : 1;
    if (a.due.at && b.due.at) return a.due.at.localeCompare(b.due.at);
    return a.due.at ? -1 : b.due.at ? 1 : 0;
  });
}

export function NeedsYouTable({
  rows,
  renderLink,
  showCodes = false,
  empty,
  caption = 'Needs you',
}: {
  rows: readonly NeedsYouRow[];
  renderLink: (to: string, children: ReactNode, className?: string) => ReactNode;
  /** Auditors: the approval's code chip after its name. */
  showCodes?: boolean;
  empty?: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0) {
    return <div className="ui-needs-empty">{empty ?? 'Nothing needs you.'}</div>;
  }
  return (
    <div className="ui-needs">
      <table className="ui-tbl ui-needs-tbl">
        <caption className="ui-sr">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">Item</th>
            <th scope="col">Project</th>
            <th scope="col">Due</th>
            <th scope="col">
              <span className="ui-sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orderNeedsYou(rows).map((r) => (
            <tr key={r.id} className={r.due.overdue ? 'ui-needs-late' : undefined}>
              <th scope="row" data-label="What">
                <span className="ui-needs-kind" title={KIND_TIP(r.kind)}>
                  {KIND_TEXT(r.kind)}
                  {showCodes && r.kind.kind === 'gate' ? (
                    <>
                      {' '}
                      <CodeChip code={r.kind.gate} />
                    </>
                  ) : null}
                </span>
              </th>
              <td data-label="Item">
                <span className="ui-needs-what">{r.what}</span>
                {r.item ? <span className="ui-needs-key">{r.item}</span> : null}
              </td>
              <td data-label="Project">{r.project}</td>
              <td data-label="Due">
                <span
                  className={r.due.overdue ? 'ui-needs-due ui-needs-due-late' : 'ui-needs-due'}
                  {...(r.due.at ? { title: r.due.at } : {})}
                >
                  {r.due.text}
                </span>
              </td>
              <td className="ui-needs-act">
                {renderLink(
                  r.to,
                  <>
                    {r.verb ?? DEFAULT_VERB[r.kind.kind]}
                    <span className="ui-sr">: {r.what}</span>
                  </>,
                  'ui-btn ui-btn-sm',
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Stage strip

/** The stages of a work item (onboarding is the repo's, not the item's; S8a/S8b only when releases are on). */
export const ITEM_STAGES: readonly StageId[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
];

export type StageMark = 'done' | 'now' | 'todo' | 'skipped';

const MARK_TEXT: Readonly<Record<StageMark, string>> = {
  done: 'done',
  now: 'now',
  todo: 'not started',
  skipped: 'not on this track',
};

/**
 * Where the work is: one cell per stage of its track, in order. The current stage is `aria-current="step"`; on a
 * phone only the current stage keeps its name and the strip reads "Stage 6 of 9: Build".
 */
export function StageStrip({
  stages = ITEM_STAGES,
  current,
  marks,
  waitingOn,
}: {
  stages?: readonly StageId[];
  /** `null`: the item has not started or has ended (every stage then reads from `marks`). */
  current: StageId | null;
  /** Overrides per stage; by default every stage before `current` is done and after it is to do. */
  marks?: Partial<Readonly<Record<StageId, StageMark>>>;
  /** What the current stage waits on ("Waiting for Alex Rivera"). */
  waitingOn?: string;
}) {
  const id = useId();
  const at = current ? stages.indexOf(current) : -1;
  const markOf = (s: StageId, i: number): StageMark =>
    marks?.[s] ?? (at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'now' : 'todo');
  return (
    <div className="ui-stages">
      <p id={id} className="ui-stages-sum">
        {at >= 0 && current
          ? `Stage ${at + 1} of ${stages.length}: ${label('stage', current)}`
          : 'Not started'}
        {waitingOn ? <span className="ui-stages-wait"> · {waitingOn}</span> : null}
      </p>
      <ol className="ui-stage-list" aria-labelledby={id}>
        {stages.map((s, i) => {
          const m = markOf(s, i);
          return (
            <li
              key={s}
              className={`ui-stage ui-stage-${m}`}
              title={term('stage', s).explain}
              {...(m === 'now' ? { 'aria-current': 'step' as const } : {})}
            >
              <span className="ui-stage-bar" aria-hidden="true" />
              <span className="ui-stage-name">{label('stage', s)}</span>
              <span className="ui-sr">, {MARK_TEXT[m]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- Properties

export interface Property {
  /** A glossary label ("Track", "Budget", "Rework limit"). */
  readonly label: string;
  readonly value: ReactNode;
}

/** The work item's (or project's) facts beside the content, and what this person may do. */
export function PropertiesPanel({
  title = 'Properties',
  rows,
  actions,
  actionsTitle = 'What you can do',
}: {
  title?: string;
  rows: readonly Property[];
  actions?: ReactNode;
  actionsTitle?: string;
}) {
  const id = useId();
  const aid = useId();
  return (
    <aside className="ui-props" aria-labelledby={id}>
      <h2 id={id} className="ui-props-h">
        {title}
      </h2>
      <dl className="ui-props-list">
        {rows.map((r) => (
          <div key={r.label} className="ui-props-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {actions ? (
        <section aria-labelledby={aid} className="ui-props-acts">
          <h3 id={aid} className="ui-props-h">
            {actionsTitle}
          </h3>
          <div className="ui-props-btns">{actions}</div>
        </section>
      ) : null}
    </aside>
  );
}
