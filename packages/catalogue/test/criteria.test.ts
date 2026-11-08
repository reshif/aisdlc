import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Criterion,
  CriterionPillarValues,
  FloorDef,
  FloorIdValues,
  LevelValues,
  floorLevel,
  type CriterionClass,
  type Level,
} from '@aisdlc/contracts';
import { CATALOGUE, CRITERIA, CRITERIA_LIST, FLOORS } from '../src/index.js';

const spec = readFileSync(
  fileURLToPath(new URL('../../../docs/specs/onboarding-roadmap.md', import.meta.url)),
  'utf8',
);
const section = (from: string, to: string): string => {
  const a = spec.indexOf(from);
  const b = spec.indexOf(to, a);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return spec.slice(a, b);
};

type SpecRow = {
  pillar: string;
  ids: string[];
  cells: [CriterionClass | null, CriterionClass | null, CriterionClass | null];
  escalation: 'team' | 'team_and_public' | null;
  floors: string[];
};

/** `RS-ID-1..4`, `RS-ST-1..3`, `RS-PUB-1/2`, `RS-SEC-*` into single ids. */
function expandIds(cell: string): string[] {
  const id = cell.trim();
  let m = /^(RS-[A-Z]+)-(\d+)\.\.(\d+)$/.exec(id);
  if (m) {
    const [, p, a, b] = m;
    return Array.from({ length: Number(b) - Number(a) + 1 }, (_, i) => `${p}-${Number(a) + i}`);
  }
  m = /^(RS-[A-Z]+)-(\d+)\/(\d+)$/.exec(id);
  if (m) return [`${m[1]}-${m[2]}`, `${m[1]}-${m[3]}`];
  if (id === 'RS-SEC-*') return ['RS-SEC'];
  return [id];
}

function parseCell(cell: string, prev: string | null): string {
  const c = cell.trim();
  return c === 'same' && prev !== null ? prev : c;
}

const CLASS_WORDS: Record<string, CriterionClass> = {
  FLOOR: 'FLOOR',
  SCORED: 'SCORED',
  RECORDED: 'RECORDED',
  ADVISORY: 'ADVISORY',
};

function readCatalogueTable(): SpecRow[] {
  const text = section('### 3.3 Full catalogue by level', '**The task contract**');
  const rows: SpecRow[] = [];
  for (const line of text.split('\n')) {
    const cols = line.split('|').map((s) => s.trim());
    // | Pillar | Id | Criterion | C | L | F |
    if (cols.length !== 8 || !(CriterionPillarValues as readonly string[]).includes(cols[1] ?? ''))
      continue;
    const [, pillar, id, , c, l, f] = cols as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const fCell = parseCell(f, l);
    const word = (cell: string): CriterionClass | null => {
      if (cell.startsWith('—')) return null;
      const w = /^[A-Z]+/.exec(cell)?.[0] ?? '';
      const cls = CLASS_WORDS[w];
      expect(cls, `class in "${cell}"`).toBeDefined();
      return cls ?? null;
    };
    const all = `${l} ${fCell}`;
    rows.push({
      pillar,
      ids: expandIds(id),
      cells: [word(c), word(l), word(fCell)],
      escalation: /team \+ public: FLOOR/.test(all)
        ? 'team_and_public'
        : /team: FLOOR/.test(all)
          ? 'team'
          : null,
      floors: [
        ...(all.match(/→LF\d/g) ?? []).map((s) => s.slice(1)),
        ...(all.match(/\(\+?FF\d\)/g) ?? []).map((s) => s.replace(/[()+]/g, '')),
      ],
    });
  }
  return rows;
}

describe('CRITERIA_V2 against OB 3.3 (the table is read from the spec)', () => {
  const rows = readCatalogueTable();
  const byId = new Map(CRITERIA_LIST.map((c) => [c.id, c]));

  it('reads every row of the table', () => {
    expect(rows.length).toBe(50);
    expect(rows.flatMap((r) => r.ids).length).toBe(CRITERIA_LIST.length);
    expect(CRITERIA_LIST.length).toBe(56);
  });

  it('has exactly the criteria of the table, once each', () => {
    const ids = CRITERIA_LIST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(rows.flatMap((r) => r.ids).sort());
  });

  it('has the class at every level, the pillar, the team escalation and the floor links of each row', () => {
    for (const r of rows) {
      for (const id of r.ids) {
        const c = byId.get(id);
        expect(c, id).toBeDefined();
        expect(c?.pillar, id).toBe(r.pillar);
        expect(
          LevelValues.map((lv) => c?.class_by_level[lv]),
          id,
        ).toEqual(r.cells);
        expect(c?.escalations.map((e) => e.when) ?? [], id).toEqual(
          r.escalation === null ? [] : [r.escalation],
        );
        // "→LFn" and "(+FF2)": the floors that the row names (CFn are in the ID rows' own floor table).
        const named = (c?.floors ?? []).filter((f) => !f.startsWith('CF'));
        expect([...named].sort(), id).toEqual(
          [...r.floors].sort().filter((f, i, a) => a.indexOf(f) === i),
        );
      }
    }
  });

  it('every criterion validates against the Criterion schema', () => {
    for (const c of CRITERIA_LIST) expect(Criterion.safeParse(c).success, c.id).toBe(true);
    expect(CATALOGUE.criteria.set).toBe('CRITERIA_V2');
  });

  it('at Census only the four identity criteria are FLOOR (everything else is RECORDED or less)', () => {
    const floors = CRITERIA_LIST.filter((c) => c.class_by_level.census === 'FLOOR').map(
      (c) => c.id,
    );
    expect(floors).toEqual(['RS-ID-1', 'RS-ID-2', 'RS-ID-3', 'RS-ID-4']);
    for (const c of CRITERIA_LIST) {
      expect(['FLOOR', 'RECORDED', 'ADVISORY', null]).toContain(c.class_by_level.census);
    }
  });
});

