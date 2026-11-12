import type { Lane, Level, PrrArea, PrrVersionView } from '@aisdlc/contracts';
import { Pill, Table, type Column, type PillTone } from '../ui';
import { levelTitle } from '../vocab';

// Per-area levels (DEC-25(a)): the table of the readiness record M4 signed. A level is not a setting: it changes only
// with a new onboarding version signed at M4 (a level-up after Light, never straight to Full), never by M1. A record
// before M17 has one repo-wide area, `.`, at the signed level.

const LEVEL_TONE: Readonly<Record<Level, PillTone>> = { census: 'mute', light: 'info', full: 'ok' };
const FLOOR_TONE = { met: 'ok', unmet: 'bad', unknown: 'warn' } as const;

type Record_ = PrrVersionView['record'];

/** The per-area rows of a record, or its one repo-wide area for a record made before the table existed. */
export function areaRowsOf(r: Record_): PrrArea[] {
  if (r.level.areas && r.level.areas.length > 0) return r.level.areas;
  const by = r.level.by_area ?? { '.': r.level.signed };
  return Object.entries(by).map(([area, level]) => ({
    area,
    level,
    floors: [],
    lanes: r.autonomy.lanes_eligible as Lane[],
  }));
}

const columns: ReadonlyArray<Column<PrrArea>> = [
  {
    key: 'area',
    header: 'Area',
    rowHeader: true,
    render: (a) => <code>{a.area === '.' ? '. (the whole repository)' : a.area}</code>,
  },
  {
    key: 'level',
    header: 'Level',
    render: (a) => <Pill tone={LEVEL_TONE[a.level]}>{levelTitle(a.level)}</Pill>,
  },
  {
    key: 'floors',
    header: 'Floors in the area',
    render: (a) =>
      a.floors.length === 0 ? (
        <span className="muted">judged for the whole repository</span>
      ) : (
        <ul className="plain">
          {a.floors.map((f) => (
            <li key={f.id}>
              <Pill tone={FLOOR_TONE[f.state]}>
                {f.id} {f.state}
              </Pill>
              {f.reason ? <span className="muted"> {f.reason}</span> : null}
            </li>
          ))}
        </ul>
      ),
  },
  {
    key: 'lanes',
    header: 'Lanes open',
    render: (a) => (a.lanes.length === 0 ? 'none' : a.lanes.join(', ')),
  },
];

export function AreaLevels({ record, repo }: { record: Record_; repo: string }) {
  const rows = areaRowsOf(record);
  return (
    <Table
      caption={`Per-area levels of ${repo}`}
      columns={columns}
      rows={rows}
      rowKey={(a) => a.area}
      empty="No area is recorded."
    />
  );
}
