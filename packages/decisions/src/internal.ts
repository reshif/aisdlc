import {
  DEFAULT_GATES_TIMERS,
  gateStream,
  type GateId,
  type LedgerDecision,
  type LedgerEntry,
  type LedgerEntryDraft,
  type LedgerEntryId,
  type RoleSlot,
  type SubjectKind,
} from '@aisdlc/contracts';
import { err, newId, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  confirmAll,
  importUnconfirmed,
  inTransaction,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { appendEvents, type NewEvent, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { decisionError, type DecisionError } from './errors.js';
import type { BusinessCalendar } from './inbox/calendar.js';
import type { EligibilityPort, FactoryAdminPort, StepUpPort } from './ports.js';

export const DEFAULT_POLICY_BUNDLE_VERSION = 'decisions-1.0.0';
/** `facts.expires_at` default: seven days after opening (portal v2: `gates.timers.expires_after_s`). */
export const DEFAULT_GATE_TTL_MS = DEFAULT_GATES_TIMERS.expires_after_s * 1000;
/** A PreparedDecision nonce lives ten minutes (PLAN M3.3; portal v2: `gates.timers.nonce_ttl_s`). */
export const DEFAULT_NONCE_TTL_MS = DEFAULT_GATES_TIMERS.nonce_ttl_s * 1000;

/** A TTL setting in force: the number, or the function's answer now (a bad answer is the default). */
export function ttlMs(v: number | (() => number) | undefined, fallback: number): number {
  const n = typeof v === 'function' ? v() : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface DecisionDeps {
  /** The record database (record, ledger and decisions schemas). */
  readonly pool: pg.Pool;
  /** The Notary client and key used to write the ledger. */
  readonly ledger: LedgerClientDeps;
  readonly eligibility: EligibilityPort;
  readonly stepUp: StepUpPort;
  /**
   * Who is a factory admin, for the override (owner decision 2026-11-13, docs/specs/deletion.md §8). Absent: every
   * override is refused (fail closed).
   */
  readonly admins?: FactoryAdminPort;
  readonly clock?: Clock;
  readonly policyBundleVersion?: string;
  /** A gate's expiry when its facts name none; a function is read on every open (portal v2 `gates.timers`). */
  readonly gateTtlMs?: number | (() => number);
  /** A prepared decision's life; a function is read on every prepare (portal v2 `gates.timers`). */
  readonly nonceTtlMs?: number | (() => number);
  /** Business days for the B21 SLA (inbox). Default `DEFAULT_CALENDAR`: weekends off, no holidays. */
  readonly calendar?: BusinessCalendar;
  /** B21: business days a gate may stay pending before it escalates. Default 1. */
  readonly slaBusinessDays?: number;
  /** B21: the slot whose holders get the escalation entry. Default `admin`. */
  readonly backupSlot?: RoleSlot;
  /**
   * Maintenance mode MM-2 (FL `MM`): true while the ops flag is on. Decisions are refused (`maintenance`)
   * and the timers of this kernel (gate expiry, the B21 SLA sweep) do nothing: they are frozen, and
   * what was pending stays pending. Drafts (opened gates, prepared decisions, evidence views) are kept.
   * A probe that fails counts as maintenance on: unknown means unmet.
   */
  readonly maintenance?: () => boolean | Promise<boolean>;
}

/** MM-2 is on (or its flag could not be read). */
export async function inMaintenance(deps: Pick<DecisionDeps, 'maintenance'>): Promise<boolean> {
  if (!deps.maintenance) return false;
  try {
    return (await deps.maintenance()) !== false;
  } catch {
    return true;
  }
}

export const clockOf = (d: DecisionDeps): Clock => d.clock ?? systemClock;

/** What a decision transaction hands back: the value, and the Notary entries to confirm after COMMIT. */
export interface TxOutcome<T> {
  readonly value: T;
  readonly pending: readonly PendingConfirm[];
}

export type Written<T> = T & {
  /** False when COMMIT succeeded but the final Notary confirm failed; the reconciler finishes it. */
  confirmed: boolean;
};

/**
 * Runs `fn` in one transaction on the record database, COMMITs, and then confirms the entries the
 * Notary signed. An `Err` or a throw rolls everything back; a Notary-signed entry from a rolled-back
 * transaction is picked up by the reconciler (M2.3), never lost, never signed twice.
 */
export async function inDecisionTx<T>(
  deps: DecisionDeps,
  fn: (tx: pg.PoolClient) => Promise<Result<TxOutcome<T>, DecisionError>>,
): Promise<Result<Written<T>, DecisionError>> {
  const done = await inTransaction(deps.pool, fn, (e) =>
    decisionError('database', e instanceof Error ? e.message : String(e)),
  );
  if (!done.ok) return done;
  const confirmed = await confirmAll(deps.ledger.notary, done.value.pending);
  return ok({ ...(done.value.value as object), confirmed: confirmed.ok } as Written<T>);
}

/** Serialises writers of one gate subject or instance. Held to the end of the transaction. */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`aisdlc.decisions:${key}`]);
}

