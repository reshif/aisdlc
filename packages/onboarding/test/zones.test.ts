import { describe, expect, it } from 'vitest';
import { inR3Zone, r3ZonesOf } from '../src/index.js';

// R3 zones (OB §2.4, §8): an area with an unresolved knowledge-defect proposal; read-only, never a level.

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('r3ZonesOf', () => {
  it('places each proposal in the record area that holds it, one zone per area, sorted, with its glob', () => {
    const zones = r3ZonesOf(
      ['.', 'packages/money', 'svc'],
      [
        { area: 'svc', proposal_id: B },
        { area: 'packages/money/src', proposal_id: A },
        { area: 'packages/money', proposal_id: B },
        { area: 'svc', proposal_id: B },
      ],
    );
    expect(zones).toEqual([
      {
        area: 'packages/money',
        glob: 'packages/money/**',
        trigger: 'knowledge_defects',
        proposal_ids: [A, B],
      },
      { area: 'svc', glob: 'svc/**', trigger: 'knowledge_defects', proposal_ids: [B] },
    ]);
  });

  it('the root area is everything; an area the new map does not hold falls to the root (fail closed)', () => {
    expect(r3ZonesOf(['.'], [{ area: '.', proposal_id: A }])).toEqual([
      { area: '.', glob: '**', trigger: 'knowledge_defects', proposal_ids: [A] },
    ]);
    expect(r3ZonesOf(['.', 'lib'], [{ area: 'gone', proposal_id: A }])[0]?.glob).toBe('**');
    expect(r3ZonesOf(['.', 'lib'], [])).toEqual([]);
  });

  it('inR3Zone: the root zone covers every area', () => {
    expect(inR3Zone('lib', new Set(['lib']))).toBe(true);
    expect(inR3Zone('svc', new Set(['lib']))).toBe(false);
    expect(inR3Zone('svc', new Set(['.']))).toBe(true);
  });
});
