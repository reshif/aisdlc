import { STEPS, type StepId } from '@aisdlc/contracts';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ActorGlyph } from './tags';

// Tabs, a timeline and a step list.

export interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * WAI-ARIA tabs: one tab stop, arrow keys (and Home, End) move between tabs, the panel is labelled
 * by its tab. The caller owns which tab is selected.
 */
export function Tabs({
  label,
  tabs,
  selected,
  onSelect,
  children,
}: {
  label: string;
  tabs: readonly TabDef[];
  selected: string;
  onSelect: (id: string) => void;
  /** The selected tab's panel. */
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const t = tabs[to];
    if (!t) return;
    onSelect(t.id);
    refs.current.get(t.id)?.focus();
  };
  return (
    <div>
      <div className="ui-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === selected}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {t.label}
            {t.count !== undefined ? <span className="ui-n">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${selected}`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

/** Who or what an event in a timeline is: the dot's shape and colour, and its words. */
export type TimelineKind = 'det' | 'agent' | 'human' | 'gate' | 'back' | 'bad';
const KIND_TEXT: Readonly<Record<TimelineKind, string>> = {
  det: 'factory',
  agent: 'agent',
  human: 'person',
  gate: 'gate',
  back: 'sent back',
  bad: 'stopped',
};

export interface TimelineEvent {
  readonly id: string;
  readonly when: string;
  readonly kind: TimelineKind;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
}

export function Timeline({ label, events }: { label: string; events: readonly TimelineEvent[] }) {
  return (
    <ol className="ui-tl" aria-label={label}>
      {events.map((e) => (
        <li key={e.id} data-kind={e.kind}>
          <span className="ui-tl-when">{e.when}</span>
          <span className={`ui-tl-dot ui-tl-${e.kind}`} aria-hidden="true" />
          <div>
            <span className="ui-sr">{KIND_TEXT[e.kind]}: </span>
            <div>{e.title}</div>
            {e.meta ? <div className="ui-tl-meta">{e.meta}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export type StepMark = 'done' | 'now' | 'todo';
const MARK_TEXT: Readonly<Record<StepMark, string>> = {
  done: 'done',
  now: 'current step',
  todo: 'to do',
};

/** Lifecycle steps by id: the title and the actor are the contracts' (`STEPS`). */
export function Steps({
  label,
  steps,
}: {
  label: string;
  steps: ReadonlyArray<{ readonly id: StepId; readonly mark: StepMark; readonly note?: ReactNode }>;
}) {
  return (
    <ol className="ui-steps" aria-label={label}>
      {steps.map((s) => (
        <li
          key={s.id}
          className={`ui-step-${s.mark}`}
          data-step-id={s.id}
          {...(s.mark === 'now' ? { 'aria-current': 'step' as const } : {})}
        >
          <span className="ui-step-id">{s.id}</span>
          <span>
            {STEPS[s.id].title}
            <span className="ui-sr"> ({MARK_TEXT[s.mark]})</span>
            {s.note ? <span className="ui-tl-meta"> {s.note}</span> : null}
          </span>
          <ActorGlyph actor={STEPS[s.id].actor} />
        </li>
      ))}
    </ol>
  );
}
