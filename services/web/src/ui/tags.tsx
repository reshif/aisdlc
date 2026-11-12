import {
  GATES,
  LANE_LABELS,
  type ActorKind,
  type GateFamily,
  type GateId,
  type Lane,
} from '@aisdlc/contracts';
import type { ReactNode } from 'react';

// Pills, item chips, gate tags and actor glyphs. The values (gates, families, lanes, actors) are the
// contracts'; a `Record<Value, ...>` below only gives each one its look, and the compiler refuses a
// value the map does not cover.

export type PillTone =
  'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'agent' | 'human' | 'gate' | 'back' | 'mute';

/** A short status word. Colour repeats the word, it never replaces it. */
export function Pill({
  tone = 'neutral',
  plain,
  children,
  className,
}: {
  tone?: PillTone;
  plain?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const cls = [
    'ui-pill',
    tone === 'neutral' ? null : `ui-pill-${tone}`,
    plain ? 'ui-pill-plain' : null,
    className ?? null,
  ]
    .filter((c): c is string => c !== null)
    .join(' ');
  return <span className={cls}>{children}</span>;
}

/** The lane's fill on the floor: L1 to L3 share one, L4 and L5 another. */
const LANE_FILL: Readonly<Record<Lane, string>> = {
  L0: 'l0',
  L1: 'l13',
  L2: 'l13',
  L3: 'l13',
  L4: 'l45',
  L5: 'l45',
  L6: 'l6',
  L7: 'l7',
  L8: 'l8',
};

export const laneText = (lane: Lane): string => {
  const label = LANE_LABELS[lane];
  return label === null ? lane : `${lane} ${label}`;
};

/** An item's key in its lane's colour, with the lane named for people who do not see the colour. */
export function Chip({
  itemKey,
  lane,
  children,
}: {
  itemKey: string;
  lane?: Lane | null;
  children?: ReactNode;
}) {
  return (
    <span className="ui-chip" {...(lane ? { 'data-lane': lane } : {})}>
      <b
        className={`ui-chip-key${lane ? ` ui-lane-${LANE_FILL[lane]}` : ''}`}
        {...(lane ? { title: laneText(lane) } : {})}
      >
        {itemKey}
      </b>
      {lane ? <span className="ui-sr">lane {laneText(lane)}</span> : null}
      {children}
    </span>
  );
}

const FAMILY_TEXT: Readonly<Record<GateFamily, string>> = {
  stage: 'stage gate',
  action: 'action gate',
  exception: 'exception gate',
  meta: 'meta gate',
  quarantine: 'quarantine gate',
  onboarding: 'onboarding gate',
};

/** A gate by id, its shape coloured by family; the flow's title is the tooltip and the label. */
export function GateTag({ gate, showTitle }: { gate: GateId; showTitle?: boolean }) {
  const info = GATES[gate];
  const title = info.title ?? FAMILY_TEXT[info.family];
  return (
    <span
      className={`ui-gtag ui-gtag-${info.family}`}
      title={`${gate}: ${title}`}
      data-gate={gate}
      role="img"
      aria-label={`${gate}, ${FAMILY_TEXT[info.family]}: ${title}`}
    >
      <i aria-hidden="true" />
      <span aria-hidden="true">{gate}</span>
      {showTitle && info.title ? (
        <span className="ui-gtag-title" aria-hidden="true">
          {info.title}
        </span>
      ) : null}
    </span>
  );
}

type ActorPart = 'D' | 'A' | 'H';
const ACTOR_TEXT: Readonly<Record<ActorPart, string>> = {
  D: 'deterministic',
  A: 'agent',
  H: 'human',
};
const ACTOR_PATH: Readonly<Record<ActorPart, ReactNode>> = {
  D: (
    <rect
      x="4"
      y="4"
      width="12"
      height="12"
      rx="2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  ),
  A: <path d="M10 3l7 13H3z" fill="none" stroke="currentColor" strokeWidth="2" />,
  H: (
    <>
      <circle cx="10" cy="6.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 17c1-4 11-4 12 0" fill="none" stroke="currentColor" strokeWidth="2" />
    </>
  ),
};

/** Who acts at a step (contracts' `ActorKind`, e.g. `D+A`): one glyph per part, and the words. */
export function ActorGlyph({ actor }: { actor: ActorKind }) {
  const parts = actor.split('+') as ActorPart[];
  const words = parts.map((p) => ACTOR_TEXT[p]).join(' and ');
  return (
    <span
      className="ui-actor"
      role="img"
      aria-label={`acted by: ${words}`}
      title={words}
      data-actor={actor}
    >
      {parts.map((p) => (
        <svg key={p} viewBox="0 0 20 20" className={`ui-actor-${p}`} aria-hidden="true">
          {ACTOR_PATH[p]}
        </svg>
      ))}
    </span>
  );
}
