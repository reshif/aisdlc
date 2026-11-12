import { GateIdValues, type GateId, type ItemView } from '@aisdlc/contracts';
import {
  effectiveProfile,
  pinnedCatalogueResolver,
  presentGates,
  type ItemState,
} from '@aisdlc/work';

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

/** An item for a reader (the portal, the floor): where it is, what it waits for; never request text. */
export function itemView(s: ItemState): ItemView {
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
  };
}
