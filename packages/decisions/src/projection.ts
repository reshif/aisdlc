import {
  GATE_EVENT,
  GateOpenedPayload,
  type GateInstance,
  type LedgerEntry,
} from '@aisdlc/contracts';
import { ledgerFeed } from '@aisdlc/ledger';
import type { Executor, Projection, Tx } from '@aisdlc/record';
import { decisionRowOf, foldDecisions, type DecisionRow } from './state.js';

// The `gate_instance` read model (PLAN M3.1). One projection with TWO sources:
//   record events on `gate:<id>`  -> the open facts (`gate.opened`) and annotations (`gate_event`);
//   ledger `decision` entries     -> `gate_vote`, and from them every status column.
// Status, outcome, approvers and the end time are only ever written by `recompute`, which folds
// the stored decision rows with the shared `foldDecisions`. A record event never changes a status.
// Because every write ends in `recompute` over the SET of rows stored so far, the final state does
// not depend on whether a ledger entry or the open event was folded first, which is what lets the
// runner fold the two sources independently (see `Projection.feeds`).

const GATE_PREFIX = 'gate:';
const iso = (d: Date): string => d.toISOString();

interface VoteRow {
  ledger_seq: string;
  entry_id: string;
  subject_hash: string;
  decision: string;
  actor: string;
  sod_waiver: boolean;
  created_at: Date;
  body: Record<string, unknown>;
}

async function recompute(tx: Tx, id: string): Promise<void> {
  const inst = await tx.query<{ subject_hash: string; quorum_required: number }>(
    'SELECT subject_hash, quorum_required FROM decisions.gate_instance WHERE gate_instance_id = $1',
    [id],
  );
  const open = inst.rows[0];
  if (!open) return; // decisions that arrived before the open event: stored, folded when it comes
  const votes = await tx.query<VoteRow>(
    `SELECT ledger_seq::text AS ledger_seq, entry_id, subject_hash, decision, actor, sod_waiver,
            created_at, body
       FROM decisions.gate_vote WHERE gate_instance_id = $1 ORDER BY ledger_seq`,
    [id],
  );
  const rows: DecisionRow[] = votes.rows.map((v) => ({
    ledger_seq: Number(v.ledger_seq),
    entry_id: v.entry_id,
    subject_hash: v.subject_hash,
    decision: v.decision as DecisionRow['decision'],
    actor: v.actor,
    sod_waiver: v.sod_waiver,
    created_at: iso(v.created_at),
    body: v.body,
  }));
  const f = foldDecisions(
    { subject_hash: open.subject_hash, quorum_required: open.quorum_required },
    rows,
  );
  await tx.query(
    `UPDATE decisions.gate_instance
        SET status = $2, outcome = $3, approvers = $4::jsonb, decided_at = $5,
            decided_ledger_seq = $6, superseded_by = $7
      WHERE gate_instance_id = $1`,
    [
      id,
      f.status,
      f.outcome,
      JSON.stringify(f.approvers),
      f.ended_at,
      f.ended_ledger_seq === null ? null : String(f.ended_ledger_seq),
      f.superseded_by,
    ],
  );
}

export interface GateProjectionSnapshot {
  instances: Array<
    Omit<GateInstance, 'decided_at'> & {
      project_id: string;
      requester: string | null;
      expires_at: string;
      quorum_required: number;
      supersedes: string | null;
      superseded_by: string | null;
      outcome: string | null;
      approvers: string[];
      /** When the instance left `pending` (any end state), not only `decided`. */
      decided_at: string | null;
      decided_ledger_seq: number | null;
    }
  >;
  votes: Array<{
    ledger_seq: number;
    gate_instance_id: string;
    entry_id: string;
    decision: string;
    actor: string;
    sod_waiver: boolean;
    created_at: string;
  }>;
  events: Array<{ event_id: string; gate_instance_id: string; stream_seq: number; type: string }>;
}

