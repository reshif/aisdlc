import { ITEM_STREAM_PREFIX, repoKeyOf, type RecordEvent } from '@aisdlc/contracts';
import {
  EVENT_COLUMNS,
  runProjection,
  toRecordEvent,
  type EventRow,
  type Executor,
  type Projection,
  type Tx,
} from '@aisdlc/record';
import {
  CataloguePinUnavailable,
  pinnedCatalogueResolver,
  foldItem,
  sessionOpen,
  workInFlight,
} from '@aisdlc/work';
import type pg from 'pg';
import { ItemCreatedPayload } from '@aisdlc/contracts';

// The `work_item` read model (PLAN M9.2): one row per item, a fold of its `item:` stream through the
// interpreter. A function of the record alone, so dropping the table and refolding gives the same
// rows (the rebuild drill does exactly that). Never read on a write path.

async function streamUpTo(tx: Tx, stream: string, seq: number): Promise<RecordEvent[]> {
  const q = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE stream = $1 AND seq <= $2 ORDER BY record_event.seq`,
    [stream, seq],
  );
  return q.rows.map(toRecordEvent);
}

export interface WorkItemSnapshot {
  items: unknown[];
}

export const workItemProjection: Projection<WorkItemSnapshot> = {
  name: 'work_item',
  version: 1,
  tables: ['core.work_item'],

  async apply(tx: Tx, e: RecordEvent) {
    if (!e.stream_id.startsWith(ITEM_STREAM_PREFIX)) return;
    const events = await streamUpTo(tx, e.stream_id, e.stream_seq);
    const first = events[0];
    if (!first) return;
    const created = ItemCreatedPayload.parse(first.payload);
    let row: Record<string, unknown>;
    try {
      const f = foldItem(events, pinnedCatalogueResolver);
      if (!f) return;
      const s = f.state;
      row = {
        item_id: s.item_id,
        project_id: s.project_id,
        repo_key: repoKeyOf(s.repo),
        request_id: s.request_id,
        lane: s.lane,
        proposed_lane: s.proposed_lane,
        phase: s.phase,
        underlying: s.underlying,
        terminal: s.terminal,
        holds: s.holds.length,
        outstanding: s.outstanding.length,
        text_sha256: s.intake.text_sha256,
        tier: s.tier,
        lease_open: s.lease !== null,
        session_open: sessionOpen(s),
        in_flight: workInFlight(s),
        pin_unavailable: false,
        seq: s.seq,
      };
    } catch (err) {
      if (!(err instanceof CataloguePinUnavailable)) throw err;
      // The pinned catalogue is not carried by this build: the item cannot be interpreted. Fail
      // closed: it counts as agent work in flight (polling more is the safe side).
      row = {
        item_id: created.item_id,
        project_id: created.project_id,
        repo_key: repoKeyOf(created.repo),
        request_id: created.request_id,
        lane: null,
        proposed_lane: created.proposed_lane,
        phase: 'Held',
        underlying: 'Held',
        terminal: null,
        holds: 0,
        outstanding: 0,
        text_sha256: created.intake.text_sha256,
        tier: created.tier,
        lease_open: false,
        session_open: false,
        in_flight: true,
        pin_unavailable: true,
        seq: e.stream_seq,
      };
    }
    await tx.query(
      `INSERT INTO core.work_item
         (item_id, project_id, repo_key, request_id, lane, proposed_lane, phase, underlying, terminal,
          holds, outstanding, text_sha256, tier, lease_open, session_open, in_flight, pin_unavailable,
          catalogue_version, catalogue_hash, seq, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (item_id) DO UPDATE SET
         lane = EXCLUDED.lane, proposed_lane = EXCLUDED.proposed_lane, phase = EXCLUDED.phase,
         underlying = EXCLUDED.underlying, terminal = EXCLUDED.terminal, holds = EXCLUDED.holds,
         outstanding = EXCLUDED.outstanding, lease_open = EXCLUDED.lease_open,
         session_open = EXCLUDED.session_open, in_flight = EXCLUDED.in_flight,
         pin_unavailable = EXCLUDED.pin_unavailable, seq = EXCLUDED.seq,
         updated_at = EXCLUDED.updated_at`,
      [
        row['item_id'],
        row['project_id'],
        row['repo_key'],
        row['request_id'],
        row['lane'],
        row['proposed_lane'],
        row['phase'],
        row['underlying'],
        row['terminal'],
        row['holds'],
        row['outstanding'],
        row['text_sha256'],
        row['tier'],
        row['lease_open'],
        row['session_open'],
        row['in_flight'],
        row['pin_unavailable'],
        created.catalogue_ref.version,
        created.catalogue_ref.hash,
        row['seq'],
        first.occurred_at,
        e.occurred_at,
      ],
    );
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.work_item');
  },

  async snapshot(db: Executor) {
    const q = await db.query(
      `SELECT item_id, project_id, repo_key, request_id, lane, proposed_lane, phase, underlying, terminal,
              holds, outstanding, text_sha256, tier, lease_open, session_open, in_flight,
              pin_unavailable, catalogue_version, catalogue_hash, seq, created_at, updated_at
         FROM core.work_item ORDER BY item_id`,
    );
    return { items: q.rows };
  },
};

/** Catches the work_item read model up with the record. */
export async function catchUpWork(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, workItemProjection);
  if (!r.ok) throw new Error('the work_item read model needs a rebuild');
}
