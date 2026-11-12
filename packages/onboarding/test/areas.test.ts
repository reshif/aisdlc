import type { SystemMap, SystemMapArea } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { areaLevelsOf, lowestAreaLevel } from '../src/index.js';

// DEC-25(a): levels and floors per area. The per-area floors only lower an area below the signed level.

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
    });
    expect(rows.map((r) => [r.area, r.level])).toEqual([
      ['.', 'full'],
      ['packages/docs', 'census'],
      ['packages/money', 'full'],
      ['services/api', 'light'],
    ]);
    expect(rows[1]?.floors).toEqual([
      { id: 'LF3', state: 'unmet', reason: 'no test file in the area' },
      { id: 'FF1', state: 'met', reason: null },
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
    });
    expect(rows).toEqual([
      {
        area: '.',
        level: 'light',
        floors: [
          { id: 'LF3', state: 'met', reason: null },
          { id: 'FF1', state: 'unknown', reason: 'the code graph was truncated' },
        ],
      },
    ]);
  });

  it('never raises an area above the signed level', () => {
    const rows = areaLevelsOf('light', {
      system_map: map(area('.'), area('lib')),
      seeded_areas: ['.', 'lib'],
      graph_truncated: false,
    });
    expect(rows.map((r) => r.level)).toEqual(['light', 'light']);
    expect(rows[0]?.floors.map((f) => f.id)).toEqual(['LF3']);
    const census = areaLevelsOf('census', {
      system_map: map(area('.')),
      seeded_areas: [],
      graph_truncated: false,
    });
    expect(census).toEqual([{ area: '.', level: 'census', floors: [] }]);
  });
});
