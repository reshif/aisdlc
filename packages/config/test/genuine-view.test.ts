import { FACTORY_SCOPE, configLineageKey, configSubjectId } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigReader,
  configProjection,
  configPublish,
  proposeRevision,
  readLineage,
} from '../src/index.js';
import { GENUINE_PUBLISH_SQL } from '../src/lineage.js';
import { decideGate, pr, setupProject, startStack, type Stack } from './helpers.js';

// `config.genuine_publish` (migration 0002) is the ledger join of `loadEffective` as a view, so a reader
// that may not read the ledger (the gateway) can still read the effective config. The view's condition
// and `GENUINE_PUBLISH_SQL` (what the write paths use) must say the same thing.

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'factory', { admin: ['root', 'rita'] });
});
afterAll(() => s.stop());

describe('config.genuine_publish', () => {
  it('holds exactly the publishes the lineage reader calls genuine, and nothing a forged row could add', async () => {
    const doc = { 'core.retention_days': 30 };
    void doc;
    const keys = s.deps.registry.keys();
    const key = keys.find((k) => k.startsWith('s0') || k.startsWith('core')) ?? keys[0]!;
    const def = s.deps.registry.get(key)!;
    const p = await proposeRevision(s.deps, {
      layer: 'factory',
      proposed_by: pr('dev'),
      doc: { [key]: def.default },
    });
    if (!p.ok) throw new Error(p.error.message);
    const d = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
    expect(d.ok).toBe(true);
    expect((await configPublish(s.deps, { rev_hash: p.value.rev_hash })).ok).toBe(true);
    await runProjection(s.record.pool, configProjection);
    const lineage = { layer: 'factory', scope: FACTORY_SCOPE } as const;
    const viaView = await s.record.pool.query(
      `SELECT rev_hash FROM config.genuine_publish WHERE lineage = $1 AND subject_id = $2 ORDER BY global_seq`,
      [configLineageKey(lineage), configSubjectId(lineage)],
    );
    const viaSql = await s.record.pool.query(
      `SELECT p.rev_hash FROM config.config_published p
         JOIN ledger.ledger_entry l ON l.entry_id = p.ledger_entry_id AND l.subject_id = $2 AND ${GENUINE_PUBLISH_SQL}
        WHERE p.lineage = $1 ORDER BY p.global_seq`,
      [configLineageKey(lineage), configSubjectId(lineage)],
    );
    expect(viaView.rows).toEqual(viaSql.rows);
    expect(viaView.rows.map((r) => r.rev_hash)).toEqual([p.value.rev_hash]);
    expect((await readLineage(s.record.pool, lineage)).head?.rev_hash).toBe(p.value.rev_hash);
    // a forged published row (no ledger entry behind it) is in the table but not in the view
    await s.record.pool.query(
      `INSERT INTO config.config_published (rev_hash, lineage, parent_rev_hash, gate_instance_id, ledger_entry_id, published_by, published_at, global_seq)
       VALUES (repeat('a', 64), $1, NULL, gen_random_uuid(), gen_random_uuid(), 'forger', now(), 99999999)`,
      [configLineageKey(lineage)],
    );
    const after = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM config.genuine_publish WHERE rev_hash = repeat('a', 64)`,
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('a reader that does not fold the read model (catchUp: false) sees what has been folded, and the same effective revision', async () => {
    const folded = await ConfigReader.create({ pool: s.record.pool, registry: s.deps.registry });
    const plain = await ConfigReader.create({
      pool: s.record.pool,
      registry: s.deps.registry,
      catchUp: false,
    });
    expect(plain.current().token).toBe(folded.current().token);
  });
});
