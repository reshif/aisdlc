import type { Checkpoint, CheckpointCore } from '@aisdlc/contracts';
import {
  err,
  merkleRoot,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import type { NotaryPort, WitnessPort } from '@aisdlc/ports';
import { hexBytes } from '@aisdlc/ports';
import type pg from 'pg';
import { insertCheckpoint, lockCheckpointing, readLastCheckpoint, readLedgerHead } from './rows.js';
import { inTransaction } from './tx.js';

/** The Merkle root is recomputed here from the record, so a record that was changed is noticed. */
export type CheckpointErrorCode =
  | 'notary'
  | 'witness'
  /** The record's entries and the Notary's journal give different roots: one of them was altered. */
  | 'diverged'
  | 'database';

export const CheckpointError = taggedError('CheckpointError');
export type CheckpointError = TaggedError<
  'CheckpointError',
  { code: CheckpointErrorCode; message: string }
>;
const fail = (code: CheckpointErrorCode, message: string): CheckpointError =>
  CheckpointError({ code, message });

export interface CheckpointDeps {
  notary: NotaryPort;
  witness: WitnessPort;
  clock?: Clock;
}

export type CheckpointRun =
  /** Nothing new to cover. `adopted` is a checkpoint the Witness had co-signed that we had not stored. */
  | { kind: 'noop'; adopted: Checkpoint | null }
  | { kind: 'created'; checkpoint: Checkpoint; adopted: Checkpoint | null };

/**
 * One checkpoint round (PLAN M2.4), run by the checkpointer loop. It holds no key. Under a
 * checkpoint lock in the record database:
 *   1. If the Witness co-signed a checkpoint we never stored (a crash after its answer), store it.
 *   2. If the ledger head is beyond the last checkpoint:
 *      the Notary signs a tree head over entries 1..head (recomputing the root from its own
 *      journal), we check that root against the record, the Witness is shown the entries since
 *      the last co-signed size and co-signs, and the result is stored.
 * Checkpoints cover entries 1..to, so `from_ledger_seq` is always 1.
 */
export async function runCheckpoint(
  pool: pg.Pool,
  deps: CheckpointDeps,
): Promise<Result<CheckpointRun, CheckpointError>> {
  const clock = deps.clock ?? systemClock;
  return inTransaction(
    pool,
    async (tx): Promise<Result<CheckpointRun, CheckpointError>> => {
      await lockCheckpointing(tx);
      let last = await readLastCheckpoint(tx);

      let adopted: Checkpoint | null = null;
      const theirs = await deps.witness.last();
      if (!theirs.ok) return err(fail('witness', theirs.error.message));
      if (theirs.value && theirs.value.cp_seq > (last?.cp_seq ?? 0)) {
        if (theirs.value.cp_seq !== (last?.cp_seq ?? 0) + 1) {
          return err(
            fail('witness', 'the Witness is more than one checkpoint ahead of the record'),
          );
        }
        await insertCheckpoint(tx, theirs.value);
        adopted = last = theirs.value;
      }

      const head = await readLedgerHead(tx);
      const lastTo = last?.to_ledger_seq ?? 0;
      if (!head || head.ledger_seq <= lastTo) return ok({ kind: 'noop', adopted });

      const cp_seq = (last?.cp_seq ?? 0) + 1;
      const created_at = clock.now().toISOString();
      const signed = await deps.notary.signCheckpoint({
        cp_seq,
        from_ledger_seq: 1,
        to_ledger_seq: head.ledger_seq,
        created_at,
      });
      if (!signed.ok) return err(fail('notary', signed.error.message));

      const rows = await tx.query<{
        ledger_seq: string;
        prev_hash: string | null;
        entry_hash: string;
      }>(
        'SELECT ledger_seq, prev_hash, entry_hash FROM ledger.ledger_entry WHERE ledger_seq <= $1 ORDER BY ledger_seq',
        [head.ledger_seq],
      );
      const root = merkleRoot(rows.rows.map((r) => hexBytes(r.entry_hash)));
      if (rows.rows.length !== head.ledger_seq || root !== signed.value.root_hash) {
        return err(
          fail('diverged', 'the record and the Notary journal give different Merkle roots'),
        );
      }
      if (signed.value.head_hash !== head.entry_hash) {
        return err(fail('diverged', 'the Notary head hash is not the record head'));
      }

      const core: CheckpointCore = {
        cp_seq,
        from_ledger_seq: 1,
        to_ledger_seq: head.ledger_seq,
        root_hash: root,
        head_hash: head.entry_hash,
        created_at,
      };
      const cosigned = await deps.witness.cosign({
        core,
        notary: signed.value.signature,
        entries: rows.rows
          .filter((r) => Number(r.ledger_seq) > lastTo)
          .map((r) => ({
            ledger_seq: Number(r.ledger_seq),
            prev_hash: r.prev_hash,
            entry_hash: r.entry_hash,
          })),
      });
      if (!cosigned.ok)
        return err(fail('witness', `${cosigned.error.code}: ${cosigned.error.message}`));
      await insertCheckpoint(tx, cosigned.value);
      return ok({ kind: 'created', checkpoint: cosigned.value, adopted });
    },
    (e) => fail('database', e instanceof Error ? e.message : String(e)),
  );
}

export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export type TickResult =
  | { ran: false; next_due_ms: number }
  | { ran: true; result: Result<CheckpointRun, CheckpointError> };

/**
 * The checkpoint loop (every 5 minutes). Time comes from the injected `Clock`, so a test drives
 * it with a manual clock and calls `tick()`; production calls `start()` which polls `tick()` on
 * a real timer. The first tick runs at once, later ticks when `intervalMs` has passed since the
 * last run began. A failed run is retried at the next interval, not in a tight loop.
 */
export class CheckpointLoop {
  private nextDue = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly clock: Clock;
  private readonly intervalMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: CheckpointDeps,
    opts: { intervalMs?: number } = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.intervalMs = opts.intervalMs ?? CHECKPOINT_INTERVAL_MS;
  }

  async tick(): Promise<TickResult> {
    const now = this.clock.nowMs();
    if (now < this.nextDue) return { ran: false, next_due_ms: this.nextDue };
    this.nextDue = now + this.intervalMs;
    return {
      ran: true,
      result: await runCheckpoint(this.pool, { ...this.deps, clock: this.clock }),
    };
  }

  /** Polls `tick()` every `pollMs` of real time until `stop()`. Results go to `onResult`. */
  start(onResult: (r: TickResult) => void = () => undefined, pollMs = 1_000): void {
    if (this.loop) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          onResult(await this.tick());
        } catch {
          // runCheckpoint returns errors as values; anything thrown is retried at the next poll
        }
        if (!this.running) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, pollMs);
        });
      }
    })();
  }

  /** Stops polling and waits for a run in progress. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }
}
