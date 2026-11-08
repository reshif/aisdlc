import type { LoopSpec } from '@aisdlc/loops';
import { activeS0Ids } from '../queries.js';
import { type CardDeps } from './model.js';
import { syncCards } from './sync.js';

export interface CardsLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
  /** Observes what a sync did (tests, metrics). */
  readonly onSync?: (s0Id: string, changed: number) => void;
}

export const CARDS_LOOP_INTERVAL_MS = 10_000;

/**
 * The `onboarding_cards` loop: `syncCards` for every record that is `app`, `running` or `card`
 * (the cards of a record that waits for a person exist only while it is one of these). Hosted by a
 * process that has the decision kernel's ledger side; a sync that cannot do something now says so
 * and the next tick tries again.
 */
export function cardsLoop(d: CardDeps, o: CardsLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? CARDS_LOOP_INTERVAL_MS;
  return {
    name: 'onboarding_cards',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick(ctx) {
      const ids = await activeS0Ids(d.pool);
      return ctx.eachItem(
        ids,
        (id) => `s0 ${id}`,
        async (id) => {
          const r = await syncCards(d, id);
          if (!r.ok) throw new Error(r.error.message);
          o.onSync?.(id, r.value.opened.length + r.value.applied.length + r.value.withdrawn.length);
          // A step that could not be done now is the loop's failure for this record: it is retried.
          if (r.value.pending.length > 0) throw new Error(r.value.pending.join('; '));
        },
      );
    },
  };
}
