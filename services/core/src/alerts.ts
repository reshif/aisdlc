import {
  OPS_ALERT_AFTER_MS,
  OPS_ALERT_EVENT,
  OPS_ALERT_SUBJECT_CHECKPOINT,
  OPS_CHECKPOINT_OVERDUE_MS,
  OpsAlertClearedPayload,
  OpsAlertRaisedPayload,
  opsAlertStream,
  type HealthSnapshot,
  type OpsAlertKind,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { deterministicId } from '@aisdlc/kernel';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// Alerts to a person (RC-NOT-3). core-worker's health loop reads every tile every 30 s; a reading is not a fact and
// is never in the record. An ALERT is: when a tile has read bad for `afterMs` (a service down or degraded, a loop
// stalled or failing), or the ledger's newest checkpoint is older than `checkpointOverdueMs` while entries wait behind
// it, this records `ops.alert_raised` on the subject's own stream `alert:<subject>`, once per episode, and
// `ops.alert_cleared` when the subject reads healthy again. The notifier turns a raise into `factory_alert` for the
// factory admins. A tile that reads `unknown` (starting, nothing read it) neither raises nor clears.

export const ALERT_ACTOR = 'system.health';

export interface AlertOptions {
  readonly afterMs?: number;
  readonly checkpointOverdueMs?: number;
}

type Verdict = { readonly bad: OpsAlertKind; readonly code: string | null } | 'ok' | 'unknown';

/** What one reading says for alerting. A degraded loop heals itself (backoff) and pages nobody; a down one does. */
export function verdictOf(s: HealthSnapshot): Verdict {
  if (s.state === 'unknown') return 'unknown';
  if (s.state === 'ok') return 'ok';
  if (s.domain === 'loop')
    return s.state === 'down' ? { bad: 'loop_stalled', code: s.detail_code } : 'unknown';
  return { bad: s.state === 'down' ? 'service_down' : 'service_degraded', code: s.detail_code };
}

async function lastOf(
  tx: pg.PoolClient,
  stream: string,
): Promise<{ seq: number; type: string | null; alert_id: string | null }> {
  const r = await tx.query<{ seq: string; type: string; body: { alert_id?: unknown } }>(
    `SELECT seq::text AS seq, type, body FROM record.record_event WHERE stream = $1
      ORDER BY record_event.seq DESC LIMIT 1`,
    [stream],
  );
  const row = r.rows[0];
  if (!row) return { seq: 0, type: null, alert_id: null };
  return {
    seq: Number(row.seq),
    type: row.type,
    alert_id: typeof row.body.alert_id === 'string' ? row.body.alert_id : null,
  };
}

/**
 * Raises or clears the alert of one subject (idempotent: an open alert is not raised again, a closed one not cleared
 * again). Returns what it recorded.
 */
export async function recordAlert(
  pool: pg.Pool,
  subject: string,
  next: { readonly kind: OpsAlertKind; readonly code: string | null; readonly since: Date } | null,
  now: Date,
): Promise<'raised' | 'cleared' | null> {
  const stream = opsAlertStream(subject);
  return withTransaction(pool, async (tx) => {
    const last = await lastOf(tx, stream);
    const open = last.type === OPS_ALERT_EVENT.raised;
    if (next !== null && !open) {
      const alert_id = deterministicId(`ops-alert:${subject}:${last.seq + 1}`);
      const body = OpsAlertRaisedPayload.parse({
        alert_id,
        subject,
        kind: next.kind,
        detail_code: next.code,
        since: next.since.toISOString(),
      });
      const a = await appendEvents(tx, stream, last.seq, [
        {
          type: OPS_ALERT_EVENT.raised,
          body: body as unknown as JsonObject,
          actor: ALERT_ACTOR,
          idempotency_key: `raise:${last.seq + 1}`,
          occurred_at: now,
        },
      ]);
      if (!a.ok) throw new Error(`alert ${subject}: ${a.error._tag}`);
      return 'raised';
    }
    if (next === null && open && last.alert_id !== null) {
      const body = OpsAlertClearedPayload.parse({
        alert_id: last.alert_id,
        subject,
        cleared_at: now.toISOString(),
      });
      const a = await appendEvents(tx, stream, last.seq, [
        {
          type: OPS_ALERT_EVENT.cleared,
          body: body as unknown as JsonObject,
          actor: ALERT_ACTOR,
          idempotency_key: `clear:${last.seq + 1}`,
          occurred_at: now,
        },
      ]);
      if (!a.ok) throw new Error(`alert ${subject}: ${a.error._tag}`);
      return 'cleared';
    }
    return null;
  });
}

/**
 * The ledger's checkpoint: overdue when entries exist past the newest Witness-co-signed checkpoint and the oldest of
 * them is older than `overdueMs` (a checkpointer that is down, a Witness that refuses). `null`: the head is covered.
 */
export async function checkpointLag(
  db: Pick<pg.Pool, 'query'>,
): Promise<{ readonly uncovered_since: Date } | null> {
  const r = await db.query<{ at: Date | null }>(
    `SELECT min(e.created_at) AS at FROM ledger.ledger_entry e
      WHERE e.ledger_seq > coalesce((SELECT max(to_ledger_seq) FROM ledger.checkpoint), 0)`,
  );
  const at = r.rows[0]?.at ?? null;
  return at === null ? null : { uncovered_since: at };
}

/** Holds when each subject was first read bad (in memory: a restart waits `afterMs` again, never pages early). */
export class AlertTracker {
  private readonly badSince = new Map<string, number>();
  constructor(private readonly o: AlertOptions = {}) {}

  /** One evaluation after a health collection: every tile, then the ledger's checkpoint. */
  async evaluate(
    pool: pg.Pool,
    snaps: readonly HealthSnapshot[],
    now: Date,
    o: { readonly checkpoint?: boolean } = {},
  ): Promise<{ raised: string[]; cleared: string[] }> {
    const after = this.o.afterMs ?? OPS_ALERT_AFTER_MS;
    const raised: string[] = [];
    const cleared: string[] = [];
    const note = (subject: string, r: 'raised' | 'cleared' | null) => {
      if (r === 'raised') raised.push(subject);
      if (r === 'cleared') cleared.push(subject);
    };
    for (const s of snaps) {
      const v = verdictOf(s);
      if (v === 'unknown') continue;
      if (v === 'ok') {
        this.badSince.delete(s.tile_id);
        note(s.tile_id, await recordAlert(pool, s.tile_id, null, now));
        continue;
      }
      const since = this.badSince.get(s.tile_id) ?? now.getTime();
      this.badSince.set(s.tile_id, since);
      if (now.getTime() - since < after) continue;
      note(
        s.tile_id,
        await recordAlert(
          pool,
          s.tile_id,
          { kind: v.bad, code: v.code, since: new Date(since) },
          now,
        ),
      );
    }
    if (o.checkpoint !== false) {
      const lag = await checkpointLag(pool);
      const overdue = this.o.checkpointOverdueMs ?? OPS_CHECKPOINT_OVERDUE_MS;
      if (lag === null) {
        note(
          OPS_ALERT_SUBJECT_CHECKPOINT,
          await recordAlert(pool, OPS_ALERT_SUBJECT_CHECKPOINT, null, now),
        );
      } else if (now.getTime() - lag.uncovered_since.getTime() >= overdue) {
        note(
          OPS_ALERT_SUBJECT_CHECKPOINT,
          await recordAlert(
            pool,
            OPS_ALERT_SUBJECT_CHECKPOINT,
            { kind: 'checkpoint_overdue', code: 'overdue', since: lag.uncovered_since },
            now,
          ),
        );
      }
    }
    return { raised, cleared };
  }
}
