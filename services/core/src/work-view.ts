import { GateIdValues, type GateId, type ItemPullRequest, type ItemView } from '@aisdlc/contracts';
import { addBusinessDays, type BusinessCalendar } from '@aisdlc/decisions';
import {
  effectiveProfile,
  limitValue,
  parkBusinessDays,
  pinnedCatalogueResolver,
  presentGates,
  type ItemState,
} from '@aisdlc/work';
import type { ItemGateLink } from './item-gates.js';
import { DEFAULT_WORK_SETTINGS } from './work-control.js';

/** P2-10: the gates the item's pinned profile has on its lane, and the switchable ones it has off. */
function profileGates(s: ItemState): ItemView['profile_gates'] {
  const cat = pinnedCatalogueResolver(s.catalogue_ref);
  const def = cat?.lanes[s.lane ?? s.proposed_lane];
  if (!def) return null;
  const present = presentGates(def, effectiveProfile(s.profile, s.tier));
  const switchable = new Set<GateId>(
    def.gates.filter((p) => p.presence === 'by_profile').map((p) => p.gate),
  );
  return {
    on: GateIdValues.filter((g) => present.has(g)),
    off: GateIdValues.filter((g) => switchable.has(g) && !present.has(g)),
  };
}

/**
 * P2-16: the clarifying round while S1 waits for answers (Clarifying: the requester's silence parks it at the deadline)
 * or is parked on them (Parked by B1 or by silence: it is abandoned at the deadline). The deadline is the one
 * `fireTimers` computes: the start plus the pinned catalogue's B1 business days on the calendar, plus MM-2's frozen time.
 */
export function clarifyState(s: ItemState, calendar: BusinessCalendar): ItemView['clarify'] {
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
      : new Date(
          addBusinessDays(calendar, new Date(timer.since), bd).getTime() + frozen,
        ).toISOString();
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

export interface ItemViewExtra {
  /** The item's pull requests (`core.pull_request`). */
  readonly pull_requests?: readonly ItemPullRequest[];
  /** The calendar the business-day timers count on (the S0 calendar). */
  readonly calendar?: BusinessCalendar;
}

/**
 * An item for a reader (the portal, the floor): where it is, what it waits for; never request text. `links` are the
 * card and ledger entry of each gate (`itemGateLinks`); a gate with none is shown with `null`s.
 */
export function itemView(
  s: ItemState,
  links: ReadonlyMap<string, ItemGateLink> = new Map(),
  extra: ItemViewExtra = {},
): ItemView {
  const w = s.waiting;
  return {
    item_id: s.item_id as never,
    project_id: s.project_id as never,
    repo: s.repo as never,
    request_id: s.request_id as never,
    phase: s.phase,
    lane: s.lane,
    proposed_lane: s.proposed_lane,
    terminal: s.terminal,
    waiting:
      w === null
        ? null
        : w.kind === 'gates'
          ? `gates:${w.gates.join('+')}`
          : w.kind === 'human'
            ? `human:${w.what}`
            : w.kind === 'stuck'
              ? `stuck:${w.reason}`
              : w.kind === 'parked'
                ? `parked:${w.cause}`
                : w.kind === 'blocked'
                  ? `blocked:${w.cause}`
                  : w.kind === 'handoff'
                    ? `handoff:${w.stage}`
                    : w.kind,
    holds: s.holds,
    questions: s.questions.map(({ answer, ...q }) => ({
      ...q,
      answered: answer !== null,
      answer_flagged: (answer?.flags.length ?? 0) > 0,
    })),
    gates: s.gates.map((g) => ({
      gate: g.gate,
      gate_instance_id: g.gate_instance_id,
      status: g.status,
      outcome: g.outcome,
      card_id: (links.get(g.gate_instance_id)?.card_id ??
        null) as ItemView['gates'][number]['card_id'],
      ledger_entry_id: links.get(g.gate_instance_id)?.ledger_entry_id ?? null,
    })),
    outstanding: s.outstanding.length,
    terminal_cause: s.terminal_cause,
    rework_total: s.rework.total,
    handoff: s.handoffs.find((h) => h.status === 'open') ?? null,
    assumptions: s.assumptions,
    catalogue_ref: s.catalogue_ref,
    injection_suspected: s.intake.injection?.suspected ?? false,
    dedupe_links: s.intake.dedupe_links,
    profile_gates: profileGates(s),
    clarify: clarifyState(s, extra.calendar ?? DEFAULT_WORK_SETTINGS.calendar),
    pull_requests: [...(extra.pull_requests ?? [])],
  };
}