export const gateInstanceProjection: Projection<GateProjectionSnapshot, LedgerEntry> = {
  name: 'gate_instance',
  version: 1,
  tables: ['decisions.gate_instance', 'decisions.gate_vote', 'decisions.gate_event'],
  feeds: [ledgerFeed],

  async apply(tx, event) {
    if (!event.stream_id.startsWith(GATE_PREFIX)) return;
    const id = event.stream_id.slice(GATE_PREFIX.length);
    if (event.type === GATE_EVENT.opened) {
      // `gate.opened` is the first event of the stream; a later one would be a bug, not a reopening.
      if (event.stream_seq !== 1) return;
      const p = GateOpenedPayload.parse(event.payload);
      await tx.query(
        `INSERT INTO decisions.gate_instance
           (gate_instance_id, gate_id, project_id, subject_kind, subject_id, subject_hash,
            evidence_pack_hash, requester, facts, expires_at, quorum_required, supersedes,
            opened_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,'pending')
         ON CONFLICT (gate_instance_id) DO NOTHING`,
        [
          id,
          p.gate_id,
          p.project_id,
          p.subject_kind,
          p.subject_id,
          p.subject_hash,
          p.evidence_pack_hash,
          p.requester,
          JSON.stringify(p.facts),
          p.facts['expires_at'],
          p.quorum.required,
          p.supersedes,
          event.occurred_at,
        ],
      );
      await recompute(tx, id);
      return;
    }
    await tx.query(
      `INSERT INTO decisions.gate_event
         (event_id, gate_instance_id, stream_seq, type, actor, occurred_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        id,
        event.stream_seq,
        event.type,
        event.actor,
        event.occurred_at,
        JSON.stringify(event.payload),
      ],
    );
  },

  async applyFeed(tx, feed, _seq, entry) {
    if (feed !== 'ledger') throw new Error(`gate_instance: unknown feed ${feed}`);
    if (entry.entry_type !== 'decision' || entry.gate_instance_id === null) return;
    const r = decisionRowOf(entry);
    await tx.query(
      `INSERT INTO decisions.gate_vote
         (ledger_seq, gate_instance_id, entry_id, subject_hash, decision, actor, sod_waiver,
          created_at, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (ledger_seq) DO NOTHING`,
      [
        String(r.ledger_seq),
        entry.gate_instance_id,
        r.entry_id,
        r.subject_hash,
        r.decision,
        r.actor,
        r.sod_waiver,
        r.created_at,
        JSON.stringify(r.body),
      ],
    );
    await recompute(tx, entry.gate_instance_id);
  },

  async reset(tx) {
    await tx.query('DELETE FROM decisions.gate_event');
    await tx.query('DELETE FROM decisions.gate_vote');
    await tx.query('DELETE FROM decisions.gate_instance');
  },

  async snapshot(db: Executor) {
    const inst = await db.query<{
      gate_instance_id: string;
      gate_id: string;
      project_id: string;
      subject_kind: string;
      subject_id: string;
      subject_hash: string;
      evidence_pack_hash: string | null;
      requester: string | null;
      facts: Record<string, unknown>;
      expires_at: Date;
      quorum_required: number;
      supersedes: string | null;
      opened_at: Date;
      status: string;
      outcome: string | null;
      approvers: string[];
      decided_at: Date | null;
      decided_ledger_seq: string | null;
      superseded_by: string | null;
    }>(
      `SELECT gate_instance_id, gate_id, project_id, subject_kind, subject_id, subject_hash,
              evidence_pack_hash, requester, facts, expires_at, quorum_required, supersedes,
              opened_at, status, outcome, approvers, decided_at,
              decided_ledger_seq::text AS decided_ledger_seq, superseded_by
         FROM decisions.gate_instance ORDER BY gate_instance_id`,
    );
    const votes = await db.query<VoteRow & { gate_instance_id: string }>(
      `SELECT ledger_seq::text AS ledger_seq, gate_instance_id, entry_id, subject_hash, decision,
              actor, sod_waiver, created_at, body
         FROM decisions.gate_vote ORDER BY ledger_seq`,
    );
    const events = await db.query<{
      event_id: string;
      gate_instance_id: string;
      stream_seq: number;
      type: string;
    }>(
      `SELECT event_id, gate_instance_id, stream_seq, type FROM decisions.gate_event
        ORDER BY gate_instance_id, stream_seq`,
    );
    return {
      instances: inst.rows.map((r) => ({
        gate_instance_id:
          r.gate_instance_id as GateProjectionSnapshot['instances'][number]['gate_instance_id'],
        gate_id: r.gate_id as GateProjectionSnapshot['instances'][number]['gate_id'],
        project_id: r.project_id,
        subject_kind: r.subject_kind as GateProjectionSnapshot['instances'][number]['subject_kind'],
        subject_id: r.subject_id,
        subject_hash: r.subject_hash,
        evidence_pack_hash: r.evidence_pack_hash,
        requester: r.requester,
        status: r.status as GateProjectionSnapshot['instances'][number]['status'],
        facts: r.facts,
        expires_at: iso(r.expires_at),
        quorum_required: r.quorum_required,
        supersedes: r.supersedes,
        superseded_by: r.superseded_by,
        outcome: r.outcome,
        approvers: r.approvers,
        opened_at: iso(r.opened_at),
        decided_at: r.decided_at ? iso(r.decided_at) : null,
        decided_ledger_seq: r.decided_ledger_seq === null ? null : Number(r.decided_ledger_seq),
      })),
      votes: votes.rows.map((v) => ({
        ledger_seq: Number(v.ledger_seq),
        gate_instance_id: v.gate_instance_id,
        entry_id: v.entry_id,
        decision: v.decision,
        actor: v.actor,
        sod_waiver: v.sod_waiver,
        created_at: iso(v.created_at),
      })),
      events: events.rows,
    };
  },
};
