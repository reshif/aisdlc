import {
  HumanWorkReference,
  ITEM_EVENT,
  ItemHandoffView,
  PrincipalId,
  type ItemHandoffView as View,
} from '@aisdlc/contracts';
import { readGateState } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  extensionRules,
  handBackLimit,
  openHandoffChoices,
  pinnedCatalogueResolver,
} from '@aisdlc/work';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { cardsOfGates } from './verify/portal.js';
import { readItem, readItemEvents } from './work-items.js';
import { itemView } from './work-view.js';

// An item's handoff as the portal shows it (P1-4, FL "HANDOFFS"): the handoff the owner of record decides (D1 from
// S6, D2 from S7, D3 from G4, or E4 directly), its E4 gate and the card that carries it, the choices the flow allows
// now (the work engine's own rule over the item's pinned catalogue), and, while a developer has the work (L8), the
// hand-backs left (D4) and the D5 signals so far. Read from the item's stream and the ledger alone; nothing here
// decides anything.

export async function itemHandoffView(
  pool: pg.Pool,
  itemId: string,
): Promise<Result<View, CoreError>> {
  const item = await readItem(pool, itemId);
  if (!item) return err(coreError('not_found', 'no such item'));
  const s = item.state;
  const handoff = s.handoffs.find((h) => h.status === 'open') ?? s.handoffs.at(-1) ?? null;

  let e4: View['e4'] = null;
  if (handoff?.e4_gate_instance_id) {
    const id = handoff.e4_gate_instance_id;
    const g = [...s.gates].reverse().find((x) => x.gate_instance_id === id);
    // approvers are read from the ledger, never from the item's own copy
    const gs = await readGateState(pool, id);
    const cards = await cardsOfGates(pool, itemId);
    e4 = {
      gate_instance_id: id,
      card_id: cards.get(id) ?? null,
      status: g?.status ?? 'pending',
      outcome: g?.outcome ?? null,
      approvers:
        gs && gs.status === 'decided' && gs.outcome === 'approve'
          ? gs.approvers.flatMap((a) => {
              const p = PrincipalId.safeParse(a);
              return p.success ? [p.data] : [];
            })
          : [],
    };
  }

  const cat = pinnedCatalogueResolver(s.catalogue_ref);
  // an unreadable pinned catalogue offers no choice (fail closed: the interpreter would refuse it too)
  const choices = cat === null ? [] : openHandoffChoices(s, cat);

  const humanLed = s.waiting?.kind === 'human' && s.waiting.what === 'human_led';
  const limit = cat === null ? null : handBackLimit(cat);
  const human_led: View['human_led'] = humanLed
    ? {
        taken_over: s.takeover !== null,
        lane_before: s.takeover?.lane_before ?? null,
        hand_backs_left:
          s.takeover === null || limit === null ? 0 : Math.max(0, limit - s.takeover.hand_backs),
      }
    : null;

  const done: View['done'] = [];
  for (const e of await readItemEvents(pool, itemId)) {
    if (e.type !== ITEM_EVENT.human_work_done) continue;
    const p = e.payload as { by?: unknown; outputs?: unknown; reference?: unknown };
    // B5's hand-written plan uses the same signal; it is not D5
    if (p.outputs !== undefined) continue;
    const by = PrincipalId.safeParse(p.by);
    if (!by.success) continue;
    const ref = HumanWorkReference.safeParse(p.reference);
    done.push({ by: by.data, at: e.occurred_at, reference: ref.success ? ref.data : null });
  }
  done.reverse();

  return ok(
    ItemHandoffView.parse({
      item_id: s.item_id,
      project_id: s.project_id,
      lane: s.lane,
      phase: s.phase,
      waiting: itemView(s).waiting,
      handoff,
      e4,
      choices,
      extension_max_percent: cat === null ? null : extensionRules(cat).max_percent,
      human_led,
      done,
    }),
  );
}
