import {
  BudgetExhaustedPayload,
  GATEWAY_EVENT,
  ITEM_EVENT,
  WorkItemId,
  type StepId,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { clockOf, type CoreDeps } from './journal.js';
import { ingestItem, readItem } from './work-items.js';

// ET1 from the model gateway (PLAN M10.3). When a per-Unit budget group is spent the gateway appends
// `gateway.budget_exhausted` to the record. This module is the work engine's side of it: it reads those
// events, and for an event that names an item it records `item.trigger_fired` (ET1) on the item's
// stream. The interpreter does the rest from its own tables: ET1's effect at S6 is the D1 handoff
// (E4 to the owner of record), and at any other step the trigger is not a handoff and is ignored
// (a Unit whose session already ended has nothing to hand off). The gateway never touches the item.
//
// Inbox first and exactly once: the trigger carries the idempotency key `gateway.et1:<budget group>`,
// so a replayed event (a lost cursor, a second worker) is one trigger.

export const GATEWAY_OBSERVER = 'gateway_triggers';
/** The step ET1 is attributed to when the key that ran out was not minted for one: the coding step. */
export const ET1_DEFAULT_STEP: StepId = '6.4';

export async function gatewayCursor(db: pg.Pool | pg.PoolClient): Promise<number> {
  const q = await db.query<{ global_seq: string }>(
    'SELECT global_seq::text FROM core.observer_cursor WHERE name = $1',
    [GATEWAY_OBSERVER],
  );
  return Number(q.rows[0]?.global_seq ?? 0);
}

export interface GatewayTriggerReport {
  /** ET1 events read. */
  readonly seen: number;
  /** Of those, triggers recorded on an item for the first time. */
  readonly fired: number;
  /** ET1 events that name no item of ours (a key minted for no item, an unknown item): nothing to hand off. */
  readonly skipped: number;
}

/** Reads the gateway's ET1 events after the cursor and fires each one's item trigger. */
export async function observeGatewayTriggers(
  deps: CoreDeps,
  opts: { batch?: number } = {},
): Promise<Result<GatewayTriggerReport, CoreError>> {
  const after = await gatewayCursor(deps.pool);
  const q = await deps.pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE type = $1 AND global_seq > $2::bigint
      ORDER BY record_event.global_seq LIMIT $3`,
    [GATEWAY_EVENT.budget_exhausted, String(after), opts.batch ?? 100],
  );
  let fired = 0;
  let skipped = 0;
  for (const row of q.rows) {
    const e = toRecordEvent(row);
    const p = BudgetExhaustedPayload.safeParse(e.payload);
    // An event of this type that does not parse is not ours to act on, and is not skipped silently
    // past: it stops the run, so it is looked at.
    if (!p.success) {
      return err(
        coreError('invalid_input', `gateway.budget_exhausted #${e.global_seq} is malformed`),
      );
    }
    const item = WorkItemId.safeParse(p.data.item_id);
    const state = item.success ? await readItem(deps.pool, item.data) : null;
    if (!state) {
      skipped += 1;
    } else {
      const r = await ingestItem(deps, state.state.item_id, {
        type: ITEM_EVENT.trigger_fired,
        payload: {
          trigger: 'ET1',
          step: p.data.step ?? ET1_DEFAULT_STEP,
          reason_code: `gateway.budget_${p.data.limit}`,
        },
        actor: 'system.gateway',
        idempotency_key: `gateway.et1:${p.data.budget_group}`,
      });
      if (!r.ok) return r;
      if (!r.value.duplicate) fired += 1;
    }
    await deps.pool.query(
      `INSERT INTO core.observer_cursor (name, global_seq, updated_at) VALUES ($1, $2::bigint, $3)
       ON CONFLICT (name) DO UPDATE SET global_seq = greatest(core.observer_cursor.global_seq, excluded.global_seq),
                                        updated_at = excluded.updated_at`,
      [GATEWAY_OBSERVER, String(e.global_seq), clockOf(deps).now().toISOString()],
    );
  }
  return ok({ seen: q.rows.length, fired, skipped });
}

export interface GatewayTriggersLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
  readonly batch?: number;
}

/** `gateway_triggers`: ET1 from the gateway, as item triggers. */
export function gatewayTriggersLoop(deps: CoreDeps, o: GatewayTriggersLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? 2_000;
  return {
    name: GATEWAY_OBSERVER,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      let ok = 0;
      for (let i = 0; i < 20; i++) {
        const r = await observeGatewayTriggers(
          deps,
          o.batch === undefined ? {} : { batch: o.batch },
        );
        if (!r.ok) throw new Error(r.error.message);
        ok += r.value.fired;
        if (r.value.seen < (o.batch ?? 100)) break;
      }
      return { ok, failed: 0 };
    },
  };
}
