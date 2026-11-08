import { deadOutboxCount } from '@aisdlc/record';
import type pg from 'pg';
import type { LoopSpec } from './supervisor.js';

// The health alert for dead-lettered outbox messages (PLAN M5.4, follow-up from M2.1). A message
// that exhausted its attempts (or was rejected as permanently undeliverable) is parked in
// `record.outbox` with `dead_at`; nothing retries it. This loop counts them and raises
// `outbox_dead` on the aggregated health, which stays unhealthy until an operator has dealt with
// every dead message (fixed the destination and requeued them, or accepted the loss and cleared
// the row through a migration of their own). It never deletes or requeues anything.

export const OUTBOX_DEAD_ALERT = 'outbox_dead';

export function outboxWatchLoop(o: {
  readonly pool: pg.Pool;
  readonly setAlert: (
    key: string,
    alert: { code: string; message: string; count?: number } | null,
  ) => void;
  readonly intervalMs?: number;
}): LoopSpec {
  return {
    name: 'outbox_watch',
    intervalMs: o.intervalMs ?? 30_000,
    async tick(ctx) {
      const dead = await deadOutboxCount(o.pool);
      const total = dead.reduce((n, d) => n + d.dead, 0);
      if (total === 0) {
        o.setAlert(OUTBOX_DEAD_ALERT, null);
        return;
      }
      const where = dead.map((d) => `${d.destination}=${d.dead}`).join(', ');
      o.setAlert(OUTBOX_DEAD_ALERT, {
        code: OUTBOX_DEAD_ALERT,
        message: `dead-lettered outbox messages (${where}); oldest ${
          dead.map((d) => d.oldest_dead_at.toISOString()).sort()[0]
        }`,
        count: total,
      });
      ctx.log.warn('dead-lettered outbox messages', { total, by_destination: where });
    },
  };
}
