import type { RecordEvent } from '@aisdlc/contracts';
import {
  canonicalJson,
  err,
  newId,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { computeEventHash, GENESIS_HASH } from './hash.js';
import { enqueueOutbox, type OutboxKeyMismatch, type OutboxMessage } from './outbox.js';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from './rows.js';
import type { JsonObject, Tx } from './types.js';

export const ConcurrencyConflict = taggedError('ConcurrencyConflict');
export type ConcurrencyConflict = TaggedError<
  'ConcurrencyConflict',
  { stream: string; expected_seq: number; actual_seq: number }
>;

export type IdempotencyMismatchReason =
  /** The key exists in this stream with a different type or body. */
  | 'different_body'
  /** Some events of the batch are already stored and some are new. */
  | 'partial_batch'
  /** The batch uses one key twice. */
  | 'duplicate_in_batch';

export const IdempotencyMismatch = taggedError('IdempotencyMismatch');
export type IdempotencyMismatch = TaggedError<
  'IdempotencyMismatch',
  { stream: string; idempotency_key: string; reason: IdempotencyMismatchReason }
>;

const mismatch = (
  stream: string,
  idempotency_key: string,
  reason: IdempotencyMismatchReason,
): IdempotencyMismatch => IdempotencyMismatch({ stream, idempotency_key, reason });

export type AppendError = ConcurrencyConflict | IdempotencyMismatch | OutboxKeyMismatch;

export interface NewEvent {
  /** Dotted lowercase, for example `item.question_asked`. */
  type: string;
  body: JsonObject;
  actor: string;
  /** Every inbound signal carries one (PLAN principle 3). */
  idempotency_key?: string | null;
  event_id?: string;
  /** Defaults to the clock; truncated to milliseconds. */
  occurred_at?: Date;
}

export interface AppendOptions {
  clock?: Clock;
  /** Outbox rows written in the same transaction, or built from the stored events. */
  outbox?: readonly OutboxMessage[] | ((events: RecordEvent[]) => readonly OutboxMessage[]);
}

export interface AppendOutcome {
  events: RecordEvent[];
  /** True when every event was already stored under its idempotency key: nothing was written. */
  duplicate: boolean;
}

const sameContent = (row: EventRow, e: NewEvent): boolean =>
  row.type === e.type && canonicalJson(row.body) === canonicalJson(e.body);

/**
 * Appends `events` to `stream` inside the caller's transaction `tx`.
 *
 * `expectedSeq` is the stream's head the caller read (0 for a new stream). A different head is a
 * `ConcurrencyConflict`. The first statement locks `record.global_counter`, so appends are
 * serialised and the head cannot move between the check and the insert; the lock is released at
 * COMMIT or ROLLBACK, so keep the transaction short.
 *
 * Idempotency: if every event's key is already stored in this stream with the same type and body,
 * the originals are returned and nothing is written, whatever `expectedSeq` says (the stream has
 * moved on since). Same key with another body, or a batch that is only partly stored, is an
 * `IdempotencyMismatch`.
 *
 * An `Err` leaves nothing written (a savepoint is rolled back), but the global lock is held until
 * the caller ends the transaction.
 */
export async function appendEvents(
  tx: Tx,
  stream: string,
  expectedSeq: number,
  events: readonly NewEvent[],
  opts: AppendOptions = {},
): Promise<Result<AppendOutcome, AppendError>> {
  if (stream === '') throw new RangeError('appendEvents: empty stream');
  if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
    throw new RangeError('appendEvents: expectedSeq must be a non-negative integer');
  }
  if (events.length === 0) return ok({ events: [], duplicate: false });
  const clock = opts.clock ?? systemClock;

  const seen = new Set<string>();
  for (const e of events) {
    const k = e.idempotency_key ?? null;
    if (k === null) continue;
    if (seen.has(k)) {
      return err(mismatch(stream, k, 'duplicate_in_batch'));
    }
    seen.add(k);
  }

  await tx.query('SAVEPOINT record_append');
  try {
    const result = await appendLocked(tx, stream, expectedSeq, events, clock, opts);
    if (result.ok) await tx.query('RELEASE SAVEPOINT record_append');
    else await tx.query('ROLLBACK TO SAVEPOINT record_append');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT record_append').catch(() => undefined);
    throw e;
  }
}

