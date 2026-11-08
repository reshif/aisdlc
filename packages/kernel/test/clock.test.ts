import { describe, expect, it } from 'vitest';
import { fixedClock, manualClock, systemClock } from '../src/index.js';

describe('clocks', () => {
  it('system clock tracks real time', () => {
    expect(Math.abs(systemClock.nowMs() - Date.now())).toBeLessThan(1000);
  });
  it('fixed clock never moves', () => {
    const c = fixedClock('2026-01-01T00:00:00Z');
    expect(c.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(c.nowMs()).toBe(c.nowMs());
    expect(() => fixedClock('garbage')).toThrow();
  });
  it('manual clock advances on demand', () => {
    const c = manualClock(1000);
    c.advance(500);
    expect(c.nowMs()).toBe(1500);
    c.set(10);
    expect(c.now().getTime()).toBe(10);
  });
});
