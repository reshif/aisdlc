export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** A clock that always reads the same instant. */
export function fixedClock(at: Date | number | string): Clock {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) throw new RangeError('fixedClock: invalid date');
  return { now: () => new Date(ms), nowMs: () => ms };
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(at: Date | number | string): void;
}

/** A clock for tests that only moves when told to. */
export function manualClock(start: Date | number | string = 0): ManualClock {
  let ms = new Date(start).getTime();
  if (Number.isNaN(ms)) throw new RangeError('manualClock: invalid date');
  return {
    now: () => new Date(ms),
    nowMs: () => ms,
    advance(delta) {
      ms += delta;
    },
    set(at) {
      const next = new Date(at).getTime();
      if (Number.isNaN(next)) throw new RangeError('manualClock.set: invalid date');
      ms = next;
    },
  };
}
