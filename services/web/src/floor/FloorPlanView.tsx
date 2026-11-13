import {
  STEPS,
  StepIdValues,
  feasibilityFlagged,
  label,
  lookupTerm,
  type ActorKind,
  type FloorItem,
  type FloorMove,
  type FloorRoom,
  type FloorScoreChip,
  type FloorStage,
  type FloorView,
} from '@aisdlc/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ActorGlyph, laneFill } from '../ui';
import { FLOOR_ROOM_TEXT, FLOOR_STAGE_TEXT, FLOOR_STATUS_TEXT } from '../vocab';
import {
  BB,
  BT,
  CHIP_H,
  PLAN_H,
  PLAN_W,
  ROOMS,
  STATIONS,
  VX,
  Y1,
  Y2,
  gateSpots,
  initials,
  inPod,
  layoutChips,
  podBoxes,
  type Box,
  type GateSpot,
} from './geometry';

// The floor plan: belts, stations, gate positions, rooms, pods and the chips, drawn from the server's plan and items.
// Every station, room, gate and chip is a control (a button, or role=button with Enter and Space), so the whole plan
// is reachable by keyboard; hovering or focusing a chip highlights its own route.

export type FloorTarget =
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'station'; readonly stage: FloorStage }
  | { readonly kind: 'gate'; readonly key: string }
  | { readonly kind: 'room'; readonly room: FloorRoom };

/** The actors of a stage's steps (from the contracts), each kind once. */
function actorsOf(stage: FloorStage): ActorKind[] {
  const parts = new Set<string>();
  for (const id of StepIdValues) {
    const st = STEPS[id];
    const s = st.stage === 'S8a' || st.stage === 'S8b' ? 'S8' : st.stage;
    if (s === stage) for (const p of st.actor.split('+')) parts.add(p);
  }
  return (['A', 'D', 'H'] as const).filter((p) => parts.has(p));
}

const press = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

/** The point an item's node is drawn at, for a back-edge path. */
function nodePoint(
  t: string | null,
  spots: ReadonlyMap<string, GateSpot>,
): [number, number] | null {
  if (t === null) return null;
  const [kind, rest] = t.split(':', 2) as [string, string | undefined];
  if (rest === undefined) return null;
  if (kind === 'station' && rest in STATIONS) return centre(STATIONS[rest as FloorStage]);
  if (kind === 'room' && rest in ROOMS) return centre(ROOMS[rest as FloorRoom]);
  if (kind === 'gate') {
    const g = spots.get(rest);
    return g ? [g.x, g.y] : null;
  }
  return null;
}

/** An orthogonal path from one node to another over the bypass track nearest them. */
function edgePath(a: [number, number], b: [number, number]): { d: string; mid: [number, number] } {
  const track = a[1] < Y1 && b[1] < Y1 ? Y1 : Y2;
  const d = `M${a[0]} ${a[1]} V${track} H${b[0]} V${b[1]}`;
  return { d, mid: [(a[0] + b[0]) / 2, track] };
}

export interface FloorPlanProps {
  readonly view: FloorView;
  /** Lane fill groups shown; `null`: every lane. */
  readonly lanes: ReadonlySet<string> | null;
  readonly mineOnly: boolean;
  readonly showTags: boolean;
  readonly fit: boolean;
  readonly stale: boolean;
  /** The pods to draw (the coding cap); `known` is false when the sandbox-controller could not be asked. */
  readonly pods: { readonly count: number; readonly known: boolean };
  readonly onOpen: (t: FloorTarget) => void;
}

