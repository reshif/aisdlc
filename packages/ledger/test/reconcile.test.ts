import { ledgerDraftHash } from '@aisdlc/contracts';
import { assembleLedgerEntry } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendLedgerEntry,
  appendLedgerEntryTx,
  inLedgerTransaction,
  readLedgerEntries,
  reconcileLedger,
  verifyLedger,
  type PendingConfirm,
} from '../src/index.js';
import { draft, startStack, type Stack } from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

const heads = async (): Promise<number> =>
  Number(
    (
      await s.record.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM ledger.ledger_entry',
      )
    ).rows[0]?.n,
  );
const statuses = async (): Promise<string[]> =>
  (
    await s.notary.database.pool.query<{ status: string }>(
      'SELECT status FROM notary.journal ORDER BY ledger_seq',
    )
  ).rows.map((r) => r.status);
const chainOk = async () => verifyLedger(s.record.pool, s.keys, { allowUncoveredTail: true });

describe('reconciler', () => {
  it('does nothing on a healthy ledger, and twice is the same as once', async () => {
    expect((await appendLedgerEntry(s.record.pool, s.deps, draft(1))).ok).toBe(true);
    const r = await reconcileLedger(s.record.pool, s.deps);
    expect(r.ok && r.value).toEqual({ inserted: 0, confirmed: 0 });
  });

  it('crash after sign, before insert: the row is missing, the reconciler restores the chain', async () => {
    const n0 = await heads();
    // The writer got a signature and died: reserve and sign, but no insert and no confirm.
    const head = (await readLedgerEntries(s.record.pool, n0, n0))[0];
    const d = draft(2);
    const reserved = await s.coreNotary.reserve({
      prev_hash: head?.entry_hash ?? null,
      body_hash: ledgerDraftHash(d),
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const signed = await s.coreNotary.sign({ ledger_seq: reserved.value.ledger_seq, draft: d });
    expect(signed.ok).toBe(true);
    expect(await heads()).toBe(n0); // not in the record
    expect((await statuses()).at(-1)).toBe('signed');

    const r = await reconcileLedger(s.record.pool, s.deps);
    expect(r.ok && r.value).toEqual({ inserted: 1, confirmed: 1 });
    expect(await heads()).toBe(n0 + 1);
    expect((await statuses()).at(-1)).toBe('committed');

    const restored = (await readLedgerEntries(s.record.pool, n0 + 1, n0 + 1))[0];
    expect(signed.ok && restored).toEqual(
      assembleLedgerEntry(d, signed.ok ? signed.value : (null as never)),
    );
    expect((await chainOk()).ok).toBe(true);

    // The chain carries on from the restored entry.
    const next = await appendLedgerEntry(s.record.pool, s.deps, draft(3));
    expect(next.ok && next.value.prev_hash).toBe(restored?.entry_hash);
    const again = await reconcileLedger(s.record.pool, s.deps);
    expect(again.ok && again.value).toEqual({ inserted: 0, confirmed: 0 });
  });

  it('crash after insert, before confirm: the insert is a no-op and the confirm completes', async () => {
    const n0 = await heads();
    // Commit the row, then "die" before confirm.
    let pending: PendingConfirm[] = [];
    const done = await inLedgerTransaction(s.record.pool, async (tx) => {
      const r = await appendLedgerEntryTx(tx, s.deps, draft(4));
      if (r.ok) pending = r.value.pending;
      return r;
    });
    expect(done.ok).toBe(true);
    expect(await heads()).toBe(n0 + 1);
    expect(pending).toHaveLength(1);
    expect((await statuses()).at(-1)).toBe('signed');

    const r = await reconcileLedger(s.record.pool, s.deps);
    expect(r.ok && r.value).toEqual({ inserted: 0, confirmed: 1 });
    expect(await heads()).toBe(n0 + 1);
    expect((await statuses()).at(-1)).toBe('committed');
    expect((await chainOk()).ok).toBe(true);
  });

  it('restores several missing entries in order', async () => {
    const n0 = await heads();
    let prev = (await readLedgerEntries(s.record.pool, n0, n0))[0]?.entry_hash ?? null;
    for (const n of [10, 11, 12]) {
      const d = draft(n);
      const res = await s.coreNotary.reserve({ prev_hash: prev, body_hash: ledgerDraftHash(d) });
      const sg = res.ok
        ? await s.coreNotary.sign({ ledger_seq: res.value.ledger_seq, draft: d })
        : null;
      expect(sg?.ok).toBe(true);
      prev = sg?.ok ? sg.value.entry_hash : null;
    }
    const r = await reconcileLedger(s.record.pool, s.deps);
    expect(r.ok && r.value).toEqual({ inserted: 3, confirmed: 3 });
    expect(await heads()).toBe(n0 + 3);
    expect((await chainOk()).ok).toBe(true);
  });

  it('fails closed when the record already holds a different entry for that seq', async () => {
    const n0 = await heads();
    const head = (await readLedgerEntries(s.record.pool, n0, n0))[0];
    const d = draft(20);
    const res = await s.coreNotary.reserve({
      prev_hash: head?.entry_hash ?? null,
      body_hash: ledgerDraftHash(d),
    });
    expect(res.ok && (await s.coreNotary.sign({ ledger_seq: n0 + 1, draft: d })).ok).toBe(true);
    // Someone with table-owner rights puts another entry at that seq.
    await s.record.pool.query(
      `INSERT INTO ledger.ledger_entry (ledger_seq, entry_id, entry_type, sod_waiver, policy_bundle_version,
         body, prev_hash, entry_hash, notary_key_id, notary_alg, notary_sig, created_at)
       VALUES ($1, gen_random_uuid(), 'x', false, 'p', '{}', $2, $3, 'dev:notary', 'ES256', 'abc',
               date_trunc('milliseconds', now()))`,
      [n0 + 1, head?.entry_hash, 'a'.repeat(64)],
    );
    expect(await heads()).toBe(n0 + 1);

    const r = await reconcileLedger(s.record.pool, s.deps);
    expect(!r.ok && r.error.code).toBe('conflict');
    // And writers refuse too: the Notary's chain and the record disagree.
    const w = await appendLedgerEntry(s.record.pool, s.deps, draft(21));
    expect(!w.ok && w.error.code).toBe('conflict');
    expect(await heads()).toBe(n0 + 1);
  });
});
