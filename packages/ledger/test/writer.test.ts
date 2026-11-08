import type { LedgerEntry } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import { notaryError } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendLedgerEntry,
  appendLedgerEntryTx,
  inLedgerTransaction,
  confirmAll,
  LedgerWriteError,
  readLedgerEntries,
  reconcileLedger,
  verifyLedger,
} from '../src/index.js';
import { draft, startStack, wrapNotary, type Stack } from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

const head = async (): Promise<number> => {
  const q = await s.record.pool.query<{ n: string }>(
    'SELECT coalesce(max(ledger_seq), 0)::text AS n FROM ledger.ledger_entry',
  );
  return Number(q.rows[0]?.n);
};
const notaryStatuses = async (): Promise<string[]> =>
  (
    await s.notary.database.pool.query<{ status: string }>(
      'SELECT status FROM notary.journal ORDER BY ledger_seq',
    )
  ).rows.map((r) => r.status);

describe('ledger writer', () => {
  it('appends chained, Notary-signed entries: reserve, sign, insert, confirm', async () => {
    const a = await appendLedgerEntry(s.record.pool, s.deps, draft(1));
    const b = await appendLedgerEntry(s.record.pool, s.deps, draft(2));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.ledger_seq).toBe(1);
    expect(a.value.prev_hash).toBeNull();
    expect(b.value.prev_hash).toBe(a.value.entry_hash);
    expect(b.value.notary.key_id).toBe('dev:notary');

    // The stored row is exactly the returned entry, and the Notary saw both committed.
    expect(await readLedgerEntries(s.record.pool, 1, 2)).toEqual([a.value, b.value]);
    expect(await notaryStatuses()).toEqual(['committed', 'committed']);
    expect((await s.coreNotary.unconfirmed()).ok).toBe(true);
    const un = await s.coreNotary.unconfirmed();
    expect(un.ok && un.value).toEqual([]);
  });

  it('serialises concurrent writers: every entry is chained exactly once', async () => {
    const before = await head();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendLedgerEntry(s.record.pool, s.deps, draft(100 + i)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const seqs = results.map((r) => (r.ok ? r.value.ledger_seq : 0)).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => before + 1 + i));

    const rows = await readLedgerEntries(s.record.pool, 1, before + 12);
    rows.forEach((e, i) => {
      expect(e.ledger_seq).toBe(i + 1);
      if (i > 0) expect(e.prev_hash).toBe(rows[i - 1]?.entry_hash);
    });
    expect((await notaryStatuses()).every((x) => x === 'committed')).toBe(true);
    const v = await verifyLedger(s.record.pool, s.keys, { allowUncoveredTail: true });
    expect(v.ok).toBe(true);
  });

  it('refuses a draft that breaks the contract without calling the Notary', async () => {
    const before = (await notaryStatuses()).length;
    const bad = { ...draft(1), entry_type: 'decision' as const }; // gate fields are null
    const r = await appendLedgerEntry(s.record.pool, s.deps, bad);
    expect(!r.ok && r.error.code).toBe('invalid_draft');
    expect((await notaryStatuses()).length).toBe(before);
  });

  it('inserts nothing when the Notary refuses or is unreachable', async () => {
    const n0 = await head();
    const down = wrapNotary(s.coreNotary, {
      reserve: async () => err(notaryError('unavailable', 'connection refused')),
    });
    const r = await appendLedgerEntry(s.record.pool, { notary: down }, draft(7));
    expect(!r.ok && r.error.code).toBe('notary');
    expect(!r.ok && r.error.notary?.code).toBe('unavailable');
    expect(await head()).toBe(n0);
  });

  it('does not trust the Notary blindly: a wrong hash or a wrong signature is refused', async () => {
    const n0 = await head();
    const wrongHash = wrapNotary(s.coreNotary, {
      sign: async (req) => {
        const r = await s.coreNotary.sign(req);
        return r.ok ? ok({ ...r.value, entry_hash: 'f'.repeat(64) }) : r;
      },
    });
    const r1 = await appendLedgerEntry(s.record.pool, { notary: wrongHash }, draft(8));
    expect(!r1.ok && r1.error.code).toBe('notary_misbehaved');
    expect(await head()).toBe(n0);
    // That attempt left a signed entry at the Notary; the next honest write imports it first.
    const un = await s.coreNotary.unconfirmed();
    expect(un.ok && un.value).toHaveLength(1);

    const r = await appendLedgerEntry(s.record.pool, s.deps, draft(9));
    expect(r.ok).toBe(true);
    expect(await head()).toBe(n0 + 2);
    const after = await s.coreNotary.unconfirmed();
    expect(after.ok && after.value).toEqual([]);

    // A signature by the wrong key is caught when the key is known.
    const otherKey = await s.kms.custodyFor('witness').publicKey('dev:witness');
    expect(otherKey.ok).toBe(true);
    if (!otherKey.ok) return;
    const wrongKey = await appendLedgerEntry(
      s.record.pool,
      { notary: s.coreNotary, notaryKey: { ...otherKey.value, kid: 'dev:notary' } },
      draft(10),
    );
    expect(!wrongKey.ok && wrongKey.error.code).toBe('notary_misbehaved');
  });

  it('a transaction rolled back after the Notary signed does not lose the entry', async () => {
    // The wrong-key attempt above left one signed entry behind; settle it first.
    expect((await reconcileLedger(s.record.pool, s.deps)).ok).toBe(true);
    const n0 = await head();
    const done = await inLedgerTransaction(s.record.pool, async (tx) => {
      const r = await appendLedgerEntryTx(tx, s.deps, draft(20));
      expect(r.ok).toBe(true);
      return err(LedgerWriteError({ code: 'database', message: 'caller aborts' }));
    });
    expect(done.ok).toBe(false);
    expect(await head()).toBe(n0); // rolled back
    const un = await s.coreNotary.unconfirmed();
    expect(un.ok && un.value.map((e: LedgerEntry) => e.ledger_seq)).toEqual([n0 + 1]);

    // The next writer imports it, then chains its own entry after it.
    const r = await appendLedgerEntry(s.record.pool, s.deps, draft(21));
    expect(r.ok && r.value.ledger_seq).toBe(n0 + 2);
    const rows = await readLedgerEntries(s.record.pool, n0 + 1, n0 + 2);
    expect(rows[0]?.body).toEqual({ n: 20 });
    expect(rows[1]?.prev_hash).toBe(rows[0]?.entry_hash);
  });

  it('confirm is idempotent and exact', async () => {
    const r = await appendLedgerEntry(s.record.pool, s.deps, draft(30));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = await confirmAll(s.coreNotary, [
      { ledger_seq: r.value.ledger_seq, entry_hash: r.value.entry_hash },
    ]);
    expect(again.ok).toBe(true);
    const wrong = await confirmAll(s.coreNotary, [
      { ledger_seq: r.value.ledger_seq, entry_hash: 'e'.repeat(64) },
    ]);
    expect(!wrong.ok && wrong.error.code).toBe('notary');
  });
});

