import { currentCatalogueRef, type CatalogueData } from '@aisdlc/catalogue';
import { readReleaseSetting } from '@aisdlc/config';
import {
  ITEM_EVENT,
  applyReleaseSetting,
  ItemCreatedPayload,
  type CatalogueRef,
  ItemEventPayloads,
  WORK_COMMAND_DESTINATION,
  itemStream,
  type ItemCommand,
  type ItemEvent,
  type ItemEventType,
  type ItemIntake,
  type Lane,
  type PrrGatingProfile,
  type RecordEvent,
  type SpawnOrigin,
  type WorkRequestedPayload,
} from '@aisdlc/contracts';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import {
  EVENT_COLUMNS,
  enqueueOutbox,
  toRecordEvent,
  type EventRow,
  type Executor,
  type NewEvent,
  type OutboxMessage,
} from '@aisdlc/record';
import {
  CataloguePinUnavailable,
  pinnedCatalogueResolver,
  foldItem,
  interpret,
  type FoldedItem,
  type ItemState,
  type OpenItemSummary,
} from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import type { PrrVersion } from './fold.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps, type Journal } from './journal.js';

// The work item's stream in core (PLAN M9.1, M9.2): `item:<uuid>` holds every fact about an item,
// the interpreter (`@aisdlc/work`) folds it, and what the item needs done next goes to the outbox in
// the SAME transaction as the event that caused it. Inbox first: the event is committed before any
// port is called, and every command carries its idempotency key. Nothing here calls a port.

/** The actor of events the engine itself records (a result it was handed, a gate it read from the ledger). */
export const WORK_ACTOR = 'system.work';

/** The deterministic item id of a request: one request, one item, however often it is asked. */
export const itemIdOfRequest = (requestId: string): string =>
  deterministicId<'WorkItem'>(`aisdlc.item:${requestId}`);

// ---------------------------------------------------------------- Reading

export async function readItemEvents(db: Executor, itemId: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [itemStream(itemId)],
  );
  return q.rows.map(toRecordEvent);
}

/** The item from its stream: the authority. `null` for an item that does not exist. */
export async function readItem(db: Executor, itemId: string): Promise<FoldedItem | null> {
  return foldItem(await readItemEvents(db, itemId), pinnedCatalogueResolver);
}

/** The commands the outbox must hold for an item: its outstanding ones. */
export const commandMessages = (
  itemId: string,
  commands: readonly ItemCommand[],
): OutboxMessage[] =>
  commands.map((c) => ({
    destination: WORK_COMMAND_DESTINATION,
    payload: { item_id: itemId, command: c as unknown as Record<string, unknown> },
    idempotency_key: c.key,
  }));

// ---------------------------------------------------------------- Appending

export interface ItemDraft {
  readonly type: ItemEventType;
  readonly payload: object;
  readonly actor: string;
  readonly idempotency_key?: string;
}

/**
 * Runs `drafts` through the interpreter on top of `events` (the item's stream so far), as the events
 * would be stored (the next seqs, the clock's instant truncated to the millisecond the record keeps),
 * and returns the commands they cause. A draft the interpreter cannot take throws.
 */
function plan(
  events: readonly RecordEvent[],
  drafts: readonly ItemDraft[],
  at: Date,
  cat: CatalogueData,
): { commands: ItemCommand[]; state: ItemState } {
  let state: ItemState | null = foldItem(events, () => cat)?.state ?? null;
  const commands: ItemCommand[] = [];
  let seq = events.at(-1)?.stream_seq ?? 0;
  for (const d of drafts) {
    seq += 1;
    const payload = ItemEventPayloads[d.type as ItemEventType].parse(d.payload);
    const ev = { type: d.type, payload, seq, at: at.toISOString() } as ItemEvent;
    const profile: PrrGatingProfile =
      state === null ? (ev.payload as ItemCreatedPayload).gating_profile : state.profile;
    const r = interpret(state, ev, cat, profile);
    state = r.state;
    commands.push(...r.commands);
  }
  return { commands, state: state as ItemState };
}

