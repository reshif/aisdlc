import { PDP_EVENT, pdpDecisionStream, type PdpDecisionRecord } from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { appendEvents } from '@aisdlc/record';
import type pg from 'pg';

// The PdpDecision log (PLAN M4.3, DM `PdpDecision`): decisions as `pdp.decision` record events,
// one stream per decision so concurrent decisions never contend on a stream head. The PDP decides
// what is logged (every deny, every allow of an action with `log_allow`, a sample of the rest);
// this only writes.

export interface DecisionLog {
  record(r: PdpDecisionRecord): Promise<Result<void, string>>;
}

/** Writes decisions to the record database. */
export class RecordDecisionLog implements DecisionLog {
  constructor(private readonly o: { readonly pool: pg.Pool; readonly clock?: Clock }) {}

  async record(r: PdpDecisionRecord): Promise<Result<void, string>> {
    try {
      const outcome = await withTransaction(this.o.pool, (tx) =>
        appendEvents(
          tx,
          pdpDecisionStream(r.decision_id),
          0,
          [
            {
              type: PDP_EVENT.decision,
              actor: r.principal,
              idempotency_key: `${PDP_EVENT.decision}:${r.decision_id}`,
              body: r as unknown as Record<string, unknown>,
            },
          ],
          { clock: this.o.clock ?? systemClock },
        ),
      );
      return outcome.ok ? ok(undefined) : err(JSON.stringify(outcome.error));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}

/** Keeps decisions in memory. For tests and for callers that only want the decision. */
export class MemoryDecisionLog implements DecisionLog {
  readonly records: PdpDecisionRecord[] = [];
  failing = false;
  async record(r: PdpDecisionRecord): Promise<Result<void, string>> {
    if (this.failing) return err('log unavailable');
    this.records.push(r);
    return ok(undefined);
  }
}
