import {
  DEFAULT_SANDBOX_CAPS,
  STEPS,
  StepIdValues,
  feasibilityFlagged,
  label,
  lookupTerm,
  type FloorItem,
  type FloorKill,
  type FloorWaitingGate,
  type FloorStage,
  type FloorView,
  type GateId,
} from '@aisdlc/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, type Me } from '../api';
import { Loading, PageError } from '../components/Notice';
import { describeError } from '../format';
import { Link } from '../router';
import {
  ActorGlyph,
  Card,
  Drawer,
  EmptyState,
  GateTag,
  KeyValue,
  PageHead,
  Pill,
  Stat,
  Stats,
  Table,
  laneFill,
} from '../ui';
import { FLOOR_ROOM_TEXT, FLOOR_STAGE_TEXT, FLOOR_STATUS_TEXT } from '../vocab';
import { countByStatus, initials, inPod } from './geometry';
import { FloorPlanView, ScoreChip, type FloorTarget } from './FloorPlanView';
import './floor.css';

// The floor (PLAN M19; design reference docs/design/portal-prototype/src/floor.js): a project's items on belts,
// stations, gate positions and rooms, from the live read model the bff serves cut to the person (a viewer sees
// positions, never titles). The plan comes from the catalogue on the server. Live by polling with the last ETag; a
// read model that is behind, or a poll that fails, shows a stale banner and greys the plan: never data that only
// looks fresh.

/** How often the floor asks (an unchanged floor answers 304). */
export const FLOOR_POLL_MS = 5_000;

interface FloorData {
  readonly etag: string | null;
  readonly view: FloorView;
  /** When the bff last answered (200 or 304). */
  readonly checked_at: number;
}

function useFloor(project: string | null, live: boolean) {
  const qc = useQueryClient();
  const key = ['floor', project] as const;
  return useQuery<FloorData>({
    queryKey: key,
    enabled: project !== null,
    queryFn: async () => {
      const prev = qc.getQueryData<FloorData>(key);
      const r = await api.floor(project as string, prev?.etag ?? null);
      if (r.kind === 'not_modified') {
        if (prev) return { ...prev, checked_at: Date.now() };
        const again = await api.floor(project as string, null);
        if (again.kind === 'not_modified') throw new Error('the floor answered without a body');
        return { etag: again.etag, view: again.value, checked_at: Date.now() };
      }
      return { etag: r.etag, view: r.value, checked_at: Date.now() };
    },
    refetchInterval: live ? FLOOR_POLL_MS : false,
    retry: false,
  });
}

const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** A value off the wire in plain words; "Unknown" for one the glossary does not have. */
const words = (family: Parameters<typeof lookupTerm>[0], v: string | null | undefined): string =>
  v ? (lookupTerm(family, v)?.label ?? 'Unknown') : 'Unknown';