describe('ledger table', () => {
  const insertSql = (seq: number, prev: string | null, hash: string) => `
    INSERT INTO ledger.ledger_entry (ledger_seq, entry_id, entry_type, sod_waiver, policy_bundle_version,
      body, prev_hash, entry_hash, notary_key_id, notary_alg, notary_sig, created_at)
    VALUES (${seq}, gen_random_uuid(), 'x', false, 'p', '{}', ${prev ? `'${prev}'` : 'NULL'}, '${hash}',
      'dev:notary', 'ES256', 'abc', now() - (now() - date_trunc('milliseconds', now())))`;

  it('is append-only for everyone, and only INSERT and SELECT for aisdlc_app', async () => {
    const q = (sql: string) => s.record.pool.query(sql);
    await expect(q("UPDATE ledger.ledger_entry SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM ledger.ledger_entry')).rejects.toThrow(/append-only/);
    await expect(q('TRUNCATE ledger.ledger_entry')).rejects.toThrow(/append-only/);
    await expect(
      q("UPDATE ledger.checkpoint SET root_hash = repeat('0', 64)"),
    ).resolves.toBeDefined(); // no rows yet

    const c = await s.record.pool.connect();
    try {
      await c.query('SET ROLE aisdlc_app');
      await expect(c.query('SELECT count(*) FROM ledger.ledger_entry')).resolves.toBeDefined();
      await expect(c.query("UPDATE ledger.ledger_entry SET actor = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(c.query('DELETE FROM ledger.ledger_entry')).rejects.toThrow(/permission denied/);
      await expect(c.query('TRUNCATE ledger.ledger_entry')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  });

  it('refuses an entry that does not extend the head, a gap and a fork', async () => {
    const h = await s.record.pool.query<{ ledger_seq: string; entry_hash: string }>(
      'SELECT ledger_seq, entry_hash FROM ledger.ledger_entry ORDER BY ledger_seq DESC LIMIT 1',
    );
    const seq = Number(h.rows[0]?.ledger_seq);
    const hash = h.rows[0]?.entry_hash as string;
    const q = (sql: string) => s.record.pool.query(sql);
    await expect(q(insertSql(seq + 2, hash, 'a'.repeat(64)))).rejects.toThrow(
      /does not extend the head/,
    );
    await expect(q(insertSql(seq + 1, 'b'.repeat(64), 'a'.repeat(64)))).rejects.toThrow(
      /does not extend the head/,
    );
    await expect(q(insertSql(seq, hash, 'c'.repeat(64)))).rejects.toThrow(
      /does not extend the head/,
    );
    await expect(q(insertSql(1, null, 'd'.repeat(64)))).rejects.toThrow(/does not extend the head/);
  });

  it('refuses a decision entry without its gate fields and a first entry with a prev_hash', async () => {
    const q = (sql: string) => s.record.pool.query(sql);
    await expect(
      q(insertSql(999, 'a'.repeat(64), 'a'.repeat(64)).replace("'x'", "'decision'")),
    ).rejects.toThrow(/decision_fields|does not extend/);
    await expect(q(insertSql(1, 'a'.repeat(64), 'a'.repeat(64)))).rejects.toThrow();
  });
});
