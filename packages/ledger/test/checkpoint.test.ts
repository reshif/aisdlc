import { err, manualClock, merkleRoot, type ManualClock } from '@aisdlc/kernel';
import { hexBytes, witnessError, type WitnessPort } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_INTERVAL_MS,
  CheckpointLoop,
  appendLedgerEntry,
  readLastCheckpoint,
  readLedgerEntries,
  runCheckpoint,
  verifyLedger,
} from '../src/index.js';
import { draft, startStack, type Stack } from './helpers.js';

let s: Stack;
let clock: ManualClock;
beforeAll(async () => {
  clock = manualClock('2026-11-08T10:00:00.000Z');
  s = await startStack({ clock });
});
afterAll(async () => {
  await s.stop();
});

const deps = () => ({ notary: s.checkpointerNotary, witness: s.checkpointerWitness, clock });
const append = async (n: number): Promise<void> => {
  const r = await appendLedgerEntry(s.record.pool, s.deps, draft(n));
  expect(r.ok).toBe(true);
};
const cpCount = async (): Promise<number> =>
  Number(
    (await s.record.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM ledger.checkpoint'))
      .rows[0]?.n,
  );

describe('checkpoint loop', () => {
  it('runs every 5 minutes of the injected clock and covers the head each time', async () => {
    const loop = new CheckpointLoop(s.record.pool, deps());

    // Empty ledger: the first tick runs and finds nothing to do.
    const t0 = await loop.tick();
    expect(t0.ran && t0.result.ok && t0.result.value.kind).toBe('noop');
    expect(await cpCount()).toBe(0);

    for (const n of [1, 2, 3]) await append(n);
    const early = await loop.tick();
    expect(early.ran).toBe(false); // the clock has not moved
    clock.advance(CHECKPOINT_INTERVAL_MS - 1);
    expect((await loop.tick()).ran).toBe(false);
    clock.advance(1);
    const t1 = await loop.tick();
    expect(t1.ran && t1.result.ok && t1.result.value.kind).toBe('created');
    const cp1 = await readLastCheckpoint(s.record.pool);
    expect(cp1).toMatchObject({ cp_seq: 1, from_ledger_seq: 1, to_ledger_seq: 3 });
    expect(cp1?.created_at).toBe('2026-11-08T10:05:00.000Z');
    expect(cp1?.signatures.map((x) => x.signer)).toEqual(['notary', 'witness']);

    // Nothing new: the next due tick runs and does nothing.
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const idle = await loop.tick();
    expect(idle.ran && idle.result.ok && idle.result.value.kind).toBe('noop');
    expect(await cpCount()).toBe(1);

    for (const n of [4, 5]) await append(n);
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const t2 = await loop.tick();
    expect(t2.ran && t2.result.ok && t2.result.value.kind).toBe('created');
    const cp2 = await readLastCheckpoint(s.record.pool);
    expect(cp2).toMatchObject({ cp_seq: 2, to_ledger_seq: 5 });
    const all = await readLedgerEntries(s.record.pool, 1, 5);
    expect(cp2?.root_hash).toBe(merkleRoot(all.map((e) => hexBytes(e.entry_hash))));
    expect(cp2?.head_hash).toBe(all[4]?.entry_hash);

    const v = await verifyLedger(s.record.pool, s.keys);
    expect(v.ok && v.value).toMatchObject({ entries: 5, checkpoints: 2, covered_to: 5 });
  });

  it('keeps going after a Witness failure: nothing is stored, the next round succeeds', async () => {
    await append(6);
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const before = await cpCount();
    const down: WitnessPort = {
      last: () => s.checkpointerWitness.last(),
      cosign: async () => err(witnessError('unavailable', 'connection refused')),
    };
    const bad = await runCheckpoint(s.record.pool, { ...deps(), witness: down });
    expect(!bad.ok && bad.error.code).toBe('witness');
    expect(await cpCount()).toBe(before);

    const good = await runCheckpoint(s.record.pool, deps());
    expect(good.ok && good.value.kind).toBe('created');
    expect(await cpCount()).toBe(before + 1);
  });

  it('stores a checkpoint the Witness co-signed but the record never received', async () => {
    await append(7);
    const last = await readLastCheckpoint(s.record.pool);
    const cp_seq = (last?.cp_seq ?? 0) + 1;
    clock.advance(CHECKPOINT_INTERVAL_MS);
    // Do the checkpointer's steps by hand and "crash" before the insert.
    const head = await readLedgerEntries(s.record.pool, 1, 7);
    const created_at = clock.now().toISOString();
    const signed = await s.checkpointerNotary.signCheckpoint({
      cp_seq,
      from_ledger_seq: 1,
      to_ledger_seq: 7,
      created_at,
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const prevTo = last?.to_ledger_seq ?? 0;
    const cosigned = await s.checkpointerWitness.cosign({
      core: {
        cp_seq,
        from_ledger_seq: 1,
        to_ledger_seq: 7,
        root_hash: signed.value.root_hash,
        head_hash: signed.value.head_hash,
        created_at,
      },
      notary: signed.value.signature,
      entries: head
        .filter((e) => e.ledger_seq > prevTo)
        .map((e) => ({
          ledger_seq: e.ledger_seq,
          prev_hash: e.prev_hash,
          entry_hash: e.entry_hash,
        })),
    });
    expect(cosigned.ok).toBe(true);
    expect((await readLastCheckpoint(s.record.pool))?.cp_seq).toBe(cp_seq - 1);

    clock.advance(CHECKPOINT_INTERVAL_MS);
    await append(8);
    const r = await runCheckpoint(s.record.pool, deps());
    expect(r.ok && r.value.kind === 'created' && r.value.adopted?.cp_seq).toBe(cp_seq);
    expect((await readLastCheckpoint(s.record.pool))?.cp_seq).toBe(cp_seq + 1);
    expect((await verifyLedger(s.record.pool, s.keys)).ok).toBe(true);
  });

  it('start() polls the loop on a timer and stop() ends it cleanly', async () => {
    await append(10);
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const loop = new CheckpointLoop(s.record.pool, deps());
    const seen: boolean[] = [];
    loop.start((t) => seen.push(t.ran), 5);
    const t0 = Date.now();
    while (seen.length < 3 && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 10));
    await loop.stop();
    expect(seen[0]).toBe(true); // first tick ran
    expect(seen.slice(1).every((ran) => !ran)).toBe(true); // clock did not move: skipped
    const n = seen.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.length).toBe(n); // stopped
  });

  it('refuses to checkpoint a record that differs from the Notary journal (run last: it alters a row)', async () => {
    await append(9);
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const before = await cpCount();
    // An attacker with table-owner rights rewrites an old entry in the record, triggers off.
    const c = await s.record.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(
        "UPDATE ledger.ledger_entry SET entry_hash = repeat('0', 64) WHERE ledger_seq = 2",
      );
      await c.query('RESET session_replication_role');
    } finally {
      c.release();
    }
    const r = await runCheckpoint(s.record.pool, deps());
    expect(!r.ok && r.error.code).toBe('diverged');
    expect(await cpCount()).toBe(before);
    // Offline verification sees it too.
    const v = await verifyLedger(s.record.pool, s.keys, { allowUncoveredTail: true });
    expect(!v.ok).toBe(true);
  });
});
