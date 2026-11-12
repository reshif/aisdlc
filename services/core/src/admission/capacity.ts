import type { AdmissionHold } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import { CapacityError, type CapacityPort } from '@aisdlc/ports';
import type pg from 'pg';
import { approverSlot, controllerCodingFree, sessionCapOf, type AdmissionDeps } from './admit.js';
import { activeGrantCount } from './read.js';

/**
 * The real `CapacityPort` (PLAN M13.1): how many items HELD at admission may go on now, from the same truth
 * admission itself checks, so the release loop frees an item only when its next admission can succeed:
 *   H1  the approver slot exists in the project's role map (all or none);
 *   H2  free coding sessions: the cap minus the sessions that hold a slot (and no more than the sandbox-controller's
 *       free coding slots, when it is wired: M14.2), minus what this port has already
 *       handed out and the admission has not yet used (a pledge: the loop asks for one item at a time, and the
 *       second must not see the slot the first was just given);
 *   H3  the environment: the envelope service answers (asked with a probe group that is never used);
 *   WIP the lease: nothing here knows it better than admission does, so it frees one item at a time.
 * An error frees nothing. `attempted` (called by admission after every attempt) spends one pledge.
 */
export class AdmissionCapacity implements CapacityPort {
  /** Pledges by reason then project: a pledge of one reason never counts against another. */
  private readonly pledged = new Map<string, number>();

  constructor(
    private readonly d: Pick<
      AdmissionDeps,
      'pool' | 'settings' | 'envelope' | 'sessionCap' | 'runnerHost' | 'slots'
    >,
  ) {}

  /** The admission's callback: one pledge of the project is used up, whatever the attempt said. */
  attempted = (project_id: string): void => {
    for (const k of [...this.pledged.keys()]) {
      if (!k.endsWith(`|${project_id}`)) continue;
      const n = this.pledged.get(k) ?? 0;
      if (n > 0) this.pledged.set(k, n - 1);
    }
  };

  private pledges(reason: AdmissionHold): number {
    let t = 0;
    for (const [k, n] of this.pledged) if (k.startsWith(`${reason}|`)) t += n;
    return t;
  }

  async take(
    reason: AdmissionHold,
    scope: { readonly project_id: string; readonly repo: string },
    wanted: number,
  ) {
    try {
      let free = 0;
      if (reason === 'H1') {
        free = (await approverSlot(this.d, scope.project_id)).ok ? wanted : 0;
      } else if (reason === 'H2') {
        // the lower of the grant count and (M14.2) the sandbox-controller's free coding slots, less the pledges
        const cap = await sessionCapOf(this.d);
        const byGrants = cap - (await activeGrantCount(this.d.pool as pg.Pool));
        const byController = await controllerCodingFree(this.d);
        free = Math.max(0, Math.min(byGrants, byController) - this.pledges('H2'));
      } else if (reason === 'H3') {
        const probe = await this.d.envelope.reserve({
          group_id: 'probe:envelope',
          max_tokens: 1,
          max_cost_micro_usd: 1,
        });
        free = probe.ok ? wanted : 0;
      } else {
        free = wanted > 0 && this.pledges('WIP') === 0 ? 1 : 0;
      }
      const granted = Math.max(0, Math.min(free, wanted));
      if (granted > 0) {
        const k = `${reason}|${scope.project_id}`;
        this.pledged.set(k, (this.pledged.get(k) ?? 0) + granted);
      }
      return ok(granted);
    } catch (e) {
      return err(
        CapacityError({ message: e instanceof Error ? e.message : 'capacity unavailable' }),
      );
    }
  }
}
