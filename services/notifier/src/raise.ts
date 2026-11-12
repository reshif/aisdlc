import {
  CARD_EVENT,
  CardOpenedPayload,
  GATE_EVENT,
  NOTIFICATION_DELIVERIES_MAX,
  type DataClass,
  type NotificationChannelRow,
  type NotificationRaisedPayload,
  type NotificationReason,
  type PrincipalId,
  type RoleSlot,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { deterministicId, systemClock, type Clock } from '@aisdlc/kernel';
import type pg from 'pg';
import type { RecipientsPort } from './recipients.js';
import {
  SOURCE_TYPES,
  audienceClass,
  audienceSlot,
  intentOf,
  type Audience,
  type SourceEvent,
} from './sources.js';
import { preferencesOf, recordRaised } from './store.js';

// The raise loop (PLAN M18): reads the record after its cursor, in commit order, and raises one notification per
// recipient of each event it knows, in ONE transaction with the cursor move (record first: a notification exists
// before anything is sent, and a crash re-reads the batch without raising anything twice, since a notification's id
// is derived from its source event and recipient). It never writes anything a decision reads.

export interface RaiseDeps {
  readonly pool: pg.Pool;
  readonly recipients: RecipientsPort;
  /** The published channel rows; `null`: unreadable (notifications are raised with no delivery but an explicit choice). */
  readonly channels: () => NotificationChannelRow[] | null;
  readonly clock?: Clock;
  /** Events per transaction (default 200). */
  readonly batch?: number;
  /** An event older than this when read is not notified (default 24 h): a restart after an outage does not flood. */
  readonly maxSourceAgeMs?: number;
}

export interface RaiseReport {
  readonly read: number;
  readonly raised: number;
  readonly cursor: number;
}

type Tx = pg.PoolClient;

async function gateClosed(tx: Tx, gate: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM record.record_event WHERE stream = $1 AND type = ANY($2::text[]) LIMIT 1`,
    [`gate:${gate}`, [GATE_EVENT.closed, GATE_EVENT.superseded, GATE_EVENT.expired]],
  );
  return r.rows.length > 0;
}

async function cardOpenedOf(tx: Tx, stream: string): Promise<CardOpenedPayload | null> {
  const r = await tx.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq LIMIT 1`,
    [stream, CARD_EVENT.opened],
  );
  const p = CardOpenedPayload.safeParse(r.rows[0]?.body);
  return p.success ? p.data : null;
}

async function principalsOf(r: RecipientsPort, a: Audience): Promise<readonly PrincipalId[]> {
  if (a.kind === 'principals') return a.principals;
  if (a.kind === 'slot') return r.slotHolders(a.project, a.slot);
  return r.fleetRoleHolders(a.role);
}

/** The channels a person's notification goes to: their choice (or the default rows), enabled rows only. */
export function chosenChannels(
  rows: NotificationChannelRow[] | null,
  choice: readonly string[] | null,
): string[] {
  if (rows === null) return [];
  const enabled = rows.filter((r) => r.enabled);
  const ids =
    choice === null
      ? enabled.filter((r) => r.default_on).map((r) => r.channel_id)
      : enabled.filter((r) => choice.includes(r.channel_id)).map((r) => r.channel_id);
  return [...new Set(ids)].sort().slice(0, NOTIFICATION_DELIVERIES_MAX);
}

