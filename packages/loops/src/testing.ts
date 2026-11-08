import { manualClock, type Clock, type ManualClock } from '@aisdlc/kernel';
import type { Sleep } from './supervisor.js';

/**
 * A clock and a `sleep` that only move when `advance` is called, for the supervisor's tests: a day
 * of loop time passes in milliseconds, in order. Timers fire earliest first; after each one the
 * microtask and I/O queues are drained so the tick it started can run to its next sleep.
 */
export class ManualScheduler {
  readonly clock: ManualClock;
  /**
   * Whether work started by a fired timer is still going (`supervisor.busy`). `advance` waits, in
   * real time, until it is not, so ticks that do database I/O finish before time moves on.
   */
  isBusy: (() => boolean) | null = null;
  private timers: Array<{ at: number; resolve: () => void; id: number }> = [];
  private nextId = 1;

  constructor(start: Date | number | string = '2026-11-08T00:00:00.000Z') {
    this.clock = manualClock(start);
  }

  readonly sleep: Sleep = (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const id = this.nextId++;
      const timer = { at: this.clock.nowMs() + ms, resolve, id };
      this.timers.push(timer);
      signal.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((t) => t.id !== id);
          resolve();
        },
        { once: true },
      );
    });

  /** Pending timers (a sleeping loop is one). */
  get pending(): number {
    return this.timers.length;
  }

  /** Lets queued promise callbacks and I/O run. */
  async settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
  }

  async advance(ms: number): Promise<void> {
    const target = this.clock.nowMs() + ms;
    await this.settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.clock.set(Math.max(this.clock.nowMs(), next.at));
      next.resolve();
      await this.quiesce();
    }
    this.clock.set(target);
    await this.quiesce();
  }

  /** Lets promise callbacks run, then waits (real time, at most 10 s) while `isBusy`. */
  async quiesce(): Promise<void> {
    await this.settle();
    const until = Date.now() + 10_000;
    while (this.isBusy?.()) {
      if (Date.now() > until) throw new Error('ManualScheduler: loops stayed busy for 10 s');
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

export type { Clock };
