import {
  reconcileLedger,
  runCheckpoint,
  type CheckpointDeps,
  type LedgerClientDeps,
} from '@aisdlc/ledger';
import type { LoopSpec } from '@aisdlc/loops';
import type pg from 'pg';

/**
 * The ledger reconciler (PLAN M2.3, wired at M8.0b): inserts and confirms the entries the Notary
 * signed that the record never saw. A failure throws, so the supervisor backs off and the loop
 * shows unhealthy until a round passes.
 */
export function reconcilerLoop(o: {
  readonly pool: pg.Pool;
  readonly deps: LedgerClientDeps;
  readonly intervalMs: number;
  readonly startDelayMs?: number;
}): LoopSpec {
  return {
    name: 'ledger_reconciler',
    intervalMs: o.intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    async tick(ctx) {
      const r = await reconcileLedger(o.pool, o.deps);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      if (r.value.inserted > 0 || r.value.confirmed > 0) {
        ctx.log.info('reconciled', { inserted: r.value.inserted, confirmed: r.value.confirmed });
      }
    },
  };
}

/**
 * The checkpointer (PLAN M2.4, wired at M8.0b): one round every interval. A round with nothing new
 * is quiet; a created checkpoint is logged with its sequence and the ledger range it covers.
 */
export function checkpointerLoop(o: {
  readonly pool: pg.Pool;
  readonly deps: CheckpointDeps;
  readonly intervalMs: number;
  readonly startDelayMs?: number;
}): LoopSpec {
  return {
    name: 'checkpointer',
    intervalMs: o.intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    async tick(ctx) {
      const r = await runCheckpoint(o.pool, o.deps);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      if (r.value.adopted)
        ctx.log.info('adopted a checkpoint the Witness had co-signed', {
          cp_seq: r.value.adopted.cp_seq,
        });
      if (r.value.kind === 'created') {
        ctx.log.info('checkpoint co-signed', {
          cp_seq: r.value.checkpoint.cp_seq,
          to_ledger_seq: r.value.checkpoint.to_ledger_seq,
        });
      }
    },
  };
}
