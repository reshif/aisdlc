import type { ItemView } from '@aisdlc/contracts';
import type { ItemState } from '@aisdlc/work';
import type { ItemGateLink } from './item-gates.js';

/**
 * An item for a reader (the portal, the floor): where it is, what it waits for; never request text. `links` are the
 * card and ledger entry of each gate (`itemGateLinks`); a gate with none is shown with `null`s.
 */
export function itemView(
  s: ItemState,
  links: ReadonlyMap<string, ItemGateLink> = new Map(),
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
  };
}