async function appendLocked(
  tx: Tx,
  stream: string,
  expectedSeq: number,
  events: readonly NewEvent[],
  clock: Clock,
  opts: AppendOptions,
): Promise<Result<AppendOutcome, AppendError>> {
  const counter = await tx.query<{ last_seq: string }>(
    'SELECT last_seq::text AS last_seq FROM record.global_counter WHERE id FOR UPDATE',
  );
  const lastGlobal = Number(counter.rows[0]?.last_seq);
  if (!Number.isSafeInteger(lastGlobal)) throw new Error('record.global_counter is missing');

  // Idempotency first: a retry of an already-stored batch succeeds even though the head moved.
  const keys = events.flatMap((e) => (e.idempotency_key == null ? [] : [e.idempotency_key]));
  const stored = new Map<string, EventRow>();
  if (keys.length > 0) {
    const r = await tx.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM record.record_event
        WHERE stream = $1 AND idempotency_key = ANY($2::text[])`,
      [stream, keys],
    );
    for (const row of r.rows) stored.set(row.idempotency_key as string, row);
  }
  let duplicates = 0;
  for (const e of events) {
    const row = e.idempotency_key == null ? undefined : stored.get(e.idempotency_key);
    if (!row) continue;
    if (!sameContent(row, e)) {
      return err(mismatch(stream, e.idempotency_key as string, 'different_body'));
    }
    duplicates += 1;
  }
  if (duplicates === events.length) {
    const originals = events.map((e) => toRecordEvent(stored.get(e.idempotency_key as string)!));
    return ok({ events: originals, duplicate: true });
  }
  if (duplicates > 0) {
    const first = events.find((e) => e.idempotency_key != null && stored.has(e.idempotency_key));
    return err(mismatch(stream, first?.idempotency_key as string, 'partial_batch'));
  }

  const head = await tx.query<{ seq: string; hash: string }>(
    'SELECT seq::text AS seq, hash FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq DESC LIMIT 1',
    [stream],
  );
  const actualSeq = Number(head.rows[0]?.seq ?? 0);
  if (actualSeq !== expectedSeq) {
    return err(ConcurrencyConflict({ stream, expected_seq: expectedSeq, actual_seq: actualSeq }));
  }

  let prevHash = head.rows[0]?.hash ?? GENESIS_HASH;
  let seq = actualSeq;
  let global = lastGlobal;
  const written: RecordEvent[] = [];
  for (const e of events) {
    seq += 1;
    global += 1;
    const occurred = e.occurred_at ?? clock.now();
    const occurredAt = new Date(Math.floor(occurred.getTime())).toISOString();
    const eventId = e.event_id ?? newId<'RecordEvent'>(clock.nowMs());
    const hash = computeEventHash({
      stream,
      seq,
      event_id: eventId,
      type: e.type,
      body: e.body,
      actor: e.actor,
      occurred_at: occurredAt,
      prev_hash: prevHash,
    });
    const r = await tx.query<EventRow>(
      `INSERT INTO record.record_event
         (stream, seq, global_seq, event_id, type, body, actor, occurred_at, idempotency_key, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
       RETURNING ${EVENT_COLUMNS}`,
      [
        stream,
        String(seq),
        String(global),
        eventId,
        e.type,
        JSON.stringify(e.body),
        e.actor,
        occurredAt,
        e.idempotency_key ?? null,
        prevHash,
        hash,
      ],
    );
    written.push(toRecordEvent(r.rows[0] as EventRow));
    prevHash = hash;
  }
  await tx.query('UPDATE record.global_counter SET last_seq = $1 WHERE id', [String(global)]);

  const messages = typeof opts.outbox === 'function' ? opts.outbox(written) : (opts.outbox ?? []);
  if (messages.length > 0) {
    const queued = await enqueueOutbox(tx, messages);
    if (!queued.ok) return queued;
  }
  return ok({ events: written, duplicate: false });
}