/** What one source event raises: read only (identity, preferences, the record), nothing appended yet. */
async function draftsFor(
  d: RaiseDeps,
  tx: Tx,
  e: SourceEvent,
  now: Date,
): Promise<NotificationRaisedPayload[]> {
  const maxAge = d.maxSourceAgeMs ?? 24 * 3600_000;
  if (now.getTime() - Date.parse(e.occurred_at) > maxAge) return [];
  const intent = intentOf(e, {
    cardOpened: e.type === CARD_EVENT.escalated ? await cardOpenedOf(tx, e.stream) : null,
  });
  if (intent === null) return [];
  if (intent.gate_instance_id !== null && (await gateClosed(tx, intent.gate_instance_id)))
    return [];
  // the first audience that reaches a person says why they got it (an escalation's backup before the slot)
  const who = new Map<
    string,
    { reason: NotificationReason; slot: RoleSlot | null; data_class: DataClass }
  >();
  for (const a of intent.audiences) {
    for (const p of await principalsOf(d.recipients, a)) {
      if (!who.has(p))
        who.set(p, { reason: a.reason, slot: audienceSlot(a), data_class: audienceClass(a) });
    }
  }
  const rows = d.channels();
  const out: NotificationRaisedPayload[] = [];
  for (const [principal, why] of [...who].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!(await d.recipients.isActiveHuman(principal))) continue;
    const { preferences } = await preferencesOf(tx, principal);
    if (preferences.muted_kinds.includes(intent.content.kind)) continue;
    const notification_id = deterministicId(`notifier:${e.event_id}:${principal}`);
    out.push({
      notification_id,
      principal_id: principal as PrincipalId,
      content: intent.content,
      reason: why.reason,
      slot: why.slot,
      data_class: why.data_class,
      source: {
        stream: e.stream,
        stream_seq: e.stream_seq,
        global_seq: e.global_seq,
        type: e.type,
      },
      deliveries: chosenChannels(rows, preferences.channels).map((channel_id) => ({
        delivery_id: deterministicId(`${notification_id}:${channel_id}`),
        channel_id,
      })),
      raised_at: now.toISOString(),
    });
  }
  return out;
}

/** One pass: the next batch of source events after the cursor. The first pass ever only places the cursor at the head. */
export async function raiseOnce(d: RaiseDeps): Promise<RaiseReport> {
  const clock = d.clock ?? systemClock;
  return withTransaction(d.pool, async (tx) => {
    const now = clock.now();
    const cur = await tx.query<{ last: string }>(
      'SELECT last_global_seq::text AS last FROM notifier.source_cursor WHERE id FOR UPDATE',
    );
    if (cur.rows.length === 0) {
      const head = await tx.query<{ last: string }>(
        'SELECT last_seq::text AS last FROM record.global_counter',
      );
      const at = Number(head.rows[0]?.last ?? 0);
      await tx.query(
        `INSERT INTO notifier.source_cursor (id, last_global_seq, started_at, updated_at) VALUES (true, $1, $2, $2)
         ON CONFLICT (id) DO NOTHING`,
        [at, now],
      );
      return { read: 0, raised: 0, cursor: at };
    }
    const after = Number(cur.rows[0]?.last ?? 0);
    const ev = await tx.query<{
      event_id: string;
      stream: string;
      seq: number;
      global_seq: string;
      type: string;
      body: unknown;
      occurred_at: Date;
    }>(
      `SELECT event_id, stream, seq::int AS seq, global_seq::text AS global_seq, type, body, occurred_at
         FROM record.record_event WHERE record_event.global_seq > $1 AND type = ANY($2::text[])
        ORDER BY record_event.global_seq LIMIT $3`,
      [after, [...SOURCE_TYPES], d.batch ?? 200],
    );
    // every read first, then every append: the record's counter lock (taken by the first append, held to commit) is
    // never held while identity or the preferences are read
    const drafts: NotificationRaisedPayload[] = [];
    let last = after;
    for (const r of ev.rows) {
      drafts.push(
        ...(await draftsFor(
          d,
          tx,
          {
            event_id: r.event_id,
            stream: r.stream,
            stream_seq: r.seq,
            global_seq: Number(r.global_seq),
            type: r.type,
            body: r.body,
            occurred_at: r.occurred_at.toISOString(),
          },
          now,
        )),
      );
      last = Number(r.global_seq);
    }
    let raised = 0;
    for (const p of drafts) if (await recordRaised(tx, p, clock)) raised += 1;
    if (last !== after) {
      await tx.query(
        'UPDATE notifier.source_cursor SET last_global_seq = $1, updated_at = $2 WHERE id',
        [last, now],
      );
    }
    return { read: ev.rows.length, raised, cursor: last };
  });
}
