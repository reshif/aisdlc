import {
  CARD_EVENT,
  CARD_STEP_ENTRY_TYPE,
  CardEscalatedPayload,
  CardOpenedPayload,
  CardPayloadRecordedPayload,
  InboxCard,
  type GateStatus,
  type RecordEvent,
  type VoteDecision,
} from '@aisdlc/contracts';
import type { Executor, Projection, Tx } from '@aisdlc/record';
import { deriveCardStatus } from './state.js';

// The `inbox` read model (PLAN M3.4): cards, their targets and escalation entries, folded from the
// `card:` record streams alone. Status and gate outcomes are not stored: `readCardViews` derives
// them from `decisions.gate_instance` (itself a fold of the ledger) and from the step entries on
// the ledger. So the rebuild test compares what a reader sees, with `gate_instance` live.

const CARD_PREFIX = 'card:';
const iso = (d: Date): string => d.toISOString();

export interface InboxProjectionSnapshot {
  cards: unknown[];
  gates: unknown[];
  steps: unknown[];
  entries: unknown[];
  /** What a reader sees: the cards with their derived status (needs `gate_instance` current). */
  views: InboxCard[];
}

export const inboxProjection: Projection<InboxProjectionSnapshot> = {
  name: 'inbox',
  version: 1,
  tables: [
    'decisions.inbox_entry',
    'decisions.inbox_card_step',
    'decisions.inbox_card_gate',
    'decisions.inbox_card',
  ],

  async apply(tx: Tx, event: RecordEvent) {
    if (!event.stream_id.startsWith(CARD_PREFIX)) return;
    const id = event.stream_id.slice(CARD_PREFIX.length);
    if (event.type === CARD_EVENT.opened) {
      if (event.stream_seq !== 1) return;
      const p = CardOpenedPayload.parse(event.payload);
      await tx.query(
        `INSERT INTO decisions.inbox_card
           (card_id, project_id, subject_kind, subject_id, card_group, label, role, requester,
            sla_due_at, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (card_id) DO NOTHING`,
        [
          id,
          p.project_id,
          p.subject_kind,
          p.subject_id,
          p.group,
          p.label,
          p.role,
          p.requester,
          p.sla_due_at,
          event.occurred_at,
        ],
      );
      for (const [position, t] of p.targets.entries()) {
        if (t.target === 'gate') {
          await tx.query(
            `INSERT INTO decisions.inbox_card_gate
               (card_id, gate_instance_id, gate_id, subject_hash, position)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [id, t.gate_instance_id, t.gate_id, t.subject_hash, position],
          );
        } else {
          await tx.query(
            `INSERT INTO decisions.inbox_card_step (card_id, step, slot, position)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [id, t.step, t.slot, position],
          );
        }
      }
      return;
    }
    if (event.type === CARD_EVENT.payload_recorded) {
      const p = CardPayloadRecordedPayload.parse(event.payload);
      await tx.query('UPDATE decisions.inbox_card SET payload_hash = $2 WHERE card_id = $1', [
        id,
        p.payload_hash,
      ]);
      return;
    }
    if (event.type === CARD_EVENT.escalated) {
      const p = CardEscalatedPayload.parse(event.payload);
      await tx.query(
        `UPDATE decisions.inbox_card SET escalated_at = coalesce(escalated_at, $2) WHERE card_id = $1`,
        [id, p.escalated_at],
      );
      for (const principal of p.backup) {
        await tx.query(
          `INSERT INTO decisions.inbox_entry (card_id, principal, reason, gate_instance_id, created_at)
           VALUES ($1,$2,'escalated_backup',$3,$4) ON CONFLICT DO NOTHING`,
          [id, principal, p.gate_instance_id, p.escalated_at],
        );
      }
    }
  },

  async reset(tx) {
    for (const t of this.tables) await tx.query(`DELETE FROM ${t}`);
  },

  async snapshot(db: Executor) {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      cards: await q('SELECT * FROM decisions.inbox_card ORDER BY card_id'),
      gates: await q('SELECT * FROM decisions.inbox_card_gate ORDER BY card_id, position'),
      steps: await q('SELECT * FROM decisions.inbox_card_step ORDER BY card_id, position'),
      entries: await q(
        'SELECT * FROM decisions.inbox_entry ORDER BY card_id, principal, gate_instance_id',
      ),
      views: await readCardViews(db),
    };
  },
};

