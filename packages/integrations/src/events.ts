import {
  CONFIG_EVENT,
  FACTORY_SCOPE,
  configStream,
  type IntegrationEvent,
} from '@aisdlc/contracts';
import { readLineage } from '@aisdlc/config';
import type { Executor } from '@aisdlc/record';
import { diffRegistry, registryDocOf } from './registry.js';

/**
 * IntegrationEvent (PLAN M10.4): every effective revision of the factory layer, in order, diffed against
 * its parent. Each event names the ledger entry of the M1 decision that made the revision effective, so
 * "who enabled this, and when" is a ledger lookup. Derived from the lineage on demand (the record and
 * the ledger are the source; there is no table to drift).
 */
export async function listIntegrationEvents(
  db: Executor,
  filter: { integration_id?: string } = {},
): Promise<IntegrationEvent[]> {
  const lineage = { layer: 'factory', scope: FACTORY_SCOPE } as const;
  const l = await readLineage(db, lineage);
  const at = await db.query<{ rev_hash: string; occurred_at: Date }>(
    `SELECT body ->> 'rev_hash' AS rev_hash, occurred_at FROM record.record_event
      WHERE stream = $1 AND type = $2`,
    [configStream(lineage), CONFIG_EVENT.published],
  );
  const when = new Map(at.rows.map((r) => [r.rev_hash, r.occurred_at.toISOString()]));
  const out: IntegrationEvent[] = [];
  let prev = null as ReturnType<typeof registryDocOf> | null;
  for (const p of l.published) {
    const doc = registryDocOf(l.proposed.get(p.rev_hash)?.doc);
    for (const d of diffRegistry(prev, doc)) {
      out.push({
        ...d,
        rev_hash: p.rev_hash,
        ledger_entry_id: p.ledger_entry_id,
        at: when.get(p.rev_hash) ?? new Date(0).toISOString(),
      });
    }
    prev = doc;
  }
  return filter.integration_id
    ? out.filter((e) => e.integration_id === filter.integration_id)
    : out;
}
