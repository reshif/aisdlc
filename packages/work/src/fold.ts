import { CATALOGUE, isCurrentCatalogue, type CatalogueData } from '@aisdlc/catalogue';
import {
  ITEM_EVENT,
  ItemEventPayloads,
  ItemCreatedPayload,
  type CatalogueRef,
  type ItemCommand,
  type ItemEvent,
  type ItemEventType,
  type RecordEvent,
} from '@aisdlc/contracts';
import { interpret } from './interpret.js';
import type { ItemState } from './state.js';

// Folding an item's stream: `RecordEvent`s -> `ItemEvent`s -> `interpret`, one after the other.

/** The catalogue an item is pinned to, or `null` when this build does not carry it (fail closed). */
export type CatalogueResolver = (ref: CatalogueRef) => CatalogueData | null;

/** This build carries one catalogue: an item pinned to another revision cannot be interpreted here. */
export const currentCatalogueResolver: CatalogueResolver = (ref) =>
  isCurrentCatalogue(ref) ? CATALOGUE : null;

export class CataloguePinUnavailable extends Error {
  override readonly name = 'CataloguePinUnavailable';
}

/** A record event of an item stream, validated. Throws on a type or payload this vocabulary does not know. */
export function parseItemEvent(e: RecordEvent): ItemEvent {
  const type = e.type as ItemEventType;
  const schema = ItemEventPayloads[type];
  if (!schema) throw new Error(`unknown item event type ${e.type}`);
  return {
    type,
    payload: schema.parse(e.payload),
    seq: e.stream_seq,
    at: e.occurred_at,
  } as ItemEvent;
}

export interface FoldedItem {
  readonly state: ItemState;
  /** Commands each event caused, in order (a replay produces exactly these). */
  readonly issued: ReadonlyArray<{ readonly seq: number; readonly commands: ItemCommand[] }>;
}

/** The state of an item and the commands its events caused, from its whole stream. `null` for an empty stream. */
export function foldItem(
  events: readonly RecordEvent[],
  resolve: CatalogueResolver = currentCatalogueResolver,
): FoldedItem | null {
  let state: ItemState | null = null;
  let cat: CatalogueData | null = null;
  const issued: Array<{ seq: number; commands: ItemCommand[] }> = [];
  for (const e of events) {
    const ev = parseItemEvent(e);
    if (state === null) {
      if (ev.type !== ITEM_EVENT.created)
        throw new Error('an item stream starts with item.created');
      const p = ItemCreatedPayload.parse(ev.payload);
      cat = resolve(p.catalogue_ref);
      if (cat === null)
        throw new CataloguePinUnavailable(
          `catalogue pin unavailable: ${p.catalogue_ref.version}/${p.catalogue_ref.hash}`,
        );
      state = interpret(null, ev, cat, p.gating_profile).state;
      continue;
    }
    const r = interpret(state, ev, cat as CatalogueData, state.profile);
    state = r.state;
    if (r.commands.length > 0) issued.push({ seq: e.stream_seq, commands: r.commands });
  }
  return state === null ? null : { state, issued };
}

/** The agent-session side of "work in flight": a coding or verify command is out. */
export const sessionOpen = (s: ItemState): boolean =>
  s.outstanding.some((c) => c.type === 'run_stage' && (c.port === 'coding' || c.port === 'verify'));

/**
 * Agent work in flight (PLAN M9.2, OB §6.5): the item is in S6 or S7 (held items keep the phase they
 * resume to) and an agent lease is open or a coding or verify command is out.
 */
export function workInFlight(s: ItemState): boolean {
  if (s.terminal !== null) return false;
  return (s.underlying === 'S6' || s.underlying === 'S7') && (s.lease !== null || sessionOpen(s));
}
