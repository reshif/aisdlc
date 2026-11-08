import type { Executor } from './types.js';
import type { Projection } from './projection.js';

/** `item:0190…` has stream type `item`; a stream without ':' is its own type. */
export function streamType(stream: string): string {
  const i = stream.indexOf(':');
  return i === -1 ? stream : stream.slice(0, i);
}

/**
 * Sample projection: how many events each stream type has. It exists to exercise the harness and
 * as the template for later projections (own tables, deterministic apply, snapshot).
 */
export const streamTypeCounts: Projection<Record<string, number>> = {
  name: 'stream_type_counts',
  version: 1,
  tables: ['record.stream_type_counts'],
  async apply(tx, event) {
    await tx.query(
      `INSERT INTO record.stream_type_counts (stream_type, event_count) VALUES ($1, 1)
       ON CONFLICT (stream_type) DO UPDATE SET event_count = record.stream_type_counts.event_count + 1`,
      [streamType(event.stream_id)],
    );
  },
  async reset(tx) {
    await tx.query('DELETE FROM record.stream_type_counts');
  },
  async snapshot(db: Executor) {
    const r = await db.query<{ stream_type: string; event_count: string }>(
      'SELECT stream_type, event_count::text AS event_count FROM record.stream_type_counts ORDER BY stream_type',
    );
    return Object.fromEntries(r.rows.map((row) => [row.stream_type, Number(row.event_count)]));
  },
};