/**
 * LOCK ORDER of every decision transaction: gate key, then the ledger lock (and an import of
 * anything the Notary signed that the record does not have yet), then record appends, and the
 * ledger entry last. Anything else that appends to the record and the ledger in one transaction
 * must take the ledger lock before its first record append, or it can deadlock with these.
 * Importing first means the state a writer reads already contains a decision stranded by an
 * earlier rolled-back transaction.
 */
export async function enterLedger(
  tx: Tx,
  deps: DecisionDeps,
): Promise<Result<readonly PendingConfirm[], DecisionError>> {
  await lockLedger(tx);
  const caught = await importUnconfirmed(tx, deps.ledger);
  if (!caught.ok) return err(decisionError('ledger', caught.error.message, caught.error));
  return ok(caught.value.pending);
}

/** Appends events to a gate stream at its current head. Call after `lockKey` for that gate. */
export async function appendGateEvents(
  tx: Tx,
  deps: DecisionDeps,
  gateInstanceId: string,
  events: readonly NewEvent[],
): Promise<Result<void, DecisionError>> {
  const stream = gateStream(gateInstanceId);
  const head = await tx.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
    [stream],
  );
  const r = await appendEvents(tx, stream, Number(head.rows[0]?.seq ?? 0), events, {
    clock: clockOf(deps),
  });
  return r.ok ? ok(undefined) : err(decisionError('conflict', JSON.stringify(r.error)));
}

export interface DecisionDraftInput {
  readonly gate_instance_id: string;
  readonly gate_id: GateId;
  readonly subject_kind: SubjectKind;
  readonly subject_id: string;
  readonly subject_hash: string;
  readonly decision: LedgerDecision;
  readonly actor: string;
  readonly sod_waiver: boolean;
  readonly body: Record<string, unknown>;
  readonly entry_id: string;
}

export function decisionDraft(deps: DecisionDeps, i: DecisionDraftInput): LedgerEntryDraft {
  return {
    entry_id: i.entry_id,
    entry_type: 'decision',
    gate_instance_id: i.gate_instance_id,
    gate_id: i.gate_id,
    subject_kind: i.subject_kind,
    subject_id: i.subject_id,
    subject_hash: i.subject_hash,
    decision: i.decision,
    actor: i.actor,
    sod_waiver: i.sod_waiver,
    policy_bundle_version: deps.policyBundleVersion ?? DEFAULT_POLICY_BUNDLE_VERSION,
    body: i.body,
    created_at: clockOf(deps).now().toISOString(),
  } as LedgerEntryDraft;
}

/** The LAST write of a decision transaction: reserve, sign with the Notary, insert the row. */
export async function writeDecision(
  tx: Tx,
  deps: DecisionDeps,
  draft: LedgerEntryDraft,
): Promise<Result<{ entry: LedgerEntry; pending: PendingConfirm[] }, DecisionError>> {
  const w = await appendLedgerEntryTx(tx, deps.ledger, draft);
  return w.ok ? ok(w.value) : err(decisionError('ledger', w.error.message, w.error));
}

export const newEntryId = (deps: DecisionDeps): LedgerEntryId =>
  newId<'LedgerEntry'>(clockOf(deps).nowMs());
