import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DeliveryFailedPayload,
  DeliverySucceededPayload,
  NOTIFIER_EVENT,
  NotificationContent,
  NotificationPreferences,
  NotificationRaisedPayload,
  PreferencesSetPayload,
  notifierPrefStream,
  notifierStream,
  type DataClass,
  type DeliveryErrorCode,
  type NotificationReason,
  type NotificationView,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { hashCanonical, type Clock } from '@aisdlc/kernel';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// The notifier's record (PLAN M18): every fact it learns is a `notifier.*` event on the person's stream, and the read
// models (`notifier.notification`, `notifier.delivery`, `notifier.preference`) are written in the same transaction and
// rebuilt from the events alone (`rebuildNotifier`). The delivery rows are the outbox: a delivery is pending from the
// event that raised it until a `delivery_succeeded` or a final `delivery_failed` (no `retry_at`).

export const NOTIFIER_RECORD_ACTOR = 'system.notifier';

type Tx = pg.PoolClient;
interface Appended {
  readonly global_seq: number;
  readonly occurred_at: string;
  readonly duplicate: boolean;
}

/**
 * Appends one event at the head of `stream` (retrying a concurrent writer), keyed by `key`: the same key and body
 * again is a duplicate (nothing folded twice), the same key with another body is left as it was (`null`).
 */
export async function appendNotifierEvent(
  tx: Tx,
  stream: string,
  type: string,
  body: object,
  key: string,
  clock: Clock,
): Promise<Appended | null> {
  for (let i = 0; i < 8; i++) {
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [stream],
    );
    const a = await appendEvents(
      tx,
      stream,
      Number(head.rows[0]?.seq ?? 0),
      [{ type, body: body as JsonObject, actor: NOTIFIER_RECORD_ACTOR, idempotency_key: key }],
      { clock },
    );
    if (a.ok) {
      const e = a.value.events[0];
      if (!e) throw new Error('the record appended nothing');
      return { global_seq: e.global_seq, occurred_at: e.occurred_at, duplicate: a.value.duplicate };
    }
    if (a.error._tag === 'IdempotencyMismatch') return null;
    if (a.error._tag !== 'ConcurrencyConflict')
      throw new Error(`record append refused: ${a.error._tag}`);
  }
  throw new Error('record append: too many conflicts');
}

// ---------------------------------------------------------------- folds (deterministic in the event)

async function foldRaised(tx: Tx, p: NotificationRaisedPayload, gseq: number): Promise<void> {
  await tx.query(
    `INSERT INTO notifier.notification
       (notification_id, principal_id, kind, project_id, reason, slot, data_class, content, source_stream, source_gseq,
        raised_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (notification_id) DO NOTHING`,
    [
      p.notification_id,
      p.principal_id,
      p.content.kind,
      p.content.project_id,
      p.reason,
      p.slot,
      p.data_class,
      JSON.stringify(p.content),
      p.source.stream,
      p.source.global_seq,
      p.raised_at,
      gseq,
    ],
  );
  for (const d of p.deliveries) {
    await tx.query(
      `INSERT INTO notifier.delivery (delivery_id, notification_id, principal_id, channel_id, status, event_gseq)
       VALUES ($1,$2,$3,$4,'pending',$5) ON CONFLICT (delivery_id) DO NOTHING`,
      [d.delivery_id, p.notification_id, p.principal_id, d.channel_id, gseq],
    );
  }
}

async function foldDelivered(tx: Tx, p: DeliverySucceededPayload, gseq: number): Promise<void> {
  await tx.query(
    `UPDATE notifier.delivery SET status = 'delivered', attempts = $2, last_error = NULL, next_attempt_at = NULL,
            delivered_at = $3, rendered_class = $4, event_gseq = $5
      WHERE delivery_id = $1 AND status = 'pending'`,
    [p.delivery_id, p.attempt, p.delivered_at, p.rendered_class, gseq],
  );
}

async function foldFailed(tx: Tx, p: DeliveryFailedPayload, gseq: number): Promise<void> {
  await tx.query(
    `UPDATE notifier.delivery SET status = CASE WHEN $4::timestamptz IS NULL THEN 'given_up' ELSE 'pending' END,
            attempts = $2, last_error = $3, next_attempt_at = $4, event_gseq = $5
      WHERE delivery_id = $1 AND status = 'pending'`,
    [p.delivery_id, p.attempt, p.error_code, p.retry_at, gseq],
  );
}

