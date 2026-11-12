import type { FleetView, FloorProject, FloorStage } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Loading, PageError } from '../components/Notice';
import { Link } from '../router';
import { EmptyState, PageHead, Pill, Stat, Stats, laneFill, laneText } from '../ui';
import { FLOOR_STAGE_TEXT } from '../vocab';
import './floor.css';

// The fleet (PLAN M19, DM FloorProject; design reference docs/design/portal-prototype/src/floor.js `fleetRender`): every
// project the person may see as one row, its stations with counts, the gates with items waiting, the rooms, and what
// is stuck, flagged or killed. Counts only: no item key or title. A confidential project the person has no role in
// is collapsed to how many items are in flight (the bff cuts it; the screen never has more).

export const FLEET_POLL_MS = 15_000;

function Belt({ row, view }: { row: FloorProject; view: FleetView }) {
  // the stations in plan order, each followed by the gates the plan puts after it
  const cells: Array<{ kind: 'st'; s: FloorStage } | { kind: 'g'; key: string }> = [];
  for (const s of view.plan.stations) {
    cells.push({ kind: 'st', s });
    for (const g of view.plan.gates.filter((x) => x.after_stage === s)) {
      cells.push({ kind: 'g', key: g.key });
    }
  }
  return (
    <ol className="fx-belt" aria-label={`Stations of ${row.name}`}>
      {cells.map((c) => {
        if (c.kind === 'g') {
          const n = row.gates[c.key] ?? 0;
          return (
            <li
              key={`g-${c.key}`}
              className={`fx-g${n > 0 ? ' fx-on' : ''}`}
              title={`Gate ${c.key}`}
              aria-label={`Gate ${c.key}: ${n} waiting`}
            >
              {n > 0 ? <b>{n}</b> : null}
            </li>
          );
        }
        const n = row.stations[c.s] ?? 0;
        const stuck = row.stuck_at.includes(c.s);
        return (
          <li
            key={c.s}
            className={`fx-st${n > 0 ? ' fx-on' : ''}${stuck ? ' fx-bad' : ''}`}
            title={`${c.s} ${FLOOR_STAGE_TEXT[c.s]}`}
            aria-label={`${c.s} ${FLOOR_STAGE_TEXT[c.s]}: ${n} here${stuck ? ', one stuck' : ''}`}
          >
            <span className="ui-mono">{c.s}</span>
            <b className="fx-n">{n > 0 ? n : ''}</b>
          </li>
        );
      })}
    </ol>
  );
}

function Row({ row, view }: { row: FloorProject; view: FleetView }) {
  const head = (
    <div className="fx-name">
      <h3>
        {row.collapsed === null ? (
          <Link to={`/floor?project=${encodeURIComponent(row.project_id)}`}>{row.name}</Link>
        ) : (
          row.name
        )}
      </h3>
      <div className="fx-tags">
        {row.level ? <Pill tone={row.level === 'full' ? 'ok' : 'info'}>{row.level}</Pill> : null}
        {row.classification === 'confidential' ? <Pill tone="mute">confidential</Pill> : null}
        {row.kill.killed ? (
          <Pill tone="bad">
            {row.kill.state === 'killed' ? 'killed' : 'kill switch unreachable'}
          </Pill>
        ) : null}
      </div>
    </div>
  );
  if (row.collapsed !== null) {
    return (
      <li className="fx-row fx-restricted" data-project={row.opaque_key}>
        {head}
        <div className="fx-hidden">
          {row.in_flight} item{row.in_flight === 1 ? '' : 's'} in flight · positions hidden (
          {row.collapsed === 'confidential'
            ? 'confidential: you hold no role in this project'
            : 'you may not read its floor'}
          )
        </div>
        <div className="fx-side" />
      </li>
    );
  }
  const room = (n: number | undefined, label: string, tone: 'back' | 'bad' | 'info' | 'mute') =>
    n ? (
      <Pill tone={tone}>
        {n} {label}
      </Pill>
    ) : null;
  return (
    <li className="fx-row" data-project={row.opaque_key}>
      {head}
      <div className="fx-mid">
        <Belt row={row} view={view} />
        <div className="fx-lanes" aria-label="Lanes in flight">
          {row.lanes.map((l) => (
            <i key={l} className={`ui-lane-${laneFill(l)}`} title={laneText(l)} />
          ))}
        </div>
      </div>
      <div className="fx-side">
        <div className="fx-rooms">
          {room(row.rooms.HOLD, 'held', 'back')}
          {room(row.rooms.QUAR, 'quarantined', 'bad')}
          {room(row.rooms.DESK, 'handoff', 'info')}
          {room(row.rooms.SCHED, 'scheduled', 'mute')}
          {row.status.stuck > 0 ? <Pill tone="bad">{row.status.stuck} stuck</Pill> : null}
          {row.infeasible_gates > 0 ? (
            <Pill tone="bad">
              {row.infeasible_gates} gate{row.infeasible_gates === 1 ? '' : 's'} nobody can decide
            </Pill>
          ) : null}
        </div>
        <div className="muted ui-mono">
          {row.in_flight} in flight · {row.done_24h} done (24h)
        </div>
      </div>
    </li>
  );
}