// ---------------------------------------------------------------- Views

interface CardRow {
  card_id: string;
  project_id: string;
  subject_kind: string;
  subject_id: string;
  card_group: string;
  label: string | null;
  role: string;
  requester: string | null;
  sla_due_at: Date;
  opened_at: Date;
  payload_hash: string | null;
  escalated_at: Date | null;
}

export interface CardViewFilter {
  /** Only cards with a gate that is (as far as the read model knows) still pending. */
  readonly open_only?: boolean;
  readonly card_ids?: readonly string[];
  readonly project_id?: string;
  readonly subject?: { kind: string; id: string };
}

/**
 * Cards with their derived status, oldest first. Reads the inbox tables, `gate_instance` and the
 * step entries on the ledger; run both projections first for a current answer (`listInbox` does).
 */
export async function readCardViews(
  db: Executor,
  filter: CardViewFilter = {},
): Promise<InboxCard[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.card_ids) {
    args.push([...filter.card_ids]);
    where.push(`c.card_id = ANY($${args.length}::uuid[])`);
  }
  if (filter.project_id) {
    args.push(filter.project_id);
    where.push(`c.project_id = $${args.length}`);
  }
  if (filter.open_only) {
    where.push(`EXISTS (SELECT 1 FROM decisions.inbox_card_gate og
        LEFT JOIN decisions.gate_instance oi USING (gate_instance_id)
       WHERE og.card_id = c.card_id AND (oi.status = 'pending' OR oi.status IS NULL))`);
  }
  if (filter.subject) {
    args.push(filter.subject.kind, filter.subject.id);
    where.push(`c.subject_kind = $${args.length - 1} AND c.subject_id = $${args.length}`);
  }
  const cards = await db.query<CardRow>(
    `SELECT c.* FROM decisions.inbox_card c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.opened_at, c.card_id`,
    args,
  );
  if (cards.rows.length === 0) return [];
  const ids = cards.rows.map((c) => c.card_id);
  const gates = await db.query<{
    card_id: string;
    gate_instance_id: string;
    gate_id: string;
    status: string | null;
    outcome: string | null;
  }>(
    `SELECT g.card_id, g.gate_instance_id, g.gate_id, i.status, i.outcome
       FROM decisions.inbox_card_gate g
       LEFT JOIN decisions.gate_instance i USING (gate_instance_id)
      WHERE g.card_id = ANY($1::uuid[]) ORDER BY g.card_id, g.position`,
    [ids],
  );
  const steps = await db.query<{ card_id: string; step: string; decision: string | null }>(
    `SELECT s.card_id, s.step,
            (SELECT l.decision FROM ledger.ledger_entry l
              WHERE l.entry_type = $2 AND l.body ->> 'card_id' = s.card_id::text
                AND l.body ->> 'step' = s.step ORDER BY l.ledger_seq LIMIT 1) AS decision
       FROM decisions.inbox_card_step s WHERE s.card_id = ANY($1::uuid[]) ORDER BY s.card_id, s.position`,
    [ids, CARD_STEP_ENTRY_TYPE],
  );
  return cards.rows.map((c) => {
    const g = gates.rows
      .filter((r) => r.card_id === c.card_id)
      // A gate whose open event the gate projection has not folded yet is unknown: pending.
      .map((r) => ({
        gate_instance_id: r.gate_instance_id,
        gate_id: r.gate_id,
        status: (r.status ?? 'pending') as GateStatus,
        outcome: (r.outcome ?? null) as VoteDecision | null,
      }));
    const s = steps.rows
      .filter((r) => r.card_id === c.card_id)
      .map((r) => ({ step: r.step, decision: (r.decision ?? null) as VoteDecision | null }));
    return InboxCard.parse({
      card_id: c.card_id,
      project_id: c.project_id,
      subject_kind: c.subject_kind,
      subject_id: c.subject_id,
      group: c.card_group,
      label: c.label,
      role: c.role,
      status: deriveCardStatus(
        g,
        s.map((x) => x.decision),
      ),
      gates: g,
      steps: s,
      sla_due_at: iso(c.sla_due_at),
      escalated: c.escalated_at !== null,
      payload_hash: c.payload_hash,
      requester: c.requester,
      opened_at: iso(c.opened_at),
    });
  });
}
