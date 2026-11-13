import type { ItemClarifyState } from '@aisdlc/contracts';
import { pinnedCatalogueResolver } from './fold.js';
import { limitValue, parkBusinessDays } from './limits.js';
import type { ItemState } from './state.js';

/** Business-day arithmetic on the caller's calendar (`addBusinessDays` of `@aisdlc/decisions` over the S0 calendar). */
export type AddBusinessDays = (from: Date, businessDays: number) => Date;

/**
 * P2-16: where S1's clarifying questions stand (B1), as ONE pure function of the item's state, so the item page
 * (`ItemView.clarify`) and the notifier's "questions raised" say the same round and the same date. While S1 waits for
 * answers (Clarifying: the requester's silence parks it at the deadline) or is parked on them (Parked by B1 or by
 * silence: it is abandoned at the deadline). The deadline is the one the work driver's timers compute: the start plus
 * the pinned catalogue's B1 business days on the calendar, plus MM-2's frozen time. `null` otherwise.
 */
export function clarifyState(s: ItemState, addDays: AddBusinessDays): ItemClarifyState | null {
  const w = s.waiting;
  const timer =
    w?.kind === 'questions' && s.clarify !== null
      ? { ...s.clarify, then: 'parks' as const }
      : w?.kind === 'parked' && s.park !== null && s.rounds > 0
        ? { ...s.park, then: 'abandons' as const }
        : null;
  if (timer === null) return null;
  const ids: readonly string[] = w?.kind === 'questions' || w?.kind === 'parked' ? w.ids : [];
  const cat = pinnedCatalogueResolver(s.catalogue_ref);
  const bd = cat === null ? null : parkBusinessDays(cat);
  const frozen = s.clock.frozen_ms - timer.frozen_base;
  const deadline =
    bd === null
      ? null
      : new Date(addDays(new Date(timer.since), bd).getTime() + frozen).toISOString();
  const max = cat === null ? null : limitValue(cat, 'B1', 'rounds');
  return {
    round: Math.max(1, s.rounds),
    rounds_max: max === null || max < 1 ? null : max,
    open: s.questions.filter((q) => ids.includes(q.question_id) && q.state === 'open').length,
    since: timer.since,
    deadline,
    then: timer.then,
  };
}
