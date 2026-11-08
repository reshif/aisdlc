import { describe, expect, it } from 'vitest';
import { addBusinessDays, businessCalendar, isBusinessDay } from '../src/index.js';

const at = (s: string) => new Date(s);
// 2026-11-06 is a Friday, 2026-11-09 the Monday after.
describe('business calendar', () => {
  const cal = businessCalendar();
  it('weekends are off', () => {
    expect(isBusinessDay(cal, at('2026-11-06T12:00:00Z'))).toBe(true);
    expect(isBusinessDay(cal, at('2026-11-07T12:00:00Z'))).toBe(false);
    expect(isBusinessDay(cal, at('2026-11-08T12:00:00Z'))).toBe(false);
    expect(isBusinessDay(cal, at('2026-11-09T12:00:00Z'))).toBe(true);
  });

  it('adds business days keeping the time of day, across a weekend', () => {
    expect(addBusinessDays(cal, at('2026-11-06T15:00:00Z'), 1).toISOString()).toBe(
      '2026-11-09T15:00:00.000Z',
    );
    expect(addBusinessDays(cal, at('2026-11-04T15:00:00Z'), 1).toISOString()).toBe(
      '2026-11-05T15:00:00.000Z',
    );
    expect(addBusinessDays(cal, at('2026-11-04T15:00:00Z'), 3).toISOString()).toBe(
      '2026-11-09T15:00:00.000Z',
    );
    expect(addBusinessDays(cal, at('2026-11-06T15:00:00Z'), 0).toISOString()).toBe(
      '2026-11-06T15:00:00.000Z',
    );
  });

  it('a weekend opening starts the clock at the next business day', () => {
    expect(addBusinessDays(cal, at('2026-11-07T10:00:00Z'), 1).toISOString()).toBe(
      '2026-11-10T00:00:00.000Z',
    );
  });

  it('holidays are configurable', () => {
    const h = businessCalendar({ holidays: ['2026-11-09'] });
    expect(isBusinessDay(h, at('2026-11-09T12:00:00Z'))).toBe(false);
    expect(addBusinessDays(h, at('2026-11-06T15:00:00Z'), 1).toISOString()).toBe(
      '2026-11-10T15:00:00.000Z',
    );
  });

  it('weekend days and the UTC offset are configurable', () => {
    const fs = businessCalendar({ weekend: [5, 6] }); // Friday and Saturday off
    expect(addBusinessDays(fs, at('2026-11-05T10:00:00Z'), 1).toISOString()).toBe(
      '2026-11-08T10:00:00.000Z',
    );
    // 23:30 UTC on Friday is already Saturday in UTC+1, so the day is off there.
    const berlin = businessCalendar({ utcOffsetMinutes: 60 });
    expect(isBusinessDay(berlin, at('2026-11-06T23:30:00Z'))).toBe(false);
    expect(isBusinessDay(cal, at('2026-11-06T23:30:00Z'))).toBe(true);
  });

  it('refuses a calendar with no business day and a bad holiday', () => {
    expect(() => businessCalendar({ weekend: [0, 1, 2, 3, 4, 5, 6] })).toThrow();
    expect(() => businessCalendar({ holidays: ['11/09/2026'] })).toThrow();
  });
});
