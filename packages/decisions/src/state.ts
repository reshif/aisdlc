import {
  DecisionOverride,
  GATE_EVENT,
  GateOpenedPayload,
  gateStream,
  type GateStatus,
  type LedgerDecision,
  type LedgerEntry,
  type VoteDecision,
} from '@aisdlc/contracts';
import { LEDGER_ENTRY_COLUMNS, toLedgerEntry, type LedgerEntryRow } from '@aisdlc/ledger';
import type { Executor } from '@aisdlc/record';

// The status of a gate instance is a FOLD OF LEDGER DECISIONS (PLAN M3.1). This file is the one
// place that fold is written. The projection (`projection.ts`) and every write path (`vote.ts`,
// `lifecycle.ts`) call it, so a status read from the read model and a status the write path acts on
// can only differ by how far the projection has caught up, never by logic.

/** Actors that are the factory itself. They write expire, supersede and withdraw, never an approval. */
export const SYSTEM_ACTOR_PREFIX = 'system.';
export const SYSTEM_ACTORS = {
  sweep: 'system.sweep',
  gate: 'system.gate',
} as const;
export const isSystemActor = (a: string): boolean => a.startsWith(SYSTEM_ACTOR_PREFIX);

/** A ledger decision entry as the fold sees it. */
export interface DecisionRow {
  readonly ledger_seq: number;
  readonly entry_id: string;
  readonly subject_hash: string;
  readonly decision: LedgerDecision;
  readonly actor: string;
  readonly sod_waiver: boolean;
  /** ISO instant, as written on the entry. */
  readonly created_at: string;
  readonly body: Record<string, unknown>;
}

export const decisionRowOf = (e: LedgerEntry): DecisionRow => ({
  ledger_seq: e.ledger_seq,
  entry_id: e.entry_id,
  subject_hash: e.subject_hash ?? '',
  decision: e.decision as LedgerDecision,
  actor: e.actor ?? '',
  sod_waiver: e.sod_waiver,
  created_at: e.created_at,
  body: e.body,
});

export interface FoldInput {
  readonly subject_hash: string;
  readonly quorum_required: number;
}

export interface FoldedGate {
  readonly status: GateStatus;
  /** The quorum decision that ended the gate; `null` unless `status` is `decided`. */
  readonly outcome: VoteDecision | null;
  /** Distinct approvers, in the order their approvals reached the ledger (also while pending). */
  readonly approvers: readonly string[];
  /** When the instance left `pending`: the created_at of the ending entry. */
  readonly ended_at: string | null;
  readonly ended_ledger_seq: number | null;
  readonly superseded_by: string | null;
  /** Entries that changed something (counted a new approver or ended the gate). */
  readonly effective_seqs: readonly number[];
}

/** A decision entry the kernel wrote as the factory admin's override (`body.override`, `DecisionOverride`). */
export const isOverride = (body: Record<string, unknown>): boolean =>
  DecisionOverride.safeParse(body['override']).success;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Folds the decisions of one instance, in ledger order:
 *  - an entry for another subject hash is ignored (a decision binds the exact subject it was shown);
 *  - once the instance has left `pending`, nothing changes it (a decided instance is never touched);
 *  - `approve` adds its actor once (a repeat counts once) and decides when distinct approvers reach
 *    the quorum frozen at open; an approve by a system actor counts for nothing; an approve that is the factory
 *    admin's override (`body.override`) decides at once;
 *  - `reject` and `request_changes` decide at once;
 *  - `supersede`, `expire` and `withdraw` end the instance as superseded, expired and closed.
 * It is a function of its arguments only, and does not need the eligibility of the actors: the
 * write path checked that before the entry was written.
 */
