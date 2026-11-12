import type { SystemMap, SystemMapArea } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { areaLevelsOf, areaOfPath, lowestAreaLevel, type AreaClaim } from '../src/index.js';

// DEC-25(a): levels and floors per area (OB §3.2: "Light floors (LF), per area"). The per-area floors only lower an
// area below the signed level; unknown is unmet.

const area = (name: string, o: Partial<SystemMapArea> = {}): SystemMapArea => ({
  area: name,
  manifest: name === '.' ? 'package.json' : `${name}/package.json`,
  files: 4,
  source_files: 2,
  test_files: 1,
  languages: ['typescript'],
  depends_on: [],
  used_by: [],
  ...o,
});
const map = (...areas: SystemMapArea[]): SystemMap => ({
  graph_hash: 'a'.repeat(64),
  areas,
  edges: [],
  map_hash: 'b'.repeat(64),
});
const claim = (verdict: AreaClaim['verdict'], ...paths: string[]): AreaClaim => ({
  verdict,
  paths,
});
/** Card 2's facts that meet LF5 and LF6 in every named area: the root text, one affirmed claim per area. */
const card2 = (...areas: string[]) => ({
  instruction_areas: ['.'],
  claims: areas.map((a) => claim('affirm', a === '.' ? 'package.json' : `${a}/package.json`)),
});
const MET = (id: string) => ({ id, state: 'met', reason: null });

describe('areaLevelsOf (DEC-25)', () => {
  it('no system map: one repo-wide area at the signed level', () => {
    expect(areaLevelsOf('light', null)).toEqual([{ area: '.', level: 'light', floors: [] }]);
    expect(areaLevelsOf('census', null)).toEqual([{ area: '.', level: 'census', floors: [] }]);
  });

  it('Full per area: an area without tests is Census, one without a seed is Light, the rest Full', () => {
    const rows = areaLevelsOf('full', {
      system_map: map(
        area('.'),
        area('packages/docs', { test_files: 0 }),
        area('packages/money'),
        area('services/api'),
      ),
      seeded_areas: ['.', 'packages/docs', 'packages/money'],
      graph_truncated: false,
      ...card2('.', 'packages/docs', 'packages/money', 'services/api'),
    });
    expect(rows.map((r) => [r.area, r.level])).toEqual([
      ['.', 'full'],
      ['packages/docs', 'census'],
      ['packages/money', 'full'],
      ['services/api', 'light'],
    ]);
    expect(rows[1]?.floors).toEqual([
      { id: 'LF3', state: 'unmet', reason: 'no test file in the area' },
      MET('LF5'),
      MET('LF6'),
      MET('FF1'),
    ]);
    expect(rows[3]?.floors).toContainEqual({
      id: 'FF1',
      state: 'unmet',
      reason: 'no spec seed for the area',
    });
    expect(lowestAreaLevel(rows)).toBe('census');
  });

  it('unknown is unmet: a truncated graph keeps every area below Full', () => {
    const rows = areaLevelsOf('full', {
      system_map: map(area('.')),
      seeded_areas: ['.'],
      graph_truncated: true,
      ...card2('.'),
    });
    expect(rows).toEqual([
      {
        area: '.',
        level: 'light',
        floors: [
          MET('LF3'),
          MET('LF5'),
          MET('LF6'),
          { id: 'FF1', state: 'unknown', reason: 'the code graph was truncated' },
        ],
      },
    ]);
  });

  it('LF6 per area: the claims about the area, 90% affirmed or unknown; no claim about it is unknown', () => {
    const claims = [
      ...Array.from({ length: 9 }, () => claim('affirm', 'packages/money/src/a.ts')),
      claim('unknown', 'packages/money/src/b.ts'),
      claim('correct', 'services/api/src/x.ts'),
      claim('affirm', 'services/api/src/y.ts'),
      // a claim whose evidence spans two areas counts in each
      claim('affirm', 'package.json', 'services/api/package.json'),
    ];
    const rows = areaLevelsOf('light', {
      system_map: map(area('.'), area('packages/money'), area('services/api'), area('tools')),
      seeded_areas: [],
      graph_truncated: false,
      instruction_areas: ['.'],
      claims,
    });
    expect(rows.map((r) => [r.area, r.level, r.floors.find((f) => f.id === 'LF6')])).toEqual([
      ['.', 'light', MET('LF6')],
      ['packages/money', 'light', MET('LF6')],
      [
        'services/api',
        'census',
        {
          id: 'LF6',
          state: 'unmet',
          reason: '67% of the claims about the area are affirmed or unknown',
        },
      ],
      [
        'tools',
        'census',
        { id: 'LF6', state: 'unknown', reason: 'no card 2 claim is about the area' },
      ],
    ]);
  });

  it('LF5 per area: the root text covers every area; card 2 facts not given are unknown, so Census', () => {
    const covered = areaLevelsOf('light', {
      system_map: map(area('.'), area('lib')),
      seeded_areas: [],
      graph_truncated: false,
      instruction_areas: ['lib'],
      claims: [claim('affirm', 'package.json'), claim('affirm', 'lib/a.ts')],
    });
    expect(covered.map((r) => [r.area, r.floors.find((f) => f.id === 'LF5')?.state])).toEqual([
      ['.', 'unmet'],
      ['lib', 'met'],
    ]);
    const unknown = areaLevelsOf('light', {
      system_map: map(area('.')),
      seeded_areas: [],
      graph_truncated: false,
    });
    expect(unknown[0]).toMatchObject({
      level: 'census',
      floors: [MET('LF3'), { id: 'LF5', state: 'unknown' }, { id: 'LF6', state: 'unknown' }],
    });
  });

  it('never raises an area above the signed level', () => {
    const rows = areaLevelsOf('light', {
      system_map: map(area('.'), area('lib')),
      seeded_areas: ['.', 'lib'],
      graph_truncated: false,
      ...card2('.', 'lib'),
    });
    expect(rows.map((r) => r.level)).toEqual(['light', 'light']);
    expect(rows[0]?.floors.map((f) => f.id)).toEqual(['LF3', 'LF5', 'LF6']);
    const census = areaLevelsOf('census', {
      system_map: map(area('.')),
      seeded_areas: [],
      graph_truncated: false,
    });
    expect(census).toEqual([{ area: '.', level: 'census', floors: [] }]);
  });

  it('areaOfPath: the longest area prefix, else the root', () => {
    const names = ['.', 'packages', 'packages/money'];
    expect(areaOfPath('packages/money/src/a.ts', names)).toBe('packages/money');
    expect(areaOfPath('packages/other/x', names)).toBe('packages');
    expect(areaOfPath('packages-x/y', names)).toBe('.');
  });
});
