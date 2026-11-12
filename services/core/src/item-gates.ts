import { ITEM_EVENT, itemStream } from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// Where a work item's gates are decided, and the ledger entry each decision has (P1-2): read from the record, never
// from a projection. The card a gate was opened on is the `card.opened` event whose targets name the gate instance;
// the ledger entry of a decision is the one the item's `item.gate_decided` carries.

/** The decision card of each gate instance named (an instance the record puts on no card is absent). */
export async function cardsOfGates(
  db: Executor,
  gateInstanceIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (gateInstanceIds.length === 0) return out;
  const q = await db.query<{ stream: string; gate: string }>(
    `SELECT e.stream, t ->> 'gate_instance_id' AS gate
       FROM record.record_event e, jsonb_array_elements(e.body -> 'targets') t
      WHERE e.type = 'card.opened' AND t ->> 'gate_instance_id' = ANY($1::text[])
      ORDER BY e.global_seq`,
    [[...gateInstanceIds]],
  );
  for (const r of q.rows) {
    // the first card that opened the gate is its card (a gate is opened on one card)
    if (!out.has(r.gate)) out.set(r.gate, r.stream.slice(r.stream.indexOf(':') + 1));
  }
  return out;
}

export interface ItemGateLink {
  readonly card_id: string | null;
  readonly ledger_entry_id: string | null;
}

/** The card and the ledger entry of every gate of an item, by gate instance. */
export async function itemGateLinks(
  db: Executor,
  itemId: string,
  gateInstanceIds: readonly string[],
): Promise<Map<string, ItemGateLink>> {
  const cards = await cardsOfGates(db, gateInstanceIds);
  const decided = await db.query<{ gate: string; ledger: string | null }>(
    `SELECT body ->> 'gate_instance_id' AS gate, body ->> 'ledger_entry_id' AS ledger
       FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [itemStream(itemId), ITEM_EVENT.gate_decided],
  );
  const ledger = new Map(decided.rows.map((r) => [r.gate, r.ledger]));
  return new Map(
    gateInstanceIds.map((g) => [
      g,
      { card_id: cards.get(g) ?? null, ledger_entry_id: ledger.get(g) ?? null },
    ]),
  );
}
