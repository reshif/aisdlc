import {
  S0_EVENT,
  s0Stream,
  type CardKind,
  type CardPayloadItem,
  type RecordEvent,
} from '@aisdlc/contracts';
import { readCardState, type CardState } from '@aisdlc/decisions';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type pg from 'pg';
import { foldS0, type S0State } from '../fold.js';
import { isHandled, parseCardKey, type HandledCard } from './model.js';

// Reading what the card layer works from: the S0 record's stream, and the cards of the record (the
// authoritative card streams and the ledger, not the inbox read model, which may lag).

export interface LoadedS0 {
  readonly s0: S0State;
  readonly events: readonly RecordEvent[];
}

export async function loadS0(pool: pg.Pool, s0Id: string): Promise<LoadedS0 | null> {
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [s0Stream(s0Id)],
  );
  const events = q.rows.map(toRecordEvent);
  const s0 = foldS0(events);
  return s0 ? { s0, events } : null;
}

/** A card of an S0 record: its state, and what the opener's key says about it. */
export interface OnboardingCard {
  readonly card_id: string;
  readonly kind: HandledCard;
  readonly occurrence: number;
  /** The security card: the finding it decides. */
  readonly finding_id: string | null;
  readonly state: CardState;
}

/** The cards of an S0 record, oldest first. Cards of a kind this layer does not own are left out. */
export async function s0Cards(pool: pg.Pool, s0Id: string): Promise<OnboardingCard[]> {
  const ids = await pool.query<{ card_id: string }>(
    `SELECT substring(stream from 6) AS card_id FROM record.record_event
      WHERE type = 'card.opened' AND body ->> 'subject_kind' = 's0_record'
        AND body ->> 'subject_id' = $1 ORDER BY global_seq`,
    [s0Id],
  );
  const out: OnboardingCard[] = [];
  for (const { card_id } of ids.rows) {
    const state = await readCardState(pool, card_id);
    if (!state) continue;
    const label = state.open.label;
    const key = parseCardKey(state.open.key);
    if (!isHandled(label) || !key) continue;
    out.push({
      card_id,
      kind: label,
      occurrence: key.occurrence,
      finding_id: key.finding_id,
      state,
    });
  }
  return out;
}

/** How many times the driver asked for a card of this kind (the last one is the live one). */
export function raisesOf(events: readonly RecordEvent[], kind: CardKind): number {
  return events.filter(
    (e) => e.type === S0_EVENT.card_required && (e.payload as { card?: string }).card === kind,
  ).length;
}

/** The newest card of `kind` that was approved: the list payload it decided, or `null`. */
export function approvedPayload(
  cards: readonly OnboardingCard[],
  kind: HandledCard,
): { card: OnboardingCard; payload: CardPayloadItem[] } | null {
  const hit = [...cards]
    .filter((c) => c.kind === kind && c.state.status === 'decided')
    .sort((a, b) => b.occurrence - a.occurrence)[0];
  return hit ? { card: hit, payload: hit.state.payload?.payload ?? [] } : null;
}

export const cardOf = (cards: readonly OnboardingCard[], id: string): OnboardingCard | undefined =>
  cards.find((c) => c.card_id === id);
