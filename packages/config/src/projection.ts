import {
  CONFIG_EVENT,
  ConfigProposedPayload,
  ConfigPublishedPayload,
  configLineageKey,
  configSubjectId,
  type ConfigDoc,
  type ConfigLineage,
  type RecordEvent,
} from '@aisdlc/contracts';
import type { Executor, Projection, Tx } from '@aisdlc/record';

// The `config` read model: revisions and publish records folded from the `config:` record streams
// alone. Whether a publish is genuine is NOT decided here: `loadEffective` joins each published row
// to the ledger entry it names, so a forged or stale row can never become effective.

const PREFIX = 'config:';

export interface ConfigProjectionSnapshot {
  revisions: unknown[];
  published: unknown[];
}

export const configProjection: Projection<ConfigProjectionSnapshot> = {
  name: 'config',
  version: 1,
  tables: ['config.config_published', 'config.config_revision'],

  async apply(tx: Tx, event: RecordEvent) {
    if (!event.stream_id.startsWith(PREFIX)) return;
    const lineage = event.stream_id.slice(PREFIX.length);
    if (event.type === CONFIG_EVENT.proposed) {
      const p = ConfigProposedPayload.parse(event.payload);
      await tx.query(
        `INSERT INTO config.config_revision
           (rev_hash, layer, scope_kind, scope_ref, lineage, parent_rev_hash, doc, proposed_by,
            proposed_at, global_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) ON CONFLICT (rev_hash) DO NOTHING`,
        [
          p.rev_hash,
          p.layer,
          p.scope.kind,
          p.scope.ref,
          lineage,
          p.parent_rev_hash,
          JSON.stringify(p.doc),
          p.proposed_by,
          event.occurred_at,
          String(event.global_seq),
        ],
      );
    } else if (event.type === CONFIG_EVENT.published) {
      const p = ConfigPublishedPayload.parse(event.payload);
      await tx.query(
        `INSERT INTO config.config_published
           (rev_hash, lineage, parent_rev_hash, gate_instance_id, ledger_entry_id, published_by,
            published_at, global_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (rev_hash) DO NOTHING`,
        [
          p.rev_hash,
          lineage,
          p.parent_rev_hash,
          p.gate_instance_id,
          p.ledger_entry_id,
          p.published_by,
          event.occurred_at,
          String(event.global_seq),
        ],
      );
    }
  },

  async reset(tx) {
    await tx.query('DELETE FROM config.config_published');
    await tx.query('DELETE FROM config.config_revision');
  },

  async snapshot(db: Executor) {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      revisions: await q('SELECT * FROM config.config_revision ORDER BY rev_hash'),
      published: await q('SELECT * FROM config.config_published ORDER BY rev_hash'),
    };
  },
};

export interface EffectiveLayer {
  readonly rev_hash: string;
  readonly doc: ConfigDoc;
}

/**
 * The newest effective revision of a lineage from the read model: published rows whose M1 decision
 * entry exists on the ledger for exactly that hash, walked in order so each one's parent is the
 * head before it (a row that breaks the chain is ignored). `null` before the first publish.
 */
export async function loadEffective(
  db: Executor,
  lineage: ConfigLineage,
): Promise<EffectiveLayer | null> {
  // Through the `config.genuine_publish` view (migration 0002): the same join to the ledger as
  // GENUINE_PUBLISH_SQL, readable by a role that may not read the ledger itself.
  const q = await db.query<{
    rev_hash: string;
    parent_rev_hash: string | null;
    rev_parent: string | null;
    doc: ConfigDoc;
  }>(
    `SELECT rev_hash, parent_rev_hash, rev_parent, doc
       FROM config.genuine_publish
      WHERE lineage = $1 AND subject_id = $2 ORDER BY global_seq`,
    [configLineageKey(lineage), configSubjectId(lineage)],
  );
  let head: EffectiveLayer | null = null;
  for (const r of q.rows) {
    const parent = head?.rev_hash ?? null;
    if (r.parent_rev_hash !== parent || r.rev_parent !== parent) continue;
    head = { rev_hash: r.rev_hash, doc: r.doc };
  }
  return head;
}
