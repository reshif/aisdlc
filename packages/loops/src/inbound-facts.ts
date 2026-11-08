import {
  INBOUND_FACT_EVENT,
  InboundFactPayload,
  inboundFactKey,
  inboundFactStream,
  inboundValueHash,
  type InboundFactKind,
  type ProjectId,
  type RepoFullName,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { appendEvents } from '@aisdlc/record';
import type pg from 'pg';

// Writing an observed fact (PLAN M5.4; PLAN principle 3, inbox first). A poll compares what it saw
// with the last fact of the same repo and kind IN THE RECORD (not in memory, so a restart or a
// second worker decides the same way) and appends an `inbound.fact_observed` event only when the
// value changed. The idempotency key is repo + kind + the hash of the value + the hash it replaces
// (`inboundFactKey`), so two workers that saw the same change write one event.

export interface Observation {
  readonly kind: InboundFactKind;
  readonly repo: RepoFullName;
  readonly project_id: ProjectId;
  /** What was seen: a JSON object. */
  readonly value: Record<string, unknown>;
  /** The interval the poll runs at, recorded with the fact. */
  readonly poll_interval_ms: number;
}

export type ObservationOutcome = 'recorded' | 'unchanged';

const MAX_RACES = 4;

export async function recordObservation(
  pool: pg.Pool,
  o: Observation,
  clock: Clock = systemClock,
): Promise<ObservationOutcome> {
  const stream = inboundFactStream(o.kind, o.repo);
  const hash = inboundValueHash(o.value);
  for (let attempt = 0; attempt < MAX_RACES; attempt++) {
    const outcome = await withTransaction(
      pool,
      async (tx): Promise<ObservationOutcome | 'raced'> => {
        const head = await tx.query<{ seq: string; value_hash: string }>(
          `SELECT seq::text AS seq, body->>'value_hash' AS value_hash
           FROM record.record_event WHERE stream = $1 ORDER BY seq DESC LIMIT 1`,
          [stream],
        );
        const last = head.rows[0];
        if (last?.value_hash === hash) return 'unchanged';
        const previous = last?.value_hash ?? null;
        const payload = InboundFactPayload.parse({
          repo: o.repo,
          project_id: o.project_id,
          kind: o.kind,
          value: o.value,
          value_hash: hash,
          previous_hash: previous,
          poll_interval_ms: o.poll_interval_ms,
        });
        const w = await appendEvents(
          tx,
          stream,
          Number(last?.seq ?? 0),
          [
            {
              type: INBOUND_FACT_EVENT.observed,
              actor: `system:poll:${o.kind}`,
              idempotency_key: inboundFactKey(o.kind, o.repo, hash, previous),
              body: payload,
              occurred_at: clock.now(),
            },
          ],
          { clock },
        );
        if (w.ok) return w.value.duplicate ? 'unchanged' : 'recorded';
        // Another worker appended first: read the stream again (and, if it saw the same change,
        // find it already there).
        if (w.error._tag === 'ConcurrencyConflict' || w.error._tag === 'IdempotencyMismatch') {
          return 'raced';
        }
        throw new Error(`inbound fact refused: ${JSON.stringify(w.error)}`);
      },
    );
    if (outcome !== 'raced') return outcome;
  }
  throw new Error(`inbound fact ${stream}: lost the race ${MAX_RACES} times`);
}
