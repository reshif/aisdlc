import {
  UNIT_EVENT,
  UnitEventPayloads,
  unitStream,
  type RecordEvent,
  type UnitEventType,
} from '@aisdlc/contracts';
import { ok, type Result } from '@aisdlc/kernel';
import type { Tx } from '@aisdlc/record';
import type { CoreError } from '../errors.js';
import type { Journal } from '../journal.js';
import { applyUnitEvent } from './fold.js';

/** The actor of the events the admission and lease code records. */
export const ADMISSION_ACTOR = 'system.admission';

/**
 * Records one `unit.*` event and folds it into the rows, in the caller's transaction (which holds the item's
 * unit lock). The payload is validated against its contract first. A key already stored is `duplicate`: the
 * event is the earlier one and the rows already reflect it.
 */
export async function emitUnitEvent<T extends UnitEventType>(
  j: Journal,
  tx: Tx,
  itemId: string,
  type: T,
  payload: ReturnType<(typeof UnitEventPayloads)[T]['parse']>,
  idempotency_key: string,
): Promise<Result<{ event: RecordEvent; duplicate: boolean }, CoreError>> {
  const body = UnitEventPayloads[type].parse(payload);
  const w = await j.emitAll(unitStream(itemId), [
    {
      type,
      body: body as unknown as Record<string, unknown>,
      actor: ADMISSION_ACTOR,
      idempotency_key,
    },
  ]);
  if (!w.ok) return w;
  const event = w.value.events[0] as RecordEvent;
  if (!w.value.duplicate) {
    await applyUnitEvent(tx, {
      type: event.type,
      payload: event.payload,
      occurred_at: event.occurred_at,
      global_seq: event.global_seq,
    });
  }
  return ok({ event, duplicate: w.value.duplicate });
}

export { UNIT_EVENT };