/** A key already stored in the stream: the signal was seen, it is a no-op. */
const seenKey = (events: readonly RecordEvent[], key: string | undefined): boolean =>
  key !== undefined && events.some((e) => e.idempotency_key === key);

/**
 * Appends drafts to an item's stream in the open transaction, with the commands they cause in the
 * outbox. The caller holds `item:<id>`. Returns the folded state after, or `duplicate` when every
 * draft's key was seen before (nothing written).
 */
export async function appendItemIn(
  j: Journal,
  itemId: string,
  drafts: readonly ItemDraft[],
  deps: Pick<CoreDeps, 'clock'>,
): Promise<Result<{ state: ItemState; commands: ItemCommand[]; duplicate: boolean }, CoreError>> {
  const stream = itemStream(itemId);
  const events = await j.events(stream);
  if (drafts.length > 0 && drafts.every((d) => seenKey(events, d.idempotency_key))) {
    const cur = foldItem(events, pinnedCatalogueResolver);
    if (!cur) return err(coreError('not_found', `no item ${itemId}`));
    return ok({ state: cur.state, commands: [], duplicate: true });
  }
  const created = drafts.find((d) => d.type === ITEM_EVENT.created);
  const pin = created
    ? ItemCreatedPayload.parse(created.payload).catalogue_ref
    : (events[0]?.payload as { catalogue_ref?: ItemCreatedPayload['catalogue_ref'] } | undefined)
        ?.catalogue_ref;
  const cat = pin ? pinnedCatalogueResolver(pin) : null;
  if (cat === null) {
    return err(
      coreError('unavailable', 'the catalogue this item is pinned to is not carried by this build'),
    );
  }
  const at = new Date(Math.floor(clockOf(deps).nowMs()));
  let planned;
  try {
    planned = plan(events, drafts, at, cat);
  } catch (e) {
    return err(coreError('conflict', e instanceof Error ? e.message : String(e)));
  }
  const newEvents: NewEvent[] = drafts.map((d) => ({
    type: d.type,
    body: d.payload as Record<string, unknown>,
    actor: d.actor,
    occurred_at: at,
    ...(d.idempotency_key ? { idempotency_key: d.idempotency_key } : {}),
  }));
  const w = await j.emitAll(stream, newEvents, {
    outbox: commandMessages(itemId, planned.commands),
  });
  if (!w.ok) return w;
  return ok({ state: planned.state, commands: planned.commands, duplicate: w.value.duplicate });
}

/** One signal into an item: its own transaction. The key makes a repeat a no-op. */
export async function ingestItem(
  deps: CoreDeps,
  itemId: string,
  draft: ItemDraft,
): Promise<Result<{ state: ItemState; commands: ItemCommand[]; duplicate: boolean }, CoreError>> {
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`item:${itemId}`]);
    if ((await j.events(itemStream(itemId))).length === 0) {
      return err(coreError('not_found', `no item ${itemId}`));
    }
    return appendItemIn(j, itemId, [draft], deps);
  });
}

/**
 * Puts the outstanding commands of an item into the outbox, once each. This is how execution state
 * is re-derived from the record: after the outbox or a worker's jobs are lost, the commands the
 * stream says are still outstanding come back with the same keys (a port or the decision kernel
 * that already did one answers from memory).
 */
export async function reconcileItemOutbox(
  deps: CoreDeps,
  itemId: string,
): Promise<Result<{ enqueued: number }, CoreError>> {
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`item:${itemId}`]);
    const events = await j.events(itemStream(itemId));
    let folded: FoldedItem | null;
    try {
      folded = foldItem(events, pinnedCatalogueResolver);
    } catch (e) {
      if (e instanceof CataloguePinUnavailable) return ok({ enqueued: 0 });
      throw e;
    }
    if (!folded) return ok({ enqueued: 0 });
    const r = await enqueueOutbox(tx, commandMessages(itemId, folded.state.outstanding));
    if (!r.ok)
      return err(
        coreError('conflict', `outbox key reused with another command: ${r.error.idempotency_key}`),
      );
    return ok({ enqueued: r.value.inserted });
  });
}

