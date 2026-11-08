import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/index.js';
import { withTestDatabase } from '../src/testing.js';

describe('withTransaction', () => {
  it('commits on success and rolls back on throw', async () => {
    await withTestDatabase(async (t) => {
      await t.pool.query('CREATE TABLE tx_demo (n int)');
      await withTransaction(t.pool, (tx) => tx.query('INSERT INTO tx_demo VALUES (1)'));
      await expect(
        withTransaction(t.pool, async (tx) => {
          await tx.query('INSERT INTO tx_demo VALUES (2)');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const r = await t.pool.query('SELECT n FROM tx_demo ORDER BY n');
      expect(r.rows).toEqual([{ n: 1 }]);
    });
  });
});
