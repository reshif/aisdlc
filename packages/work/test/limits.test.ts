import { CATALOGUE } from '@aisdlc/catalogue';
import { describe, expect, it } from 'vitest';
import {
  alternativeLimit,
  effectiveLimit,
  extensionRules,
  handBackLimit,
  isCountUnit,
  itemAgeLimitBd,
  limitValue,
  modeESuspension,
  parkBusinessDays,
  reworkTotalLimit,
} from '../src/index.js';

describe('the engine reads every limit from the catalogue (never a number of its own)', () => {
  it('has the flow numbers the scenarios rely on, from the pinned catalogue', () => {
    expect(parkBusinessDays(CATALOGUE)).toBe(5);
    expect(reworkTotalLimit(CATALOGUE)).toBe(5);
    expect(itemAgeLimitBd(CATALOGUE)).toBe(10);
    expect(extensionRules(CATALOGUE)).toEqual({ max_extensions: 1, max_percent: 50 });
    expect(handBackLimit(CATALOGUE)).toBe(1);
    expect(alternativeLimit(CATALOGUE)).toBe(1);
  });

  it("a limit with no number of its own takes its trigger's (ET3: 3 rounds), and ET4-ET6 have none", () => {
    expect(limitValue(CATALOGUE, 'B9', 'et3_rounds')).toBe(3);
    expect(limitValue(CATALOGUE, 'B9', 'et4_limit')).toBeNull();
    expect(limitValue(CATALOGUE, 'B9', 'nope')).toBeNull();
    const l = CATALOGUE.back_edge_limits.B7;
    expect(l.kind).toBe('limited');
  });

  it('counts are loops; a multiple or a percent is a measure the stage reports', () => {
    expect(isCountUnit('rounds')).toBe(true);
    expect(isCountUnit('times')).toBe(true);
    expect(isCountUnit('multiple')).toBe(false);
    expect(isCountUnit('percent')).toBe(false);
    const et2 = CATALOGUE.triggers.ET2.thresholds.find((t) => t.unit === 'multiple');
    expect(et2 && effectiveLimit(CATALOGUE, et2)).toBe(2);
  });

  it('B19: a gate-miss rate over the minimum sample suspends mode E, and under it never', () => {
    const rate = limitValue(CATALOGUE, 'B19', 'miss_rate') as number;
    const min = limitValue(CATALOGUE, 'B19', 'min_sample') as number;
    expect(
      modeESuspension(CATALOGUE, { sampled: min, missed: Math.floor((min * rate) / 100) + 1 }),
    ).toBe(true);
    expect(
      modeESuspension(CATALOGUE, { sampled: min, missed: Math.floor((min * rate) / 100) }),
    ).toBe(false);
    // a tiny sample with every one a miss is still not a suspension
    expect(modeESuspension(CATALOGUE, { sampled: min - 1, missed: min - 1 })).toBe(false);
    expect(modeESuspension(CATALOGUE, { sampled: 0, missed: 0 })).toBe(false);
  });
});
