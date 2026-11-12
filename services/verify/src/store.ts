import {
  VERIFY_EVENT,
  VerifyCheckRecordedPayload,
  VerifyCheckResult,
  verifyResultHash,
  verifyStream,
  type VerifyCheckResult as Result,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// The verify service's record (PLAN M14.3): every result is a `verify.check_recorded` event on `verify:<item>` (the
// whole result and its hash; the idempotency key is the stage command's key), and the `verify.check_result` read
// model is written in the same transaction. The read model is rebuildable from the record alone.

export interface StoredResult {
  readonly command_key: string;
  readonly result_sha256: string;
  readonly result: Result;
}

const ACTOR = 'system.verify';

interface Row {
  command_key: string;
  result_sha256: string;
  result: unknown;
}

const parseRow = (r: Row): StoredResult => {
  const result = VerifyCheckResult.parse(r.result);
  // the read model is a copy: what it says must still hash to the address it is filed under
  if (verifyResultHash(result) !== r.result_sha256) {
    throw new Error(
      `verify.check_result ${r.command_key}: the result does not hash to its address`,
    );
  }
  return { command_key: r.command_key, result_sha256: r.result_sha256, result };
};

export async function resultByCommand(
  pool: pg.Pool,
  commandKey: string,
): Promise<StoredResult | null> {
  const q = await pool.query<Row>(
    'SELECT command_key, result_sha256, result FROM verify.check_result WHERE command_key = $1',
    [commandKey],
  );
  return q.rows[0] ? parseRow(q.rows[0]) : null;
}

export async function resultByHash(pool: pg.Pool, sha: string): Promise<StoredResult | null> {
  const q = await pool.query<Row>(
    'SELECT command_key, result_sha256, result FROM verify.check_result WHERE result_sha256 = $1 ORDER BY event_gseq LIMIT 1',
    [sha],
  );
  return q.rows[0] ? parseRow(q.rows[0]) : null;
}

/** Every result of an item's head, in record order. */
export async function resultsOf(
  pool: pg.Pool,
  itemId: string,
  headSha: string,
): Promise<StoredResult[]> {
  const q = await pool.query<Row>(
    `SELECT command_key, result_sha256, result FROM verify.check_result
      WHERE item_id = $1 AND head_sha = $2 ORDER BY event_gseq`,
    [itemId, headSha],
  );
  return q.rows.map(parseRow);
}

const project = async (
  tx: pg.PoolClient,
  p: VerifyCheckRecordedPayload,
  gseq: number,
  at: string,
): Promise<void> => {
  const r = p.result;
  await tx.query(
    `INSERT INTO verify.check_result
       (command_key, result_sha256, item_id, unit_key, step, base_sha, head_sha, verdict, raised, result, event_gseq, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (command_key) DO NOTHING`,
    [
      p.command_key,
      p.result_sha256,
      r.item_id,
      r.unit_key,
      r.step,
      r.base_sha,
      r.head_sha,
      r.verdict,
      r.raised === null ? null : r.raised.kind === 'gate' ? r.raised.gate : r.raised.trigger,
      JSON.stringify(r),
      gseq,
      at,
    ],
  );
};

/**
 * Records one result under its command key (record first, the read model in the same transaction). A second call
 * with the same key returns what the first stored, whatever it is given: a command does its work once.
 */
export async function recordResult(
  pool: pg.Pool,
  commandKey: string,
  result: Result,
  clock: Clock = systemClock,
): Promise<{ stored: StoredResult; duplicate: boolean }> {
  const payload = VerifyCheckRecordedPayload.parse({
    command_key: commandKey,
    result_sha256: verifyResultHash(result),
    result,
  });
  const stream = verifyStream(result.item_id);
  const dup = await withTransaction(pool, async (tx) => {
    for (let i = 0; i < 8; i++) {
      const head = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [stream],
      );
      const a = await appendEvents(
        tx,
        stream,
        Number(head.rows[0]?.seq ?? 0),
        [
          {
            type: VERIFY_EVENT.check_recorded,
            body: payload as unknown as JsonObject,
            actor: ACTOR,
            idempotency_key: `verify:${commandKey}`,
          },
        ],
        { clock },
      );
      if (a.ok) {
        const e = a.value.events[0];
        if (!e) throw new Error('the record appended nothing');
        if (!a.value.duplicate) await project(tx, payload, e.global_seq, e.occurred_at);
        return a.value.duplicate;
      }
      if (a.error._tag === 'IdempotencyMismatch') return true; // the key holds another result: the first one stands
      if (a.error._tag !== 'ConcurrencyConflict')
        throw new Error(`record append refused: ${a.error._tag}`);
    }
    throw new Error('record append: too many conflicts');
  });
  const stored = await resultByCommand(pool, commandKey);
  if (!stored) throw new Error('the result was recorded but is not in the read model');
  return { stored, duplicate: dup };
}

/** Rebuilds `verify.check_result` from the record alone (run as the schema's owner: the service's role deletes nothing). */
export async function rebuildCheckResults(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await tx.query('DELETE FROM verify.check_result');
    const ev = await tx.query<{ body: unknown; global_seq: string; occurred_at: Date }>(
      `SELECT body, global_seq::text, occurred_at FROM record.record_event
        WHERE stream LIKE 'verify:%' AND type = $1 ORDER BY global_seq`,
      [VERIFY_EVENT.check_recorded],
    );
    for (const e of ev.rows) {
      await project(
        tx,
        VerifyCheckRecordedPayload.parse(e.body),
        Number(e.global_seq),
        e.occurred_at.toISOString(),
      );
    }
    return ev.rows.length;
  });
}