/** `/fleet`: every project the person may see on one screen. */
export function FleetPage() {
  const q = useQuery({
    queryKey: ['fleet'],
    queryFn: api.fleet,
    refetchInterval: FLEET_POLL_MS,
    retry: false,
  });
  const head = (
    <PageHead
      eyebrow="Work"
      title="Fleet"
      sub="Every project on one screen: where work sits, which gates hold it, and what is held, stuck or killed. Open a row for its floor."
      actions={
        <Link to="/floor" className="ui-btn">
          Open floor
        </Link>
      }
    />
  );
  if (q.isPending)
    return (
      <>
        {head}
        <Loading what="the fleet" />
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
  const v = q.data;
  const open = v.projects.filter((p) => p.collapsed === null);
  const sum = (f: (p: FloorProject) => number) => open.reduce((n, p) => n + f(p), 0);
  const inFlight = v.projects.reduce((n, p) => n + p.in_flight, 0);
  const stuck = sum((p) => p.status.stuck);
  const flagged = sum((p) => p.infeasible_gates);
  const coding = v.sessions;
  return (
    <>
      {head}
      {v.freshness.stale || q.isError ? (
        <div className="notice notice-attention" role="status">
          <p>
            <b>Stale:</b>{' '}
            {q.isError
              ? 'the fleet could not be refreshed: what you see may have moved.'
              : `the floor read model is behind the record (${v.freshness.reason ?? 'unknown cause'}).`}
          </p>
        </div>
      ) : null}
      <Stats label="The fleet">
        <Stat label="Items in flight" value={inFlight} detail={`${v.projects.length} projects`} />
        <Stat
          label="Waiting on a person"
          value={sum((p) => p.status.waiting)}
          detail="at gates and steps"
          tone="warn"
        />
        <Stat
          label="Coding pods busy"
          value={coding ? `${coding.used.W ?? 0} / ${coding.caps.coding}` : 'unknown'}
          detail={
            coding
              ? `sandbox caps (${coding.caps_source})`
              : 'the sandbox-controller did not answer'
          }
        />
        <Stat
          label="Stuck"
          value={stuck}
          detail={`silent > ${v.liveness.silence_minutes} min in a session`}
          {...(stuck > 0 ? { tone: 'bad' as const } : {})}
        />
        <Stat
          label="Gates nobody can decide"
          value={flagged}
          detail="no eligible decider or quorum"
          {...(flagged > 0 ? { tone: 'bad' as const } : {})}
        />
      </Stats>
      {v.projects.length === 0 ? (
        <EmptyState title="No project to show">
          You hold no role on a project yet. A role on a project (a viewer is enough) puts it here.
        </EmptyState>
      ) : (
        <>
          <p className="fx-legend muted">
            Stations S1–S9 with counts; the small cells between them are gates with items waiting;
            the coloured ticks are the lanes in flight.
          </p>
          <ul className="fx-list" aria-label="Projects">
            {v.projects.map((r) => (
              <Row key={r.opaque_key} row={r} view={v} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