describe('safety floors CF1-CF4, LF1-LF8, FF1-FF2 (OB 3.2)', () => {
  const ids = new Set(CRITERIA_LIST.map((c) => c.id));

  it('has every floor once, and no other', () => {
    expect(FLOORS.map((f) => f.id)).toEqual([...FloorIdValues]);
    expect(FLOORS.map((f) => f.id).filter((i) => i.startsWith('CF'))).toHaveLength(4);
    expect(FLOORS.map((f) => f.id).filter((i) => i.startsWith('LF'))).toHaveLength(8);
    expect(FLOORS.map((f) => f.id).filter((i) => i.startsWith('FF'))).toHaveLength(2);
    for (const f of FLOORS) expect(FloorDef.safeParse(f).success, f.id).toBe(true);
    expect(CRITERIA.floors).toEqual([...FLOORS]);
  });

  it('every criterion id in a floor exists in the catalogue', () => {
    for (const f of FLOORS)
      for (const c of f.criteria) expect(ids.has(c), `${f.id} ${c}`).toBe(true);
  });

  it('floor and criterion links agree both ways', () => {
    for (const f of FLOORS) {
      const linked = CRITERIA_LIST.filter((c) => c.floors.includes(f.id)).map((c) => c.id);
      expect([...linked].sort(), f.id).toEqual([...f.criteria].sort());
    }
    for (const c of CRITERIA_LIST) {
      for (const fid of c.floors) {
        expect(FLOORS.find((f) => f.id === fid)?.criteria, `${c.id} ${fid}`).toContain(c.id);
      }
    }
  });

  it('a floor criterion is FLOOR at the floor level and above; every FLOOR criterion belongs to a floor', () => {
    for (const f of FLOORS) {
      const from = LevelValues.indexOf(floorLevel(f.id));
      for (const cid of f.criteria) {
        const c = CRITERIA_LIST.find((x) => x.id === cid);
        for (const lv of LevelValues.slice(from)) {
          expect(c?.class_by_level[lv as Level], `${f.id} ${cid} at ${lv}`).toBe('FLOOR');
        }
      }
    }
    for (const c of CRITERIA_LIST) {
      if (LevelValues.some((lv) => c.class_by_level[lv] === 'FLOOR')) {
        expect(c.floors.length, c.id).toBeGreaterThan(0);
      }
    }
  });

  it('matches the floor table of the spec (ids per floor)', () => {
    const text = section('### 3.2 Safety floors', '### 3.3 Full catalogue');
    const expected: Record<string, string[]> = {
      CF1: ['RS-ID-1'],
      CF2: ['RS-ID-2'],
      CF3: ['RS-ID-3'],
      CF4: ['RS-ID-4'],
      LF1: ['RS-SEC'],
      LF2: ['RS-CC-3', 'RS-CC-4'],
      LF3: ['RS-BT-1', 'RS-BT-2', 'RS-BT-7', 'RS-TH-1', 'RS-EN-2'],
      LF4: ['RS-AI-7'],
      LF5: ['RS-AI-3', 'RS-AI-4'],
      LF6: ['RS-KN-4', 'RS-KN-5'],
      LF7: ['RS-OP-1', 'RS-OP-2'],
      LF8: ['RS-EN-1'],
      FF1: ['RS-KN-7'],
      FF2: ['RS-OP-2'],
    };
    for (const f of FLOORS) {
      expect(text, f.id).toMatch(new RegExp(`\\| ${f.id} \\|`));
      expect([...f.criteria].sort(), f.id).toEqual([...(expected[f.id] ?? [])].sort());
    }
    // Spot-check the ids column of each LF/CF row in the spec text itself.
    for (const [id, crit] of Object.entries(expected)) {
      const line = text.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';
      const cols = line.split('|').map((s) => s.trim());
      const idsCol = id.startsWith('FF') ? cols[3] : cols[3];
      for (const c of crit) {
        const tail = c.replace(/^RS-[A-Z]+-?/, '');
        expect(idsCol ?? '', `${id} ${c}`).toContain(tail === '' ? 'RS-SEC' : tail);
      }
    }
  });
});
