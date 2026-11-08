import { RecordEvent } from '@aisdlc/contracts';

/** A `record.record_event` row as selected by `EVENT_COLUMNS` (bigints as text, so no precision loss). */
export interface EventRow {
  stream: string;
  seq: string;
  global_seq: string;
  event_id: string;
  type: string;
  body: Record<string, unknown>;
  actor: string;
  occurred_at: Date;
  idempotency_key: string | null;
  prev_hash: string;
  hash: string;
}

/**
 * Output columns alias `seq` and `global_seq` to text, which shadows the integer columns in a bare
 * `ORDER BY seq`. Always order by the qualified name (`record_event.seq`).
 */
export const EVENT_COLUMNS =
  'stream, seq::text AS seq, global_seq::text AS global_seq, event_id, type, body, actor, occurred_at, idempotency_key, prev_hash, hash';

/** Maps a row to the contract, validating it (a row that fails the contract is an error, not data). */
export function toRecordEvent(row: EventRow): RecordEvent {
  return RecordEvent.parse({
    event_id: row.event_id,
    stream_id: row.stream,
    stream_seq: Number(row.seq),
    global_seq: Number(row.global_seq),
    type: row.type,
    payload: row.body,
    actor: row.actor,
    occurred_at: row.occurred_at.toISOString(),
    idempotency_key: row.idempotency_key,
    prev_hash: row.prev_hash,
    hash: row.hash,
  });
}
