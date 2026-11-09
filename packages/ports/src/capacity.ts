import type { AdmissionHold } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// The capacity port (PLAN M9.3): what the release loop asks to free a HELD item. 6.0 admission (the
// coding port) answers "held, H1/H2/H3/WIP" when the approver pool, the capacity, the environment or
// the WIP limit say no; this port says how many held items of a reason may go on now (M13.1 makes the
// real one: leases, slots, envelopes). Unknown means none: an error frees nothing.

export const CapacityError = taggedError('CapacityError');
export type CapacityError = TaggedError<'CapacityError', { message: string }>;

export interface CapacityPort {
  /**
   * Asks to release up to `wanted` items held for `reason` (project and repo in `scope`) and answers
   * how many may go now. What is granted is spent: asking again does not grant it twice.
   */
  take(
    reason: AdmissionHold,
    scope: { readonly project_id: string; readonly repo: string },
    wanted: number,
  ): Promise<Result<number, CapacityError>>;
}

/** Deterministic `CapacityPort`: nothing is free until a test says so; `down` makes every call an error. */
export class FakeCapacity implements CapacityPort {
  private readonly slots = new Map<AdmissionHold, number>();
  private down = false;
  readonly calls: AdmissionHold[] = [];

  /** `n` more items held for `reason` may be released. */
  grant(reason: AdmissionHold, n: number): this {
    this.slots.set(reason, (this.slots.get(reason) ?? 0) + n);
    return this;
  }

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async take(reason: AdmissionHold, _scope: unknown, wanted: number) {
    this.calls.push(reason);
    if (this.down) return err(CapacityError({ message: 'capacity unavailable' }));
    const have = this.slots.get(reason) ?? 0;
    const granted = Math.max(0, Math.min(have, wanted));
    this.slots.set(reason, have - granted);
    return ok(granted);
  }
}