export function FloorPlanView(p: FloorPlanProps) {
  const { view } = p;
  const vp = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<FloorItem | null>(null);
  useLayoutEffect(() => {
    const el = vp.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = p.fit && width > 0 ? Math.min(1.2, width / PLAN_W) : 1;
  const chipTargets = CHIP_H * scale >= MIN_TARGET_PX;

  const spots = useMemo(() => gateSpots(view.plan.gates), [view.plan.gates]);
  const offGates = useMemo(() => new Set(view.gates_off ?? []), [view.gates_off]);
  const pods = useMemo(() => podBoxes(p.pods.count), [p.pods.count]);
  const chips = useMemo(() => layoutChips(view.items, spots, pods), [view.items, spots, pods]);
  const route = focus ? new Set(focus.route) : null;

  // drop the focus when its item leaves the floor
  useEffect(() => {
    if (focus && !view.items.some((i) => i.item_id === focus.item_id)) setFocus(null);
  }, [focus, view.items]);

  const here = (stage: FloorStage) =>
    view.items.filter((i) => i.node.kind === 'station' && i.node.stage === stage);
  const podItems = view.items.filter(inPod);
  const dim = (i: FloorItem) =>
    (p.lanes !== null && !p.lanes.has(laneFill(i.lane))) || (p.mineOnly && !i.mine);

  const shortcuts = useMemo(() => {
    // lanes that skip top-row stations, grouped by what they skip (from the plan's routes)
    const top: FloorStage[] = ['S2', 'S3', 'S4', 'S5'];
    const groups = new Map<string, string[]>();
    for (const l of view.plan.lanes) {
      const skipped = top.filter((s) => !l.route.includes(s));
      if (skipped.length === 0 || l.human_led) continue;
      const k = skipped.join(', ');
      groups.set(k, [...(groups.get(k) ?? []), l.lane]);
    }
    return [...groups.entries()].map(([skips, lanes]) => ({ skips, lanes }));
  }, [view.plan.lanes]);

  const edges = view.recent
    .slice(0, 4)
    .map((m: FloorMove, i) => {
      const a = nodePoint(m.from, spots);
      const b = nodePoint(m.to, spots);
      if (!a || !b) return null;
      return { m, old: i > 0, ...edgePath(a, b) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <div
      ref={vp}
      className={`fl-viewport${p.fit ? '' : ' fl-real'}${p.showTags ? '' : ' fl-notags'}${p.stale ? ' fl-stale' : ''}`}
      role="region"
      aria-label="Floor plan"
      // the plan scrolls inside its box at 100%: the box must be reachable by keyboard to scroll it
      tabIndex={p.fit ? undefined : 0}
    >
      <div className="fl-scale" style={{ width: PLAN_W * scale, height: PLAN_H * scale }}>
        <div
          className={`fl-plan${route ? ' fl-routing' : ''}`}
          style={{ transform: `scale(${scale})` }}
          data-testid="floor-plan"
        >
          <svg
            className="fl-svg"
            width={PLAN_W}
            height={PLAN_H}
            viewBox={`0 0 ${PLAN_W} ${PLAN_H}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="fl-ah"
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5L0 10z" className="fl-ah" />
              </marker>
            </defs>
            <g className="fl-dots">
              <line x1="30" y1={Y1} x2="1480" y2={Y1} />
              <line x1="30" y1={Y2} x2="1480" y2={Y2} />
              <line x1="30" y1={Y1} x2="30" y2={Y2} />
              <line x1="1480" y1={Y1 - 140} x2="1480" y2={Y2} />
            </g>
            <text className="fl-tracklbl" x="40" y={Y1 - 9}>
              off the main belt
            </text>
            <text className="fl-tracklbl" x="40" y={Y2 - 9}>
              off the main belt
            </text>
            <path className="fl-belt" d={`M14 ${BT} H${VX} V${BB} H52`} />
            <path className="fl-belt-run" d={`M14 ${BT} H${VX} V${BB} H52`} />
            <path
              className="fl-belt fl-belt-thin"
              d={`M144 ${STATIONS.S9.y + STATIONS.S9.h} V${ROOMS.DONE.y}`}
            />
            <g className="fl-edges">
              {edges.map((e) => (
                <path
                  key={`${e.m.item_id}-${e.m.at}-${e.m.edge}`}
                  className={`fl-back${e.old ? ' fl-old' : ''}`}
                  d={e.d}
                  markerEnd="url(#fl-ah)"
                />
              ))}
            </g>
          </svg>

          {view.plan.stations.map((id) => {
            const b = STATIONS[id];
            const items = here(id);
            const stuck = items.some((i) => i.status === 'stuck');
            return (
              <div
                key={id}
                className={`fl-st${id === 'S6' ? ' fl-s6' : ''}${route?.has(id) ? ' fl-onroute' : ''}`}
                role="button"
                tabIndex={0}
                // the name is the text shown, the stage's name (WCAG 2.5.3: no aria-label to drift from it); the
                // count, the score and the pods, hidden from the tree inside, are its description
                aria-describedby={`fl-st-d-${id}`}
                onClick={() => p.onOpen({ kind: 'station', stage: id })}
                onKeyDown={press(() => p.onOpen({ kind: 'station', stage: id }))}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                data-station={id}
              >
                <div className="fl-sthd">
                  <span
                    className={`fl-led${stuck ? ' fl-bad' : items.length > 0 ? ' fl-on' : ''}`}
                  />
                  <span className="fl-sp" />
                  <span aria-hidden="true">
                    <ScoreChip chips={view.scores.filter((c) => c.stage === id)} />
                  </span>
                  <span className="fl-acts" aria-hidden="true">
                    {actorsOf(id).map((a) => (
                      <ActorGlyph key={a} actor={a} />
                    ))}
                  </span>
                </div>{' '}
                <div className="fl-stname">{FLOOR_STAGE_TEXT[id]}</div>
                {id === 'S6'
                  ? pods.map((pod, i) => {
                      const it = podItems[i];
                      const label = !p.pods.known
                        ? `coding slot ${i + 1} of ${pods.length}, unknown`
                        : it
                          ? `coding slot ${i + 1} of ${pods.length}, ${it.key.slice(0, 4)}${it.step ? ` · ${it.step}` : ''}`
                          : `coding slot ${i + 1} of ${pods.length}, free`;
                      return (
                        <div
                          key={i}
                          className={`fl-pod${it ? ' fl-busy' : ''}${p.pods.known ? '' : ' fl-unknown'}`}
                          style={{
                            left: pod.x - b.x,
                            top: pod.y - b.y,
                            width: pod.w,
                            height: pod.h,
                          }}
                          data-pod={i + 1}
                          aria-hidden="true"
                        >
                          <span className="fl-podlbl ui-mono">{label}</span>
                        </div>
                      );
                    })
                  : null}
              </div>
            );
          })}
          {view.plan.stations.map((id) => (
            <span key={`d-${id}`} id={`fl-st-d-${id}`} className="ui-sr">
              {`${here(id).length} here${scoreText(view.scores.filter((c) => c.stage === id))}${id === 'S6' ? podText(pods.length, podItems, p.pods.known) : ''}. Open the station`}
            </span>
          ))}

          {(Object.keys(ROOMS) as FloorRoom[]).map((r) => {
            const b = ROOMS[r];
            const t = FLOOR_ROOM_TEXT[r];
            const n = view.items.filter((i) => i.node.kind === 'room' && i.node.room === r).length;
            return (
              <div
                key={r}
                className={`fl-room fl-room-${r.toLowerCase()}`}
                role="button"
                tabIndex={0}
                // named by its visible title and line (WCAG 2.5.3), the count is its description
                aria-describedby={`fl-room-d-${r}`}
                onClick={() => p.onOpen({ kind: 'room', room: r })}
                onKeyDown={press(() => p.onOpen({ kind: 'room', room: r }))}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                data-room={r}
              >
                <div className="fl-rt">{t.title}</div>
                {r === 'DONE' ? null : (
                  <>
                    {' '}
                    <div className="fl-rs">{t.sub}</div>
                  </>
                )}
                <span id={`fl-room-d-${r}`} className="ui-sr" aria-hidden="true">
                  {`${n} here. Open the room`}
                </span>
              </div>
            );
          })}

          {view.plan.gates.map((g) => {
            const s = spots.get(g.key);
            if (!s) return null;
            const waiting = view.items.filter(
              (i) => i.node.kind === 'gate' && i.node.key === g.key,
            );
            const who = [
              ...new Set(waiting.flatMap((i) => i.waiting_gates.flatMap((w) => w.deciders ?? []))),
            ];
            const unknown = waiting.some((i) => i.waiting_gates.some((w) => w.deciders === null));
            const flagged = waiting.flatMap((i) =>
              i.waiting_gates.filter((w) => feasibilityFlagged(w.feasibility)),
            );
            const onRoute = route?.has(g.key) ?? false;
            // P2-10: a gate the project's profile has off is drawn faint, unless an item (pinned before) waits there
            const off = offGates.has(g.key);
            return (
              <div
                key={g.key}
                className={`fl-gate fl-gate-${s.shape}${onRoute ? ' fl-onroute' : ''}${flagged.length > 0 ? ' fl-gate-flag' : ''}${off ? ' fl-gate-off' : ''}`}
                style={{ left: s.x, top: s.y }}
                data-gate={g.key}
                data-off={off ? 'true' : undefined}
                title={off ? `${g.key}: off for this project` : undefined}
              >
                <span className="fl-glbl ui-mono">{g.key}</span>
                <button
                  type="button"
                  className="fl-dia"
                  aria-label={`${g.gates.map((x) => label('gate', x)).join(' and ')}${off ? ' (off for this project)' : ''}: ${waiting.length} waiting${who.length ? `, decided by ${who.join(', ')}` : ''}${flagged.length > 0 ? `, ${flagged.length} cannot be decided as things stand` : ''}. Open the approval`}
                  onClick={() => p.onOpen({ kind: 'gate', key: g.key })}
                />
                {flagged.length > 0 ? (
                  <span
                    className="fl-flag"
                    aria-hidden="true"
                    title="No eligible decider, or the quorum cannot be met"
                  >
                    !
                  </span>
                ) : null}
                <span className="fl-who ui-mono" aria-hidden="true">
                  {who.map(initials).join(' ')}
                  {unknown ? ' ?' : ''}
                </span>
              </div>
            );
          })}

          <div className="fl-tags" aria-hidden="true">
            {shortcuts.map((s, i) => (
              <div
                key={s.skips}
                className="fl-tag fl-tag-short"
                style={{ left: 420 + i * 400, top: Y1 + (i % 2 === 0 ? -4 : 4) }}
              >
                {s.lanes.join(', ')}: skips {s.skips}
              </div>
            ))}
            {edges.map((e) => (
              <div
                key={`t-${e.m.item_id}-${e.m.at}-${e.m.edge}`}
                className={`fl-tag fl-tag-back${e.old ? ' fl-old' : ''}`}
                style={{ left: e.mid[0], top: e.mid[1] }}
              >
                {e.m.edge ?? e.m.kind} {e.m.key.slice(0, 4)}
              </div>
            ))}
          </div>

          <div className="fl-chips">
            {view.items.map((it) => {
              const c = chips.get(it.item_id);
              if (!c) return null;
              const where =
                it.node.kind === 'station'
                  ? FLOOR_STAGE_TEXT[it.node.stage]
                  : it.node.kind === 'gate'
                    ? 'an approval'
                    : FLOOR_ROOM_TEXT[it.node.room].title;
              const cls = [
                'fl-chip',
                dim(it) ? 'fl-dim' : null,
                it.waits_on_me ? 'fl-mine' : null,
                it.holds.length > 0 ? 'fl-hold' : null,
                it.status === 'stuck' ? 'fl-stuck' : null,
                focus?.item_id === it.item_id ? 'fl-focus' : null,
              ]
                .filter(Boolean)
                .join(' ');
              if (!chipTargets) {
                // smaller than a 24px target at this zoom: a picture of the item; its station, room or gate (whose
                // drawer lists it) is the control, and 100% makes every chip a button again (WCAG 2.5.8 equivalent)
                return (
                  <span
                    key={it.item_id}
                    className={`${cls} fl-chip-pic`}
                    style={{ left: c.x, top: c.y }}
                    aria-hidden="true"
                    data-chip={it.key}
                  >
                    <b className={`ui-chip-key ui-lane-${laneFill(it.lane)}`}>
                      {it.key.slice(0, 4)}
                    </b>
                    <u />
                  </span>
                );
              }
              return (
                <button
                  key={it.item_id}
                  type="button"
                  className={cls}
                  style={{ left: c.x, top: c.y }}
                  aria-label={`Item ${it.key}, ${lookupTerm('lane', it.lane)?.label ?? 'Unknown'}, ${FLOOR_STATUS_TEXT[it.status].label} at ${where}${it.title ? `: ${it.title}` : ''}`}
                  onClick={() => p.onOpen({ kind: 'item', id: it.item_id })}
                  onMouseEnter={() => setFocus(it)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(it)}
                  onBlur={() => setFocus(null)}
                  data-chip={it.key}
                >
                  <b className={`ui-chip-key ui-lane-${laneFill(it.lane)}`}>{it.key.slice(0, 4)}</b>
                  <u />
                </button>
              );
            })}
          </div>

          {focus ? (
            <div
              className="fl-tip"
              role="tooltip"
              style={{
                left: Math.min((chips.get(focus.item_id)?.x ?? 0) + 52, PLAN_W - 320),
                top: (chips.get(focus.item_id)?.y ?? 0) + 4,
              }}
            >
              <div>
                <b className="ui-mono">{focus.key}</b> · {lookupTerm('lane', focus.lane)?.label}
                {focus.lane_bound ? '' : ' (proposed)'} · {FLOOR_STATUS_TEXT[focus.status].label}
              </div>
              <div className="fl-tip-t">
                {focus.title ?? <span className="muted">Title hidden at your view level</span>}
              </div>
              <div className="ui-mono">
                {focus.stage ?? 'closed'}
                {focus.step ? ` · ${focus.step} ${STEPS[focus.step].title}` : ''}
              </div>
              <div className="muted ui-mono">route {focus.route.join(' → ')}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The score chip of a station (DM §5.3 floor overlay; the prototype's `fl-score`): the agent with the lowest score
 * there, its eval pass rate (or production acceptance) as `.NN`, marked low under the line in force. Agents with no
 * score yet draw no chip (the station drawer lists them as unknown).
 */
/** The smallest pointer target WCAG 2.2 AA allows (2.5.8), in CSS pixels. */
const MIN_TARGET_PX = 24;

/** The score chip of a station as words, for the station's name (the chip itself is hidden from the tree). */
function scoreText(chips: readonly FloorScoreChip[]): string {
  const w = chips
    .map((c) => ({ c, v: c.pass_rate ?? c.accept_rate }))
    .filter((x): x is { c: FloorScoreChip; v: number } => x.v !== null)
    .sort((a, b) => Number(b.c.low) - Number(a.c.low) || a.v - b.v)[0];
  return w ? `, agent ${w.c.agent_id} scores ${w.v.toFixed(2)}${w.c.low ? ' (low)' : ''}` : '';
}

function podText(
  count: number,
  items: ReadonlyArray<FloorItem | undefined>,
  known: boolean,
): string {
  if (!known) return `, ${count} coding slots, state unknown`;
  const busy = items.filter((x): x is FloorItem => x !== undefined);
  return `, ${count} coding slots, ${busy.length} busy${busy.length ? ` (${busy.map((x) => x.key.slice(0, 4)).join(', ')})` : ''}`;
}

export function ScoreChip({ chips }: { chips: readonly FloorScoreChip[] }) {
  const scored = chips
    .map((c) => ({ c, v: c.pass_rate ?? c.accept_rate }))
    .filter((x): x is { c: FloorScoreChip; v: number } => x.v !== null)
    .sort((a, b) => Number(b.c.low) - Number(a.c.low) || a.v - b.v);
  const w = scored[0];
  if (!w) return null;
  const text = w.v >= 1 ? '1.0' : w.v.toFixed(2).slice(1);
  return (
    <span
      className={`fl-score${w.c.low ? ' fl-score-low' : ''}`}
      data-score={w.c.agent_id}
      title={`${w.c.agent_id}${w.c.name ? ` ${w.c.name}` : ''}: ${w.c.pass_rate !== null ? 'eval pass rate' : 'acceptance'} ${w.v.toFixed(2)} (${w.c.status}${w.c.low ? ', low' : ''}; ${w.c.eval_signals} eval trials, ${w.c.production_signals} production runs)`}
    >
      {w.c.agent_id} {text}
      {w.c.low ? <span className="ui-sr"> low score</span> : null}
    </span>
  );
}