async function foldPreferences(tx: Tx, p: PreferencesSetPayload, gseq: number): Promise<void> {
  await tx.query(
    `INSERT INTO notifier.preference (principal_id, preferences, set_at, event_gseq) VALUES ($1,$2,$3,$4)
     ON CONFLICT (principal_id) DO UPDATE SET preferences = EXCLUDED.preferences, set_at = EXCLUDED.set_at,
       event_gseq = EXCLUDED.event_gseq
     WHERE notifier.preference.event_gseq < EXCLUDED.event_gseq`,
    [p.principal_id, JSON.stringify(p.preferences), p.set_at, gseq],
  );
}

// ---------------------------------------------------------------- writes

/** Raises one notification (and its deliveries) in the caller's transaction. `true`: it was new. */
export async function recordRaised(
  tx: Tx,
  raw: NotificationRaisedPayload,
  clock: Clock,
): Promise<boolean> {
  const p = NotificationRaisedPayload.parse(raw);
  const a = await appendNotifierEvent(
    tx,
    notifierStream(p.principal_id),
    NOTIFIER_EVENT.raised,
    p,
    `raise:${p.notification_id}`,
    clock,
  );
  if (a === null || a.duplicate) return false;
  await foldRaised(tx, p, a.global_seq);
  return true;
}

export async function recordDelivered(
  tx: Tx,
  principal: string,
  raw: DeliverySucceededPayload,
  clock: Clock,
): Promise<void> {
  const p = DeliverySucceededPayload.parse(raw);
  const a = await appendNotifierEvent(
    tx,
    notifierStream(principal),
    NOTIFIER_EVENT.delivered,
    p,
    `delivered:${p.delivery_id}`,
    clock,
  );
  if (a && !a.duplicate) await foldDelivered(tx, p, a.global_seq);
}

export async function recordFailed(
  tx: Tx,
  principal: string,
  raw: DeliveryFailedPayload,
  clock: Clock,
): Promise<void> {
  const p = DeliveryFailedPayload.parse(raw);
  const a = await appendNotifierEvent(
    tx,
    notifierStream(principal),
    NOTIFIER_EVENT.failed,
    p,
    `failed:${p.delivery_id}:${p.attempt}`,
    clock,
  );
  if (a && !a.duplicate) await foldFailed(tx, p, a.global_seq);
}

/** Sets a person's preferences (the whole document). */
export async function setPreferences(
  pool: pg.Pool,
  principal: string,
  preferences: NotificationPreferences,
  clock: Clock,
): Promise<PreferencesSetPayload> {
  const p = PreferencesSetPayload.parse({
    principal_id: principal,
    preferences: NotificationPreferences.parse(preferences),
    set_by: principal,
    set_at: clock.now().toISOString(),
  });
  await withTransaction(pool, async (tx) => {
    // each change is a new event (it carries its time): keyed by its own hash
    const a = await appendNotifierEvent(
      tx,
      notifierPrefStream(principal),
      NOTIFIER_EVENT.preferences_set,
      p,
      `prefs:${hashCanonical(p)}`,
      clock,
    );
    if (a && !a.duplicate) await foldPreferences(tx, p, a.global_seq);
  });
  return p;
}

// ---------------------------------------------------------------- reads

export async function preferencesOf(
  db: Pick<pg.Pool, 'query'>,
  principal: string,
): Promise<{ preferences: NotificationPreferences; set_at: string | null }> {
  const r = await db.query<{ preferences: unknown; set_at: Date }>(
    'SELECT preferences, set_at FROM notifier.preference WHERE principal_id = $1',
    [principal],
  );
  const row = r.rows[0];
  if (!row) return { preferences: DEFAULT_NOTIFICATION_PREFERENCES, set_at: null };
  const p = NotificationPreferences.safeParse(row.preferences);
  // a stored document that no longer parses: the defaults (the inbox is unaffected either way)
  return {
    preferences: p.success ? p.data : DEFAULT_NOTIFICATION_PREFERENCES,
    set_at: row.set_at.toISOString(),
  };
}

