// Business-day arithmetic for the B21 SLA (FL: "any gate > 1 bd SLA"). Pure functions of a calendar
// and an instant; no clock, so the tests drive time with a manual clock.

const DAY_MS = 86_400_000;

export interface BusinessCalendar {
  /** Days of the week that are not business days, 0 = Sunday .. 6 = Saturday. Default Saturday and Sunday. */
  readonly weekend: readonly number[];
  /** Holidays as `YYYY-MM-DD` dates in the calendar's own offset. */
  readonly holidays: readonly string[];
  /** Offset of the calendar's local day from UTC in minutes (Europe/Berlin winter is 60). Default 0. */
  readonly utcOffsetMinutes: number;
}

export const DEFAULT_CALENDAR: BusinessCalendar = {
  weekend: [0, 6],
  holidays: [],
  utcOffsetMinutes: 0,
};

/** A calendar from partial settings; refuses one with no business day at all. */
export function businessCalendar(c: Partial<BusinessCalendar> = {}): BusinessCalendar {
  const cal = { ...DEFAULT_CALENDAR, ...c };
  if (new Set(cal.weekend).size >= 7) throw new RangeError('a calendar needs a business day');
  for (const h of cal.holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) throw new RangeError(`holiday ${h} is not YYYY-MM-DD`);
  }
  return cal;
}

/** Day number (days since 1970-01-01 in the calendar's local time) and the ms into that day. */
function localDay(cal: BusinessCalendar, t: Date): { day: number; tod: number } {
  const local = t.getTime() + cal.utcOffsetMinutes * 60_000;
  const day = Math.floor(local / DAY_MS);
  return { day, tod: local - day * DAY_MS };
}

function dayIsBusiness(cal: BusinessCalendar, day: number): boolean {
  const dow = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  if (cal.weekend.includes(dow)) return false;
  return !cal.holidays.includes(new Date(day * DAY_MS).toISOString().slice(0, 10));
}

export function isBusinessDay(cal: BusinessCalendar, t: Date): boolean {
  return dayIsBusiness(cal, localDay(cal, t).day);
}

/**
 * `t` plus `n` business days (n >= 0), same local time of day. An instant on a non-business day
 * first moves to 00:00 of the next business day (the clock starts when the business day does), so a
 * Saturday opening with n = 1 is due Tuesday 00:00, and a Friday 15:00 opening is due Monday 15:00.
 */
export function addBusinessDays(cal: BusinessCalendar, t: Date, n: number): Date {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a non-negative integer');
  let { day, tod } = localDay(cal, t);
  if (!dayIsBusiness(cal, day)) {
    while (!dayIsBusiness(cal, day)) day += 1;
    tod = 0;
  }
  for (let left = n; left > 0;) {
    day += 1;
    if (dayIsBusiness(cal, day)) left -= 1;
  }
  return new Date(day * DAY_MS + tod - cal.utcOffsetMinutes * 60_000);
}
