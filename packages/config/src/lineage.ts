import {
  CONFIG_EVENT,
  ConfigProposedPayload,
  ConfigPublishedPayload,
  configLineageKey,
  configStream,
  configSubjectId,
  type ConfigDoc,
  type ConfigLineage,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// The authoritative state of one lineage, read straight from its record stream and the ledger (the
// write paths use this; `projection.ts` is the read model for lists and readers). A `config.published`
// event counts only if (1) the revision was proposed on this lineage, (2) the ledger holds the
// `approve` decision of an M1 gate on this lineage's config subject with `subject_hash` equal to
// exactly that `rev_hash`, and (3) its parent is the head at that point. An event that fails any of
// these is ignored, so nothing but a decided M1 makes a revision effective.

export interface LineageRevision extends ConfigProposedPayload {
  readonly proposed_at: string;
}

export interface Lineage {
  readonly proposed: ReadonlyMap<string, LineageRevision>;
  /** Publishes that passed all three checks, in order. */
  readonly published: readonly ConfigPublishedPayload[];
  /** The newest effective revision, or null before the first publish. */
  readonly head: { readonly rev_hash: string; readonly doc: ConfigDoc } | null;
}

/** SQL fragment shared with the reader: the ledger entry that makes a publish genuine. */
export const GENUINE_PUBLISH_SQL = `
  l.entry_type = 'decision' AND l.gate_id = 'M1' AND l.decision = 'approve'
  AND l.subject_kind = 'config' AND l.subject_hash = p.rev_hash
  AND l.gate_instance_id = p.gate_instance_id`;

export async function readLineage(db: Executor, lineage: ConfigLineage): Promise<Lineage> {
  const q = await db.query<{ type: string; body: unknown; occurred_at: Date }>(
    'SELECT type, body, occurred_at FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [configStream(lineage)],
  );
  const proposed = new Map<string, LineageRevision>();
  const published: ConfigPublishedPayload[] = [];
  let head: Lineage['head'] = null;
  const subject = configSubjectId(lineage);
  for (const e of q.rows) {
    if (e.type === CONFIG_EVENT.proposed) {
      const p = ConfigProposedPayload.parse(e.body);
      if (!proposed.has(p.rev_hash)) {
        proposed.set(p.rev_hash, { ...p, proposed_at: e.occurred_at.toISOString() });
      }
    } else if (e.type === CONFIG_EVENT.published) {
      const p = ConfigPublishedPayload.parse(e.body);
      const rev = proposed.get(p.rev_hash);
      if (!rev || p.parent_rev_hash !== (head?.rev_hash ?? null)) continue;
      if (rev.parent_rev_hash !== p.parent_rev_hash) continue;
      const hit = await db.query(
        `SELECT 1 FROM ledger.ledger_entry l, (SELECT $1::text AS rev_hash, $2::uuid AS gate_instance_id) p
          WHERE l.entry_id = $3 AND l.subject_id = $4 AND ${GENUINE_PUBLISH_SQL}`,
        [p.rev_hash, p.gate_instance_id, p.ledger_entry_id, subject],
      );
      if (hit.rowCount === 0) continue;
      published.push(p);
      head = { rev_hash: p.rev_hash, doc: rev.doc };
    }
  }
  return { proposed, published, head };
}

export const lineageKeyOf = configLineageKey;
