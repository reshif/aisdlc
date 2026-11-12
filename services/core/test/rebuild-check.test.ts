import { withTransaction } from '@aisdlc/db';
import { appendEvents } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catchUpReadModels, readModelDigests, rebuildReadModels } from '../src/rebuild-check.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// RC-OPS-1: the restore drill's read-model check on a real Postgres. The digests are a function of the read models;
// after every checked read model is dropped and refolded from the record alone they are the same.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  // some record to fold: a few events on two streams
  for (const stream of ['drill:a', 'drill:b'])
    await withTransaction(s.record.pool, async (tx) => {
      const a = await appendEvents(tx, stream, 0, [
        { type: 'drill.noted', body: { n: 1 }, actor: 'system.test' },
        { type: 'drill.noted', body: { n: 2 }, actor: 'system.test' },
      ]);
      if (!a.ok) throw new Error(a.error._tag);
    });
}, 120_000);
afterAll(async () => s?.stop());

describe('aisdlc-rebuild-check (RC-OPS-1)', () => {
  it('digests every checked read model, and a rebuild from the record gives the same digests', async () => {
    // the reference: every projection folded to the head, as the services would on their next read
    expect((await catchUpReadModels(s.record.pool))['stream_type_counts']).toBeGreaterThan(0);
    const before = await readModelDigests(s.record.pool);
    expect(Object.keys(before)).toContain('projection:core');
    expect(Object.keys(before)).toContain('table:core.evidence_pack');
    expect(before['projection:stream_type_counts']?.rows).toBeGreaterThan(0);
    // the drill's rebuild: dropped and refolded from the record alone
    const r = await rebuildReadModels(s.record.pool);
    expect(r.projections['stream_type_counts']).toBeGreaterThan(0);
    expect(await readModelDigests(s.record.pool)).toEqual(before);
  });
});