// ---------------------------------------------------------------- Creating an item

export interface CreateItemInput {
  readonly item_id: string;
  readonly request: Pick<
    WorkRequestedPayload,
    'request_id' | 'project_id' | 'repo' | 'requester' | 'channel'
  >;
  /** The governing PRR: the item pins its gating profile and tier. */
  readonly prr: PrrVersion;
  readonly proposed_lane: Lane;
  readonly intake: ItemIntake;
  readonly origin: SpawnOrigin | null;
  readonly actor: string;
  /** The catalogue the item pins. Default: the current one (a released older one is for a migration or a test). */
  readonly catalogue_ref?: CatalogueRef;
}

/**
 * Creates the item stream (`item.created`, `item.submitted`) in the open transaction, pinning the
 * catalogue and the PRR's gating profile as they are now. Once per item: a stream that exists is
 * left alone. Holds `item:<id>`; the caller holds the repo's key.
 */
export async function createItemIn(
  j: Journal,
  tx: Parameters<typeof lockKeys>[0],
  deps: Pick<CoreDeps, 'clock'>,
  i: CreateItemInput,
): Promise<Result<{ item_id: string; created: boolean }, CoreError>> {
  await lockKeys(tx, [`item:${i.item_id}`]);
  if ((await j.events(itemStream(i.item_id))).length > 0) {
    return ok({ item_id: i.item_id, created: false });
  }
  const prr = i.prr.prr;
  // M15.3: the project's release choice shapes the route it pins: `off` has no G5 (and S8b releases nothing), a
  // target keeps G5 (and the T2 floor holds it on). Not chosen or unreadable leaves the readiness record's profile.
  const release = await readReleaseSetting(tx, i.request.project_id);
  const created = ItemCreatedPayload.safeParse({
    item_id: i.item_id,
    project_id: i.request.project_id,
    request_id: i.request.request_id,
    repo: i.request.repo,
    requester: i.request.requester,
    channel: i.request.channel,
    catalogue_ref: i.catalogue_ref ?? currentCatalogueRef(),
    gating_profile: applyReleaseSetting(
      prr.gating_profile,
      release.state === 'ok' ? release.value : null,
    ),
    tier: prr.tier.value,
    prr: { version: i.prr.version, record_hash: prr.record_hash },
    proposed_lane: i.proposed_lane,
    intake: i.intake,
    origin: i.origin,
  });
  if (!created.success) return err(coreError('invalid_input', created.error.message));
  const w = await appendItemIn(
    j,
    i.item_id,
    [
      {
        type: ITEM_EVENT.created,
        payload: created.data,
        actor: i.actor,
        idempotency_key: `created:${i.item_id}`,
      },
      {
        type: ITEM_EVENT.submitted,
        payload: {},
        actor: i.actor,
        idempotency_key: `submitted:${i.item_id}`,
      },
    ],
    deps,
  );
  if (!w.ok) return w;
  return ok({ item_id: i.item_id, created: true });
}

// ---------------------------------------------------------------- De-dupe (1.2)

/** The open items of a repo, from their streams (never a read model: two requests at once must see each other). */
export async function openItemsOfRepo(j: Journal, repo: string): Promise<OpenItemSummary[]> {
  const q = await j.tx.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event
      WHERE type = $1 AND lower(body ->> 'repo') = $2 LIMIT 500`,
    [ITEM_EVENT.created, repo.toLowerCase()],
  );
  const out: OpenItemSummary[] = [];
  for (const { stream } of q.rows) {
    const folded = foldItem(await j.events(stream), pinnedCatalogueResolver);
    if (!folded || folded.state.terminal !== null) continue;
    const s = folded.state;
    out.push({
      item_id: s.item_id as never,
      repo: s.repo,
      text_sha256: s.intake.text_sha256,
      lane: s.lane ?? s.proposed_lane,
    });
  }
  return out;
}
