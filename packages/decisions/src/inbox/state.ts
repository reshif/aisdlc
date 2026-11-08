import {
  CARD_EVENT,
  CARD_STEP_ENTRY_TYPE,
  CardDecidedPayload,
  CardEscalatedPayload,
  CardOpenedPayload,
  CardPayloadRecordedPayload,
  CardWithdrawnPayload,
  cardStream,
  type CardStatus,
  type GateStatus,
  type StepId,
  type VoteDecision,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';
import { readGateState, type GateState } from '../state.js';

// The authoritative state of a card: its record stream, the gate states folded from the ledger
// (`readGateState`) and the step decisions on the ledger. The write paths (decide, SLA sweep) read
// this under the gate locks; the inbox read model (`projection.ts`) is for lists only.

/** What a card's status is, from its gates (and the decisions of its steps). Pure. */
export function deriveCardStatus(
  gates: ReadonlyArray<{ status: GateStatus; outcome: VoteDecision | null }>,
  stepDecisions: ReadonlyArray<VoteDecision | null> = [],
  withdrawn = false,
): CardStatus {
  // A card with an undecided gate stays open, whatever else happened: nothing here approves it.
  if (gates.some((g) => g.status === 'pending')) return 'open';
  // A card with no gate is open until its steps are decided, or withdrawn when its record moved on.
  if (gates.length === 0 && stepDecisions.some((d) => d === null)) {
    return withdrawn ? 'withdrawn' : 'open';
  }
  const outcomes = [...gates.map((g) => g.outcome), ...stepDecisions];
  if (outcomes.includes('reject')) return 'rejected';
  if (outcomes.includes('request_changes')) return 'sent_back';
  if (gates.every((g) => g.status === 'decided' && g.outcome === 'approve')) return 'decided';
  if (gates.some((g) => g.status === 'superseded')) return 'superseded';
  if (gates.some((g) => g.status === 'expired')) return 'expired';
  return 'withdrawn';
}

export interface CardStepState {
  readonly step: StepId;
  readonly slot: string;
  readonly decision: VoteDecision | null;
  readonly ledger_entry_id: string | null;
  /** Who decided it and whether the decision rests on a `sod_waiver`; `null` while undecided. */
  readonly actor: string | null;
  readonly sod_waiver: boolean | null;
}

export interface CardState {
  readonly card_id: string;
  readonly open: CardOpenedPayload;
  readonly opened_at: string;
  /** One per gate target, in card order. */
  readonly gates: ReadonlyArray<{ gate_instance_id: string; state: GateState }>;
  readonly steps: readonly CardStepState[];
  readonly escalations: readonly CardEscalatedPayload[];
  readonly payload: CardPayloadRecordedPayload | null;
  readonly decided: readonly CardDecidedPayload[];
  /** A card without a gate that was closed without a decision. */
  readonly withdrawn: CardWithdrawnPayload | null;
  readonly status: CardStatus;
}

export const gateIdsOf = (open: CardOpenedPayload): string[] =>
  open.targets.flatMap((t) => (t.target === 'gate' ? [t.gate_instance_id] : []));

/** The `card.opened` event of a card (immutable), or null. */
export async function readCardOpened(
  db: Executor,
  cardId: string,
): Promise<{ open: CardOpenedPayload; opened_at: string } | null> {
  const q = await db.query<{ body: unknown; occurred_at: Date; type: string }>(
    'SELECT body, occurred_at, type FROM record.record_event WHERE stream = $1 AND seq = 1',
    [cardStream(cardId)],
  );
  const row = q.rows[0];
  if (!row || row.type !== CARD_EVENT.opened) return null;
  const open = CardOpenedPayload.parse(row.body);
  if (open.card_id !== cardId) throw new Error(`card stream ${cardId} opens card ${open.card_id}`);
  return { open, opened_at: row.occurred_at.toISOString() };
}

export async function readCardState(db: Executor, cardId: string): Promise<CardState | null> {
  const opened = await readCardOpened(db, cardId);
  if (!opened) return null;
  const ev = await db.query<{ type: string; body: unknown }>(
    'SELECT type, body FROM record.record_event WHERE stream = $1 AND seq > 1 ORDER BY seq',
    [cardStream(cardId)],
  );
  const escalations: CardEscalatedPayload[] = [];
  const decided: CardDecidedPayload[] = [];
  let payload: CardPayloadRecordedPayload | null = null;
  let withdrawn: CardWithdrawnPayload | null = null;
  for (const e of ev.rows) {
    if (e.type === CARD_EVENT.escalated) escalations.push(CardEscalatedPayload.parse(e.body));
    else if (e.type === CARD_EVENT.decided) decided.push(CardDecidedPayload.parse(e.body));
    else if (e.type === CARD_EVENT.withdrawn) withdrawn = CardWithdrawnPayload.parse(e.body);
    else if (e.type === CARD_EVENT.payload_recorded) {
      payload = CardPayloadRecordedPayload.parse(e.body);
    }
  }
  const gates: Array<{ gate_instance_id: string; state: GateState }> = [];
  for (const id of gateIdsOf(opened.open)) {
    const state = await readGateState(db, id);
    if (!state) throw new Error(`card ${cardId} names gate ${id}, which has no open event`);
    gates.push({ gate_instance_id: id, state });
  }
  const stepRows = await db.query<{
    entry_id: string;
    decision: string;
    step: string;
    actor: string | null;
    sod_waiver: boolean;
  }>(
    `SELECT entry_id, decision, actor, sod_waiver, body ->> 'step' AS step FROM ledger.ledger_entry
      WHERE entry_type = $1 AND body ->> 'card_id' = $2 ORDER BY ledger_seq`,
    [CARD_STEP_ENTRY_TYPE, cardId],
  );
  const steps: CardStepState[] = opened.open.targets.flatMap((t) => {
    if (t.target !== 'step') return [];
    const hit = stepRows.rows.find((r) => r.step === t.step); // the first entry counts
    return [
      {
        step: t.step,
        slot: t.slot,
        decision: (hit?.decision ?? null) as VoteDecision | null,
        ledger_entry_id: hit?.entry_id ?? null,
        actor: hit?.actor ?? null,
        sod_waiver: hit ? hit.sod_waiver : null,
      },
    ];
  });
  const status = deriveCardStatus(
    gates.map((g) => ({ status: g.state.status, outcome: g.state.outcome })),
    steps.map((s) => s.decision),
    withdrawn !== null,
  );
  return {
    card_id: cardId,
    open: opened.open,
    opened_at: opened.opened_at,
    gates,
    steps,
    escalations,
    payload,
    decided,
    withdrawn,
    status,
  };
}