export function foldDecisions(input: FoldInput, rows: readonly DecisionRow[]): FoldedGate {
  const f = {
    status: 'pending' as GateStatus,
    outcome: null as VoteDecision | null,
    approvers: [] as string[],
    ended_at: null as string | null,
    ended_ledger_seq: null as number | null,
    superseded_by: null as string | null,
    effective_seqs: [] as number[],
  };
  const end = (s: GateStatus, r: DecisionRow): void => {
    f.status = s;
    f.ended_at = r.created_at;
    f.ended_ledger_seq = r.ledger_seq;
    f.effective_seqs.push(r.ledger_seq);
  };

  for (const r of [...rows].sort((a, b) => a.ledger_seq - b.ledger_seq)) {
    if (r.subject_hash !== input.subject_hash) continue;
    if (f.status !== 'pending') break;
    switch (r.decision) {
      case 'approve':
        if (isSystemActor(r.actor)) break;
        // The factory admin's override (docs/specs/deletion.md §8): the write path accepted it as deciding.
        if (isOverride(r.body)) {
          if (!f.approvers.includes(r.actor)) f.approvers.push(r.actor);
          end('decided', r);
          f.outcome = 'approve';
          break;
        }
        if (f.approvers.includes(r.actor)) break;
        f.approvers.push(r.actor);
        f.effective_seqs.push(r.ledger_seq);
        if (f.approvers.length >= input.quorum_required) {
          end('decided', r);
          f.outcome = 'approve';
        }
        break;
      case 'reject':
      case 'request_changes':
        end('decided', r);
        f.outcome = r.decision;
        break;
      case 'supersede': {
        end('superseded', r);
        const to = r.body['superseded_by'];
        f.superseded_by = typeof to === 'string' && UUID.test(to) ? to : null;
        break;
      }
      case 'expire':
        end('expired', r);
        break;
      case 'withdraw':
        end('closed', r);
        break;
    }
  }
  return f;
}

// ---------------------------------------------------------------- Authoritative read

export interface OpenedGate {
  readonly gate_instance_id: string;
  /** `occurred_at` of the `gate.opened` record event. */
  readonly opened_at: string;
  readonly payload: GateOpenedPayload;
}

export interface GateState extends FoldedGate {
  readonly open: OpenedGate;
  readonly decisions: readonly DecisionRow[];
}

/** The `gate.opened` event of an instance, or null if the stream has none. */
export async function readOpened(db: Executor, id: string): Promise<OpenedGate | null> {
  const q = await db.query<{ body: unknown; occurred_at: Date; type: string }>(
    `SELECT body, occurred_at, type FROM record.record_event WHERE stream = $1 AND seq = 1`,
    [gateStream(id)],
  );
  const row = q.rows[0];
  if (!row || row.type !== GATE_EVENT.opened) return null;
  const payload = GateOpenedPayload.parse(row.body);
  if (payload.gate_instance_id !== id) {
    throw new Error(`gate stream ${id} opens instance ${payload.gate_instance_id}`);
  }
  return { gate_instance_id: id, opened_at: row.occurred_at.toISOString(), payload };
}

/** The decision entries of an instance straight from the ledger, ascending. */
export async function readDecisions(db: Executor, id: string): Promise<DecisionRow[]> {
  const q = await db.query<LedgerEntryRow>(
    `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry
      WHERE entry_type = 'decision' AND gate_instance_id = $1 ORDER BY ledger_seq`,
    [id],
  );
  return q.rows.map((r) => decisionRowOf(toLedgerEntry(r)));
}

/**
 * The authoritative state of an instance: its open event from the record and its decisions from the
 * ledger, folded now. Nothing here reads the projection, so a decision whose caller transaction
 * rolled back after the Notary signed is seen as soon as its ledger row exists.
 */
export async function readGateState(db: Executor, id: string): Promise<GateState | null> {
  const open = await readOpened(db, id);
  if (!open) return null;
  const decisions = await readDecisions(db, id);
  const folded = foldDecisions(
    { subject_hash: open.payload.subject_hash, quorum_required: open.payload.quorum.required },
    decisions,
  );
  return { ...folded, open, decisions };
}