/** A person's notifications, newest first, with their deliveries. */
export async function listNotifications(
  db: Pick<pg.Pool, 'query'>,
  principal: string,
  limit = 50,
): Promise<NotificationView[]> {
  const n = await db.query<{
    notification_id: string;
    content: unknown;
    reason: NotificationReason;
    raised_at: Date;
  }>(
    `SELECT notification_id, content, reason, raised_at FROM notifier.notification WHERE principal_id = $1
      ORDER BY event_gseq DESC LIMIT $2`,
    [principal, Math.max(1, Math.min(200, limit))],
  );
  if (n.rows.length === 0) return [];
  const d = await db.query<{
    delivery_id: string;
    notification_id: string;
    channel_id: string;
    status: 'pending' | 'delivered' | 'given_up';
    attempts: number;
    last_error: DeliveryErrorCode | null;
    next_attempt_at: Date | null;
    delivered_at: Date | null;
  }>(
    `SELECT delivery_id, notification_id, channel_id, status, attempts, last_error, next_attempt_at, delivered_at
       FROM notifier.delivery WHERE notification_id = ANY($1::uuid[]) ORDER BY channel_id`,
    [n.rows.map((r) => r.notification_id)],
  );
  return n.rows.map((r) => ({
    notification_id: r.notification_id,
    content: NotificationContent.parse(r.content),
    reason: r.reason,
    raised_at: r.raised_at.toISOString(),
    deliveries: d.rows
      .filter((x) => x.notification_id === r.notification_id)
      .map((x) => ({
        delivery_id: x.delivery_id,
        channel_id: x.channel_id,
        status: x.status,
        attempts: x.attempts,
        last_error: x.last_error,
        next_attempt_at: x.next_attempt_at?.toISOString() ?? null,
        delivered_at: x.delivered_at?.toISOString() ?? null,
      })),
  }));
}

/** A pending delivery, locked for the caller's transaction, with what rendering it needs. */
export interface ClaimedDelivery {
  readonly delivery_id: string;
  readonly notification_id: string;
  readonly principal_id: string;
  readonly channel_id: string;
  readonly attempts: number;
  readonly content: NotificationContent;
  readonly data_class: DataClass;
}

/** Locks one due pending delivery (SKIP LOCKED: two notifiers never send the same one at once), or `null`. */
export async function claimDue(tx: Tx, now: Date): Promise<ClaimedDelivery | null> {
  const r = await tx.query<{
    delivery_id: string;
    notification_id: string;
    principal_id: string;
    channel_id: string;
    attempts: number;
  }>(
    `SELECT delivery_id, notification_id, principal_id, channel_id, attempts FROM notifier.delivery
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
      ORDER BY next_attempt_at NULLS FIRST, event_gseq LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [now],
  );
  const d = r.rows[0];
  if (!d) return null;
  const n = await tx.query<{ content: unknown; data_class: DataClass }>(
    'SELECT content, data_class FROM notifier.notification WHERE notification_id = $1',
    [d.notification_id],
  );
  const row = n.rows[0];
  if (!row) throw new Error(`delivery ${d.delivery_id} has no notification`);
  return { ...d, content: NotificationContent.parse(row.content), data_class: row.data_class };
}

// ---------------------------------------------------------------- rebuild

/** Rebuilds the three read models from the record alone (as the schema's owner). Returns the events folded. */
export async function rebuildNotifier(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await tx.query('DELETE FROM notifier.delivery');
    await tx.query('DELETE FROM notifier.notification');
    await tx.query('DELETE FROM notifier.preference');
    const ev = await tx.query<{ type: string; body: unknown; global_seq: string }>(
      `SELECT type, body, global_seq::text FROM record.record_event
        WHERE stream LIKE 'notifier:%' OR stream LIKE 'notifier-pref:%' ORDER BY global_seq`,
    );
    for (const e of ev.rows) {
      const g = Number(e.global_seq);
      if (e.type === NOTIFIER_EVENT.raised)
        await foldRaised(tx, NotificationRaisedPayload.parse(e.body), g);
      else if (e.type === NOTIFIER_EVENT.delivered)
        await foldDelivered(tx, DeliverySucceededPayload.parse(e.body), g);
      else if (e.type === NOTIFIER_EVENT.failed)
        await foldFailed(tx, DeliveryFailedPayload.parse(e.body), g);
      else if (e.type === NOTIFIER_EVENT.preferences_set)
        await foldPreferences(tx, PreferencesSetPayload.parse(e.body), g);
    }
    return ev.rows.length;
  });
}
