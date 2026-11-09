import { z } from 'zod';
import { Lane } from '../values.js';
import { BreakerSource } from './work-lifecycle.js';
import {
  GateInstanceId,
  IsoDateTime,
  LedgerEntryId,
  ProjectId,
  Sha256Hex,
  WorkItemId,
} from './ids.js';

// The R3 circuit breaker ET14, per project x lane (PLAN M9.5; FL FIX 3). What counts toward it is
// recorded as `breaker.counted` events on the stream of the project and lane; when the count since the
// last reset reaches the catalogue's `trip` threshold the breaker TRIPS (`breaker.tripped`) and new items
// for that project and lane route to L8. A human reset goes through an M5 gate (autonomy promotion)
// and is recorded as `breaker.reset` only after the decision is read from the ledger. The breaker's
// state is a projection of these events, never a counter somebody can edit.

export const BREAKER_EVENT = {
  counted: 'breaker.counted',
  tripped: 'breaker.tripped',
  reset_requested: 'breaker.reset_requested',
  reset: 'breaker.reset',
} as const;
export type BreakerEventType = (typeof BREAKER_EVENT)[keyof typeof BREAKER_EVENT];

/** The record stream of one project and lane. */
export const breakerStream = (project: string, lane: string): string =>
  `breaker:${project}:${lane}`;

const Key = { project_id: ProjectId, lane: Lane };

export const BreakerPayloads = {
  [BREAKER_EVENT.counted]: z.strictObject({
    ...Key,
    source: BreakerSource,
    item_id: WorkItemId.nullable(),
    /** The command (or fact) key the count came from: one count per key. */
    signal_key: z.string().min(1),
  }),
  [BREAKER_EVENT.tripped]: z.strictObject({
    ...Key,
    count: z.number().int().min(1),
    threshold: z.number().int().min(1),
  }),
  [BREAKER_EVENT.reset_requested]: z.strictObject({
    ...Key,
    gate_instance_id: GateInstanceId,
    subject_hash: Sha256Hex,
    count: z.number().int().min(0),
    requested_by: z.string().min(1),
  }),
  [BREAKER_EVENT.reset]: z.strictObject({
    ...Key,
    gate_instance_id: GateInstanceId,
    ledger_entry_id: LedgerEntryId.nullable(),
    count_cleared: z.number().int().min(0),
  }),
} as const;

/** The breaker of one project and lane as a reader sees it. */
export const BreakerState = z.strictObject({
  project_id: ProjectId,
  lane: Lane,
  /** Counts since the last reset, by source. */
  counts: z.partialRecord(BreakerSource, z.number().int().min(0)),
  total: z.number().int().min(0),
  /** The catalogue's `trip` threshold when the state was read; `null`: the catalogue gives none. */
  threshold: z.number().int().min(1).nullable(),
  tripped: z.boolean(),
  tripped_at: IsoDateTime.nullable(),
  /** An M5 reset gate that is open. */
  pending_reset: GateInstanceId.nullable(),
  resets: z.number().int().min(0),
});
export type BreakerState = z.infer<typeof BreakerState>;
