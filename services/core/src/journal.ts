import {
  prrStream,
  projectStream,
  repoStream,
  s0Stream,
  type RecordEvent,
} from '@aisdlc/contracts';
import {
  confirmAll,
  inTransaction,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { EVENT_COLUMNS, appendEvents, toRecordEvent, type EventRow, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { foldPrr, foldProject, foldRepo, foldS0 } from './fold.js';

/**
 * What a writer needs: the record database and a clock. Core's S0 writes touch the ledger in one
 * place only, the bootstrap grant at the intake (PLAN M7.4), which needs `ledger`; without it no
 * grant is made (fail closed).
 */
export interface CoreDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly ledger?: LedgerClientDeps;
}

export const clockOf = (d: { readonly clock?: Clock }): Clock => d.clock ?? systemClock;

/** Serialises writers of the named keys until the transaction ends. Sorted, so two writers never deadlock. */
export async function lockKeys(tx: Tx, keys: readonly string[]): Promise<void> {
  for (const k of [...new Set(keys)].sort()) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`aisdlc.core:${k}`]);
  }
}

/** One transaction's view of the streams: each is read once, and appended events are visible. */
export class Journal {
  private readonly cache = new Map<string, RecordEvent[]>();
  /** How many events this transaction appended. */
  appended = 0;

  constructor(
    readonly tx: Tx,
    readonly clock: Clock,
  ) {}

  async events(stream: string): Promise<RecordEvent[]> {
    const hit = this.cache.get(stream);
    if (hit) return hit;
    const q = await this.tx.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
      [stream],
    );
    const events = q.rows.map(toRecordEvent);
    this.cache.set(stream, events);
    return events;
  }

  /** Appends one event at the stream's head. Callers hold the aggregate's key (`lockKeys`). */
  async emit(
    stream: string,
    type: string,
    payload: object,
    actor: string,
    o: { event_id?: string } = {},
  ): Promise<Result<RecordEvent, CoreError>> {
    const events = await this.events(stream);
    const head = events.at(-1)?.stream_seq ?? 0;
    const r = await appendEvents(
      this.tx,
      stream,
      head,
      [
        {
          type,
          body: payload as Record<string, unknown>,
          actor,
          ...(o.event_id ? { event_id: o.event_id } : {}),
        },
      ],
      { clock: this.clock },
    );
    if (!r.ok) return err(coreError('conflict', JSON.stringify(r.error)));
    const written = r.value.events[0] as RecordEvent;
    events.push(written);
    this.appended += 1;
    return ok(written);
  }

  async project(id: string) {
    return foldProject(await this.events(projectStream(id)));
  }
  async repo(ref: string) {
    return foldRepo(await this.events(repoStream(ref)));
  }
  async s0(id: string) {
    return foldS0(await this.events(s0Stream(id)));
  }
  async prr(project: string, repoId: string) {
    return foldPrr(await this.events(prrStream(project, repoId)));
  }
}

/** Runs `fn` in one transaction with a `Journal`. An `Err` or a throw rolls everything back. */
export function inCoreTx<T>(
  deps: CoreDeps,
  fn: (j: Journal, tx: pg.PoolClient) => Promise<Result<T, CoreError>>,
): Promise<Result<T, CoreError>> {
  return inTransaction(
    deps.pool,
    (tx) => fn(new Journal(tx, clockOf(deps)), tx),
    (e) => coreError('database', e instanceof Error ? e.message : String(e)),
  );
}

/**
 * `inCoreTx` for a transaction that also writes a ledger entry: `fn` takes the ledger lock before its
 * first record append and writes the entry last (AGENTS.md lock order), returning what the Notary
 * signed; after COMMIT those entries are confirmed.
 */
export async function inCoreLedgerTx<T>(
  deps: CoreDeps & { readonly ledger: LedgerClientDeps },
  fn: (
    j: Journal,
    tx: pg.PoolClient,
  ) => Promise<Result<{ value: T; pending: readonly PendingConfirm[] }, CoreError>>,
): Promise<Result<T, CoreError>> {
  const done = await inTransaction(
    deps.pool,
    (tx) => fn(new Journal(tx, clockOf(deps)), tx),
    (e) => coreError('database', e instanceof Error ? e.message : String(e)),
  );
  if (!done.ok) return done;
  // A failed confirm is finished by the Notary reconciler (M2.3): the entry is signed and in the record.
  await confirmAll(deps.ledger.notary, done.value.pending);
  return ok(done.value.value);
}

/** Reads the streams outside a transaction (a driver deciding what to do next). */
export async function readS0(pool: pg.Pool, s0Id: string) {
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [s0Stream(s0Id)],
  );
  return foldS0(q.rows.map(toRecordEvent));
}
