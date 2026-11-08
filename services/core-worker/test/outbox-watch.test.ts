import { withTestDatabase } from '@aisdlc/db/testing';
import { withTransaction } from '@aisdlc/db';
import { LoopSupervisor, outboxWatchLoop } from '@aisdlc/loops';
import { ManualScheduler } from '@aisdlc/loops/testing';
import {
  PermanentDeliveryError,
  dispatchOutbox,
  enqueueOutbox,
  listDeadOutbox,
  migrateRecord,
  requeueDeadOutbox,
} from '@aisdlc/record';
import { describe, expect, it } from 'vitest';
import { createCoreWorkerApp } from '../src/index.js';

describe('a dead-lettered outbox message is surfaced as a health alert', () => {
  it('healthz turns 503 with outbox_dead until the dead messages are dealt with', async () => {
    await withTestDatabase(async (t) => {
      await migrateRecord(t.pool);
      const sched = new ManualScheduler();
      const sup = new LoopSupervisor({
        clock: sched.clock,
        sleep: sched.sleep,
        log: () => undefined,
        stopTimeoutMs: 50,
      });
      sched.isBusy = () => sup.busy;
      sup.add(
        outboxWatchLoop({
          pool: t.pool,
          intervalMs: 30_000,
          setAlert: (k, a) => sup.setAlert(k, a),
        }),
      );
      const app = createCoreWorkerApp(sup);
      sup.start();
      await sched.advance(1_000);
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

      await withTransaction(t.pool, (tx) =>
        enqueueOutbox(tx, [
          { destination: 'notify', payload: { n: 1 }, idempotency_key: 'a' },
          { destination: 'notify', payload: { n: 2 }, idempotency_key: 'b' },
        ]),
      );
      await dispatchOutbox(
        t.pool,
        'notify',
        10,
        async (row) => {
          if (row.payload['n'] === 1) throw new PermanentDeliveryError('rejected');
        },
        { clock: sched.clock },
      );
      await sched.advance(31_000);
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ alerts: [{ code: 'outbox_dead', count: 1 }] });
      // The other message was delivered and is not part of the alert.

      const [dead] = await listDeadOutbox(t.pool);
      await withTransaction(t.pool, (tx) => requeueDeadOutbox(tx, [dead?.id ?? 0]));
      await sched.advance(31_000);
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      await sup.stop();
      await app.close();
    });
  });
});