/** The phone (screen-map §2.17): the floor plan is desktop only; a phone gets the list of stuck and waiting items. */
export const PHONE_QUERY = '(max-width: 760px)';
function useNarrow(): boolean {
  const q = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(PHONE_QUERY).matches
      : false;
  const [narrow, setNarrow] = useState(q);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(PHONE_QUERY);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

/** The projects whose floor the person may open: every one with floor.read on the fleet, else the bound ones. */
function floorProjects(me: Me, all: readonly string[]): string[] {
  if (me.actions.fleet.includes('floor.read')) return [...all];
  const bound = me.actions.projects
    .filter((p) => p.actions.includes('floor.read'))
    .map((p) => p.project_id);
  return [...new Set([...all.filter((p) => bound.includes(p)), ...bound])];
}

export function FloorPage({ me }: { me: Me }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const ids = useMemo(
    () =>
      floorProjects(
        me,
        (projects.data ?? []).map((p) => p.project.project_id),
      ),
    [me, projects.data],
  );
  const asked = new URLSearchParams(window.location.search).get('project');
  const [picked, setPicked] = useState<string | null>(asked);
  const project = picked ?? ids[0] ?? null;
  const name =
    projects.data?.find((p) => p.project.project_id === project)?.project.name ?? project;

  if (projects.isPending && picked === null) return <Loading what="your projects" />;
  if (project === null) {
    return (
      <>
        <PageHead title={label('screen', 'floor')} />
        <EmptyState title="No work in progress">
          You can read no project's floor yet. A role on a project (a viewer is enough) opens its
          floor.
        </EmptyState>
      </>
    );
  }
  const choose = (p: string) => {
    setPicked(p);
    window.history.replaceState(null, '', `/floor?project=${encodeURIComponent(p)}`);
  };
  return (
    <FloorScreen
      key={project}
      project={project}
      name={name ?? project}
      choices={ids}
      onChoose={choose}
    />
  );
}

function FloorScreen(p: {
  project: string;
  name: string;
  choices: readonly string[];
  onChoose: (p: string) => void;
}) {
  const [live, setLive] = useState(true);
  const [fit, setFit] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 900,
  );
  const [tags, setTags] = useState(true);
  const [mineOnly, setMineOnly] = useState(false);
  const [lanes, setLanes] = useState<ReadonlySet<string> | null>(null);
  const [open, setOpen] = useState<FloorTarget | null>(null);
  const q = useFloor(p.project, live);
  const narrow = useNarrow();

  const head = (
    <PageHead
      title={`${label('screen', 'floor')}: ${p.name}`}
      sub="The live view of all work by stage, with what is stuck and where approvals wait. Approvals show the initials of the people they wait on. Open an item, a stage, an approval or a room for details."
      actions={
        p.choices.length > 1 ? (
          <label className="fl-pick">
            <span>{label('concept', 'project')}</span>
            <select value={p.project} onChange={(e) => p.onChoose(e.target.value)}>
              {p.choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    />
  );
  if (q.isPending)
    return (
      <>
        {head}
        <Loading what="the floor" />
      </>
    );
  if (!q.data) {
    return (
      <>
        {head}
        <PageError error={q.error} retry={() => void q.refetch()} />
      </>
    );
  }
  const { view, checked_at } = q.data;
  const behind = view.freshness.stale;
  const failing = q.isError;
  const stale = behind || failing;
  const counts = countByStatus(view.items);
  const groups = [...new Set(view.plan.lanes.map((l) => laneFill(l.lane)))];
  const lanesOfGroup = (g: string) =>
    view.plan.lanes.filter((l) => laneFill(l.lane) === g).map((l) => l.lane);
  const toggleGroup = (g: string) =>
    setLanes((cur) => {
      if (cur === null) return new Set([g]);
      if (cur.has(g) && cur.size === 1) return null;
      const n = new Set(cur);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  const pods = {
    count: view.sessions?.caps.coding ?? DEFAULT_SANDBOX_CAPS.coding,
    known: view.sessions !== null,
  };
  const waitingOnMe = view.items.filter((i) => i.waits_on_me);

  return (
    <>
      {head}
      <div className="fl-banners">
        <KillBanner kill={view.kill} name={p.name} />
        {behind ? (
          <div className="notice notice-attention fl-banner" role="status">
            <p>
              <b>{label('status', 'stale')}:</b> the floor is behind the record. Positions are{' '}
              {view.freshness.head_seq - view.freshness.as_of_seq} events behind; nothing here is
              current.
            </p>
          </div>
        ) : null}
        {failing ? (
          <div className="notice notice-attention fl-banner" role="status">
            <p>
              <b>{label('status', 'stale')}:</b> the floor could not be refreshed since{' '}
              {time(checked_at)} UTC ({describeError(q.error)}). What you see may have moved.
            </p>
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => void q.refetch()}>
              Try again
            </button>
          </div>
        ) : null}
        {!live ? (
          <div className="notice fl-banner" role="status">
            <p>
              <b>Paused:</b> not updating since {time(checked_at)} UTC.
            </p>
          </div>
        ) : null}
        {view.controls.map((c) => (
          <div key={c.control_id} className="notice notice-attention fl-banner">
            <p>
              <b>
                {words('controlKind', c.kind)}: {c.scope.ref}
              </b>
              {c.expires_at ? ` until ${c.expires_at.slice(0, 16).replace('T', ' ')} UTC` : ''}.
              Items it covers stay where they are.{' '}
              <Link to="/controls">{label('screen', 'controls')}</Link>
            </p>
          </div>
        ))}
        {view.view_level === 'V1' ? (
          <div className="notice fl-banner">
            <p>
              You see this floor as a viewer: positions, tracks and who an approval waits on. Titles
              and content stay hidden ({words('dataClass', view.data_class).toLowerCase()}).
            </p>
          </div>
        ) : null}
        {waitingOnMe.length > 0 ? (
          <Link to="/inbox" className="fl-wait">
            <b>Waiting on you:</b> {waitingOnMe.length} item{waitingOnMe.length === 1 ? '' : 's'} at
            an approval you decide. Open your inbox
          </Link>
        ) : null}
      </div>

      <div className="fl-bar">
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          aria-pressed={live}
          onClick={() => setLive((v) => !v)}
        >
          {live ? (
            <>
              <span className={`fl-live${stale ? ' fl-live-stale' : ''}`} aria-hidden="true" />{' '}
              {stale ? label('status', 'stale') : 'Live'}
            </>
          ) : (
            'Resume'
          )}
        </button>
        <div className="fl-lanes" role="group" aria-label="Tracks">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              className="fl-lanebtn"
              aria-pressed={lanes === null || lanes.has(g)}
              onClick={() => toggleGroup(g)}
            >
              <i className={`ui-lane-${g}`} aria-hidden="true" />
              {lanesOfGroup(g)
                .map((l) => words('lane', l))
                .join(', ')}
            </button>
          ))}
        </div>
        <span className="fl-sp" />
        <span className="fl-counts" aria-label="Items by status">
          <Pill tone="info">{counts.working} working</Pill>
          <Pill tone="gate">{counts.waiting} waiting</Pill>
          <Pill tone="back">{counts.held} on hold</Pill>
          <Pill tone="bad">{counts.stuck} stuck</Pill>
        </span>
        <div className="fl-seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={tags} onClick={() => setTags((v) => !v)}>
            Tags
          </button>
          <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)}>
            Mine
          </button>
        </div>
        <div className="fl-seg" role="group" aria-label="Zoom">
          <button type="button" aria-pressed={fit} onClick={() => setFit(true)}>
            Fit
          </button>
          <button type="button" aria-pressed={!fit} onClick={() => setFit(false)}>
            100%
          </button>
        </div>
      </div>

      {narrow ? (
        <Card title="Stuck and waiting" testId="floor-phone">
          <p className="muted">
            The floor plan needs a wider screen; here is what is stuck or waits.
          </p>
          <ItemList
            items={view.items.filter(
              (i) => i.status === 'stuck' || i.status === 'waiting' || i.status === 'held',
            )}
            onOpen={setOpen}
          />
        </Card>
      ) : (
        <FloorPlanView
          view={view}
          lanes={lanes}
          mineOnly={mineOnly}
          showTags={tags}
          fit={fit}
          stale={stale}
          pods={pods}
          onOpen={setOpen}
        />
      )}

      <ul className="fl-legend">
        <li>
          <i className="fl-lg-belt" aria-hidden="true" />
          Solid grey: the main belt, forward moves
        </li>
        <li>
          <i className="fl-lg-dot" aria-hidden="true" />
          Dotted: every move off the main belt
        </li>
        <li>
          <i className="fl-lg-back" aria-hidden="true" />
          Orange: sent back (the last 24 hours)
        </li>
        <li>
          <i className="fl-lg-mine" aria-hidden="true" />
          Gold ring: waiting on you
        </li>
        <li>
          <ActorGlyph actor="A" /> agent · <ActorGlyph actor="D" /> the factory ·{' '}
          <ActorGlyph actor="H" /> person
        </li>
        <li>
          <i className="fl-lg-flag" aria-hidden="true">
            !
          </i>
          An approval nobody can decide as things stand
        </li>
        <li>
          <span className="fl-score">.90</span> the lowest agent score at a stage;{' '}
          <span className="fl-score fl-score-low">.62</span> below {view.liveness.low_score}
        </li>
        <li className="muted">
          Stuck: in a session and silent for more than {view.liveness.silence_minutes} min
          {Object.keys(view.liveness.by_stage).length > 0
            ? ` (${Object.entries(view.liveness.by_stage)
                .map(([k, v]) => `${words('stage', k)} ${v} min`)
                .join(', ')})`
            : ''}
          {view.liveness.source === 'config'
            ? ' (set in Settings)'
            : view.liveness.source === 'unreadable'
              ? ' (the setting could not be read: the defaults are used)'
              : ' (default)'}
          .
        </li>
        <li className="muted">
          Stages and approvals come from process version {view.plan.catalogue.version}; each item
          follows the route of its own process version.
        </li>
      </ul>

      <div className="fl-below">
        <Card title="Sent back and moved track, last 24 hours" flush>
          {view.recent.length === 0 ? (
            <p className="fl-pad muted">None in the last 24 hours.</p>
          ) : (
            <ol className="fl-log">
              {view.recent.slice(0, 12).map((m) => (
                <li key={`${m.item_id}-${m.at}-${m.edge}-${m.kind}`}>
                  <span className="ui-mono muted">{m.at.slice(11, 19)}</span>
                  <span>
                    <Pill tone="back">
                      {m.edge
                        ? ((lookupTerm('backEdge', m.edge) ?? lookupTerm('relane', m.edge))
                            ?.label ?? 'Moved')
                        : words('floorMove', m.kind)}
                    </Pill>{' '}
                    <button
                      type="button"
                      className="fl-link"
                      onClick={() => setOpen({ kind: 'item', id: m.item_id })}
                    >
                      {m.key}
                    </button>{' '}
                    <span className="muted">
                      {m.from ? words('phase', m.from) : 'Unknown'} →{' '}
                      {m.to ? words('phase', m.to) : 'Unknown'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="Flow, last 24 hours">
          <FlowBlock view={view} />
        </Card>
        <Card title="Stages" flush>
          <StationTable items={view.items} stations={view.plan.stations} />
        </Card>
        <Card title={label('screen', 'sandboxes')}>
          {view.sessions === null ? (
            <p>
              <Pill tone="mute">{label('status', 'unknown')}</Pill> The sandboxes did not answer:
              the free slots are unknown, and unknown is treated as none free.
            </p>
          ) : (
            <KeyValue
              label="Sessions per class"
              rows={Object.entries(view.sessions.used).map(([c, n]) => [
                words('sandboxClass', c),
                `${n} running, ${view.sessions?.free[c as 'W'] ?? 0} free`,
              ])}
            />
          )}
        </Card>
      </div>

      <FloorDrawer view={view} target={open} onClose={() => setOpen(null)} onOpen={setOpen} />
    </>
  );
}

/** The kill banner (AR9): a kill covering the project, or a kill switch that could not be asked, which reads killed. */
export function KillBanner({ kill, name }: { kill: FloorKill; name: string }) {
  if (!kill.killed) return null;
  return (
    <div className="notice notice-bad fl-banner fl-kill" role="alert">
      <p>
        {kill.state === 'killed' ? (
          <>
            <b>Agents stopped on {name}.</b> No agent work starts; items stay where they are until
            two people release the stop.
          </>
        ) : (
          <>
            <b>{label('concept', 'kill_unreachable')}.</b> No agent work starts until it answers.
          </>
        )}{' '}
        <Link to="/kill">{label('screen', 'emergency_stop')}</Link>
      </p>
    </div>
  );
}

const minutes = (s: number) => `${Math.floor(s / 60)} min`;

function activityText(it: FloorItem): string {
  const a = it.activity;
  if (!a) return 'not in a session';
  const last = a.last_at
    ? `last activity ${a.last_at.slice(11, 19)} UTC (${a.source ?? 'unknown'})`
    : 'no activity since it entered';
  return `${last}; silent ${minutes(a.silent_for_s)} of ${minutes(a.stuck_after_s)}${a.silent ? ': stuck' : ''}`;
}

function FeasibilityNote({ g }: { g: FloorWaitingGate }) {
  if (!feasibilityFlagged(g.feasibility)) return null;
  return (
    <>
      {' '}
      <Pill tone="bad">{words('feasibility', g.feasibility)}</Pill>{' '}
      <span className="muted">{g.feasibility_reason ?? ''}</span>
    </>
  );
}

function AgentsAt({ chips }: { chips: FloorView['scores'] }) {
  if (chips.length === 0) return null;
  return (
    <Card title="Agents at this station">
      <ul className="fl-list">
        {chips.map((c) => (
          <li key={c.agent_id} className="fl-li">
            <ActorGlyph actor="A" /> <b className="ui-mono">{c.agent_id}</b>
            <span className="fl-li-t">
              {c.name ?? ''}{' '}
              <span className="muted ui-mono">
                {c.score_id === null
                  ? 'no score for the current prompt yet'
                  : `${c.provider}/${c.model} · ${c.eval_signals} eval trials, ${c.production_signals} production runs`}
              </span>
            </span>
            {c.score_id === null ? (
              <Pill tone="mute">unknown</Pill>
            ) : (
              <>
                <ScoreChip chips={[c]} />
                <Pill tone={c.low ? 'bad' : c.status === 'pass' ? 'ok' : 'warn'}>{c.status}</Pill>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FlowBlock({ view }: { view: FloorView }) {
  const sum = (k: 'F' | 'B' | 'R') => view.flow.reduce((n, h) => n + h[k], 0);
  const max = Math.max(1, ...view.flow.map((h) => h.F));
  const w = 420;
  const h = 80;
  const bw = w / Math.max(1, view.flow.length);
  return (
    <>
      <Stats label="Moves in the last 24 hours">
        <Stat label="Forward" value={sum('F')} />
        <Stat
          label="Sent back"
          value={sum('B')}
          {...(sum('B') > 0 ? { tone: 'warn' as const } : {})}
        />
        <Stat label="Moved track" value={sum('R')} />
      </Stats>
      <svg
        className="fl-flow"
        viewBox={`0 0 ${w} ${h + 18}`}
        role="img"
        aria-label={`Forward moves per hour over the last 24 hours: ${sum('F')} in all, ${sum('B')} sent back`}
      >
        {view.flow.map((x, i) => (
          <g key={x.hour}>
            <rect
              x={i * bw + 1.5}
              y={h - (x.F / max) * h * 0.9}
              width={Math.max(1, bw - 3)}
              height={(x.F / max) * h * 0.9}
              rx="1.5"
              className="fl-flow-f"
            />
            {x.B > 0 ? (
              <rect
                x={i * bw + 1.5}
                y={h + 3}
                width={Math.max(1, bw - 3)}
                height="4"
                className="fl-flow-b"
              />
            ) : null}
          </g>
        ))}
        <text x="0" y={h + 17} className="fl-flow-t">
          −24h
        </text>
        <text x={w} y={h + 17} textAnchor="end" className="fl-flow-t">
          now
        </text>
      </svg>
    </>
  );
}

function StationTable({
  items,
  stations,
}: {
  items: readonly FloorItem[];
  stations: readonly FloorStage[];
}) {
  const rows = stations.map((s) => {
    const here = items.filter(
      (i) => i.stage === s && i.status !== 'done' && i.status !== 'declined',
    );
    return {
      s,
      n: here.length,
      waiting: here.filter((i) => i.status === 'waiting').length,
      stuck: here.filter((i) => i.status === 'stuck').length,
    };
  });
  return (
    <Table
      caption="Items per station"
      captionHidden
      rowKey={(r) => r.s}
      rows={rows}
      columns={[
        {
          key: 's',
          header: 'Stage',
          rowHeader: true,
          render: (r) => FLOOR_STAGE_TEXT[r.s],
        },
        { key: 'n', header: 'In', align: 'right', render: (r) => r.n },
        { key: 'w', header: 'Waiting', align: 'right', render: (r) => r.waiting },
        {
          key: 'x',
          header: 'Stuck',
          align: 'right',
          render: (r) => (r.stuck > 0 ? <Pill tone="bad">{r.stuck}</Pill> : 0),
        },
      ]}
    />
  );
}

function ItemRow({ it, onOpen }: { it: FloorItem; onOpen: (t: FloorTarget) => void }) {
  return (
    <li className="fl-li">
      <button
        type="button"
        className="fl-link"
        onClick={() => onOpen({ kind: 'item', id: it.item_id })}
      >
        <b className={`ui-chip-key ui-lane-${laneFill(it.lane)}`}>{it.key}</b>
      </button>
      <span className="fl-li-t">
        {it.title ?? <span className="muted">Title hidden</span>}
        <span className="muted">
          {' '}
          {it.step ? words('step', it.step) : ''}
          {it.waiting_gates.length > 0
            ? ` · waits on ${[...new Set(it.waiting_gates.flatMap((w) => w.deciders ?? ['?']))].join(', ')}`
            : ''}
        </span>
      </span>
      <Pill tone={FLOOR_STATUS_TEXT[it.status].tone}>{FLOOR_STATUS_TEXT[it.status].label}</Pill>
    </li>
  );
}

function ItemList({
  items,
  onOpen,
}: {
  items: readonly FloorItem[];
  onOpen: (t: FloorTarget) => void;
}) {
  if (items.length === 0) return <p className="muted">Nothing here right now.</p>;
  return (
    <ul className="fl-list">
      {items.map((i) => (
        <ItemRow key={i.item_id} it={i} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function FloorDrawer({
  view,
  target,
  onClose,
  onOpen,
}: {
  view: FloorView;
  target: FloorTarget | null;
  onClose: () => void;
  onOpen: (t: FloorTarget) => void;
}) {
  if (target === null) return null;
  if (target.kind === 'item') {
    const it = view.items.find((i) => i.item_id === target.id);
    if (!it) {
      return (
        <Drawer open title="Item" onClose={onClose}>
          <p className="muted">This item is no longer on the floor.</p>
        </Drawer>
      );
    }
    const where =
      it.node.kind === 'station'
        ? FLOOR_STAGE_TEXT[it.node.stage]
        : it.node.kind === 'gate'
          ? `at the approval ${it.node.key}`
          : FLOOR_ROOM_TEXT[it.node.room].title;
    const at =
      it.node.kind === 'gate' ? it.node.key : it.node.kind === 'station' ? it.node.stage : null;
    return (
      <Drawer open title={`Item ${it.key}`} onClose={onClose}>
        <p>
          {it.title ?? (
            <span className="muted">Title hidden at your view level and data class.</span>
          )}
        </p>
        <KeyValue
          label="Where the item is"
          rows={[
            [
              label('concept', 'lane'),
              `${words('lane', it.lane)}${it.lane_bound ? '' : ' (proposed: accepting the request confirms it)'}`,
            ],
            ['Where', where],
            ['Step', it.step ? words('step', it.step) : '—'],
            [
              'Status',
              <Pill key="s" tone={FLOOR_STATUS_TEXT[it.status].tone}>
                {FLOOR_STATUS_TEXT[it.status].label}
              </Pill>,
            ],
            ['Waits for', it.waiting ?? '—'],
            [
              label('status', 'held'),
              it.holds.length > 0 ? it.holds.map((h) => words('hold', h.reason)).join(', ') : 'No',
            ],
            ['Session', activityText(it)],
            [
              'Requested by',
              it.requester ?? (
                <span key="r" className="muted">
                  hidden
                </span>
              ),
            ],
            [label('concept', 'catalogue'), it.catalogue_version],
          ]}
        />
        {it.waiting_gates.length > 0 ? (
          <Card title="Approvals it waits for">
            <ul className="fl-list">
              {it.waiting_gates.map((g) => (
                <li key={g.gate_instance_id} className="fl-li">
                  <GateTag gate={g.gate} showTitle />
                  <span className="fl-li-t">
                    {g.deciders === null
                      ? 'who decides it could not be read (unknown)'
                      : g.deciders.length === 0
                        ? 'nobody holds the role: it cannot be decided'
                        : `decided by ${g.deciders.join(', ')} (${words('roleSlot', g.slot)})`}
                    <FeasibilityNote g={g} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card title="Its route">
          <ol className="fl-route">
            {it.route.map((k, i) => (
              <li key={`${k}-${i}`} className={k === at ? 'fl-route-now' : undefined}>
                <span>{lookupTerm('stage', k)?.label ?? lookupTerm('gate', k)?.label ?? k}</span>
              </li>
            ))}
          </ol>
        </Card>
        <p>
          <Link to={`/items/${it.item_id}`} className="ui-btn">
            Open the item
          </Link>
        </p>
      </Drawer>
    );
  }
  if (target.kind === 'station') {
    const s = target.stage;
    const items = view.items.filter((i) => i.node.kind === 'station' && i.node.stage === s);
    const steps = StepIdValues.filter((id) => {
      const st = STEPS[id].stage;
      return (st === 'S8a' || st === 'S8b' ? 'S8' : st) === s;
    });
    return (
      <Drawer open title={FLOOR_STAGE_TEXT[s]} onClose={onClose}>
        <Stats label="This station">
          <Stat label="Here now" value={items.length} />
          <Stat label="In a sandbox" value={items.filter(inPod).length} />
          <Stat
            label="Stuck"
            value={items.filter((i) => i.status === 'stuck').length}
            {...(items.some((i) => i.status === 'stuck') ? { tone: 'bad' as const } : {})}
          />
        </Stats>
        <Card title="Items">
          <ItemList items={items} onOpen={onOpen} />
        </Card>
        <AgentsAt chips={view.scores.filter((c) => c.stage === s)} />
        <Card title="Steps">
          <ol className="fl-steps">
            {steps.map((id) => (
              <li key={id}>
                {words('step', id)} <ActorGlyph actor={STEPS[id].actor} />
              </li>
            ))}
          </ol>
        </Card>
      </Drawer>
    );
  }
  if (target.kind === 'gate') {
    const g = view.plan.gates.find((x) => x.key === target.key);
    const items = view.items.filter((i) => i.node.kind === 'gate' && i.node.key === target.key);
    const lanes = view.plan.lanes.filter((l) => l.route.includes(target.key)).map((l) => l.lane);
    return (
      <Drawer
        open
        title={(g?.gates ?? []).map((x: GateId) => label('gate', x)).join(' and ') || 'Approval'}
        onClose={onClose}
      >
        <p>
          {(g?.gates ?? []).map((x: GateId) => (
            <span key={x} className="fl-gtitle">
              <GateTag gate={x} /> {label('gate', x)}
            </span>
          ))}
        </p>
        <KeyValue
          label="The gate"
          rows={[
            ['After', g ? words('step', g.after_step) : '—'],
            [
              'On the tracks',
              lanes.length > 0
                ? lanes.map((l) => words('lane', l)).join(', ')
                : 'no track of this process version',
            ],
            [
              'For this project',
              (view.gates_off ?? []).includes(target.key)
                ? 'Off for this project (an item that started before keeps it)'
                : 'On where the track has it',
            ],
            ['If nobody decides', 'The backup is told after a working day; expiry never approves'],
          ]}
        />
        {items.some((i) => i.waiting_gates.some((w) => feasibilityFlagged(w.feasibility))) ? (
          <div className="notice notice-bad" role="status">
            <p>
              <b>Cannot be decided as things stand:</b>{' '}
              {[
                ...new Set(
                  items.flatMap((i) =>
                    i.waiting_gates
                      .filter((w) => feasibilityFlagged(w.feasibility))
                      .map(
                        (w) => `${label('gate', w.gate)}: ${words('feasibility', w.feasibility)}`,
                      ),
                  ),
                ),
              ].join('; ')}
              . A person must be given the role; expiry never approves.
            </p>
          </div>
        ) : null}
        <Card title={`Waiting here · ${items.length}`}>
          <ItemList items={items} onOpen={onOpen} />
          {items.length > 0 ? (
            <p className="muted">
              Decide from your <Link to="/inbox">inbox</Link> or the item page. Waiting on:{' '}
              {[...new Set(items.flatMap((i) => i.waiting_gates.flatMap((w) => w.deciders ?? [])))]
                .map((w) => `${w} (${initials(w)})`)
                .join(', ') || 'unknown'}
            </p>
          ) : null}
        </Card>
      </Drawer>
    );
  }
  const r = target.room;
  const t = FLOOR_ROOM_TEXT[r];
  const items = view.items.filter((i) => i.node.kind === 'room' && i.node.room === r);
  return (
    <Drawer open title={t.title} onClose={onClose}>
      <p className="muted">{t.sub}</p>
      <div className="notice">
        <p>{t.next}</p>
      </div>
      <Card title={`Items · ${items.length}`}>
        <ItemList items={items} onOpen={onOpen} />
      </Card>
    </Drawer>
  );
}
