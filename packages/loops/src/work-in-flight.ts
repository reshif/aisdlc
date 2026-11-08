import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// WorkInFlightPort (PLAN M5.4): does a repo have agent work in flight? The effective rules are
// polled hourly while it does and nightly while it does not (OB §6.5 "Polling"). The real source
// is the work engine (M9); until then only the fake exists. An error is never "no work": the
// caller polls at the faster rate (more checking is the safe side).

export const WorkInFlightError = taggedError('WorkInFlightError');
export type WorkInFlightError = TaggedError<'WorkInFlightError', { message: string }>;

export interface WorkInFlightPort {
  hasWorkInFlight(repo: string): Promise<Result<boolean, WorkInFlightError>>;
}

/** Deterministic `WorkInFlightPort`. */
export class FakeWorkInFlight implements WorkInFlightPort {
  private readonly inFlight = new Set<string>();
  private down = false;

  set(repo: string, value: boolean): this {
    if (value) this.inFlight.add(repo.toLowerCase());
    else this.inFlight.delete(repo.toLowerCase());
    return this;
  }

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async hasWorkInFlight(repo: string): Promise<Result<boolean, WorkInFlightError>> {
    if (this.down) return err(WorkInFlightError({ message: 'work engine unavailable' }));
    return ok(this.inFlight.has(repo.toLowerCase()));
  }
}
