import { DELETION_ENTRY_TYPE, LedgerEntryDraft } from '@aisdlc/contracts';
import { manualClock, newId, sha256Hex, type ManualClock } from '@aisdlc/kernel';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_INTERVAL_MS,
  appendLedgerEntry,
  redactEntriesActor,
  redactEntriesFully,
  runCheckpoint,
  verifyLedger,
} from '../src/index.js';
import { draft, startStack, tampered, type Stack } from './helpers.js';

// Delete means delete (docs/specs/deletion.md §2): a redacted entry keeps only its place in the chain, and the
// chain still verifies from the stored hashes, provided a later signed deletion.performed entry names it.

let s: Stack;
let clock: ManualClock;
const deletionId = newId<'Deletion'>();

const asPurger = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const c = await s.record.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE aisdlc_purge');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};

const decisionDraft = (actor: string) =>
  LedgerEntryDraft.parse({
    entry_id: newId<'LedgerEntry'>(),
    entry_type: 'decision',
    gate_instance_id: newId<'GateInstance'>(),
    gate_id: 'G0',
    subject_kind: 'item',
    subject_id: newId<'WorkItem'>(),
    subject_hash: sha256Hex('subject'),
    decision: 'approve',
    actor,
    sod_waiver: false,
    policy_bundle_version: 'pdp-1',
    body: { kind: 'vote', evidence_hash: sha256Hex('e'), quorum_required: 1, approvals_after: 1 },
    created_at: '2026-11-08T10:00:00.000Z',
  });

const deletionDraft = (seqs: number[]) =>
  LedgerEntryDraft.parse({
    ...draft(99),
    entry_type: DELETION_ENTRY_TYPE,
    body: {
      deletion_id: deletionId,
      kind: 'item',
      root_hash: sha256Hex('root'),
      id_hashes: [sha256Hex('root')],
      counts: {
        record_events_removed: 0,
        record_events_redacted: 0,
        ledger_entries_redacted: seqs.length,
        read_model_rows: 0,
        objects: 0,
      },
      redacted_ledger_seqs: seqs,
      reason_hash: sha256Hex('reason'),
      actor: 'root',
      override: false,
      at: '2026-11-08T10:00:00.000Z',
    },
  });

beforeAll(async () => {
  clock = manualClock('2026-11-08T10:00:00.000Z');
  s = await startStack({ clock });
  for (const n of [1, 2, 3])
    expect((await appendLedgerEntry(s.record.pool, s.deps, draft(n))).ok).toBe(true);
  expect((await appendLedgerEntry(s.record.pool, s.deps, decisionDraft('ana'))).ok).toBe(true);
  clock.advance(CHECKPOINT_INTERVAL_MS);
  const cp = { notary: s.checkpointerNotary, witness: s.checkpointerWitness, clock };
  expect((await runCheckpoint(s.record.pool, cp)).ok).toBe(true);
});
afterAll(async () => {
  await s.stop();
});

describe('redacting ledger entries', () => {
  it('only the purge role, and only to the redacted shape; never a delete', async () => {
    await expect(
      s.record.pool.query(`UPDATE ledger.ledger_entry SET body = '{}' WHERE ledger_seq = 2`),
    ).rejects.toThrow(/append-only/);
    await expect(
      asPurger((c) =>
        c.query(`UPDATE ledger.ledger_entry SET body = '{"n": 7}' WHERE ledger_seq = 2`),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      asPurger((c) => c.query(`DELETE FROM ledger.ledger_entry WHERE ledger_seq = 2`)),
    ).rejects.toThrow(/append-only|permission/);
    // Redacted, but the hash moved: refused.
    await expect(
      asPurger((c) =>
        c.query(
          `UPDATE ledger.ledger_entry SET entry_type = 'redacted', body = '{}', actor = NULL,
             policy_bundle_version = 'redacted', entry_hash = repeat('0', 64),
             redacted_at = now(), redaction_id = gen_random_uuid() WHERE ledger_seq = 2`,
        ),
      ),
    ).rejects.toThrow(/append-only|violates/);
  });

  it('a redacted entry fails the strict check, and an unaccounted one fails even with allowRedacted', async () => {
    const n = await asPurger((c) => redactEntriesFully(c, deletionId, [2], clock.now()));
    expect(n).toBe(1);
    const row = await s.record.pool.query(
      'SELECT entry_type, body, actor, entry_hash FROM ledger.ledger_entry WHERE ledger_seq = 2',
    );
    expect(row.rows[0]).toMatchObject({ entry_type: 'redacted', body: {}, actor: null });
    const strict = await verifyLedger(s.record.pool, s.keys);
    expect(!strict.ok && strict.error.code).toBe('redacted');
    const loose = await verifyLedger(s.record.pool, s.keys, { allowRedacted: true });
    expect(!loose.ok && loose.error.code).toBe('redaction_unaccounted');
  });

  it("a person's decision keeps its gate columns and the fold's keys; only the actor and the rest go", async () => {
    const n = await asPurger((c) => redactEntriesActor(c, deletionId, 'ana', [4], clock.now()));
    expect(n).toBe(1);
    const row = await s.record.pool.query(
      'SELECT entry_type, decision, actor, body, gate_id FROM ledger.ledger_entry WHERE ledger_seq = 4',
    );
    expect(row.rows[0]).toMatchObject({
      entry_type: 'decision',
      decision: 'approve',
      gate_id: 'G0',
    });
    expect(row.rows[0].actor).toMatch(/^deleted\.[0-9a-f]{16}$/);
    expect(row.rows[0].body).toEqual({ kind: 'vote', quorum_required: 1, approvals_after: 1 });
  });

  it('a signed deletion.performed that names them makes the ledger verify, checkpoints included', async () => {
    expect((await appendLedgerEntry(s.record.pool, s.deps, deletionDraft([2, 4]))).ok).toBe(true);
    const tail = await verifyLedger(s.record.pool, s.keys, {
      allowRedacted: true,
      allowUncoveredTail: true,
    });
    expect(tail.ok && tail.value).toMatchObject({ entries: 5, redacted: 2, covered_to: 4 });
    clock.advance(CHECKPOINT_INTERVAL_MS);
    const cp = { notary: s.checkpointerNotary, witness: s.checkpointerWitness, clock };
    expect((await runCheckpoint(s.record.pool, cp)).ok).toBe(true);
    const full = await verifyLedger(s.record.pool, s.keys, { allowRedacted: true });
    expect(full.ok && full.value).toMatchObject({ entries: 5, redacted: 2, covered_to: 5 });
  });

  it('a redacted entry whose stored hash or signature was changed fails', async () => {
    const hash = await tampered(
      s.record,
      [`UPDATE ledger.ledger_entry SET entry_hash = repeat('a', 64) WHERE ledger_seq = 2`],
      (tx) => verifyLedger(tx, s.keys, { allowRedacted: true }),
    );
    expect(!hash.ok && hash.error.code).toBe('notary_signature');
    const sig = await tampered(
      s.record,
      [
        `UPDATE ledger.ledger_entry SET notary_sig = (SELECT notary_sig FROM ledger.ledger_entry WHERE ledger_seq = 1)
          WHERE ledger_seq = 2`,
      ],
      (tx) => verifyLedger(tx, s.keys, { allowRedacted: true }),
    );
    expect(!sig.ok && sig.error.code).toBe('notary_signature');
    // Marking an intact entry redacted to dodge its content check: it is not named by a deletion.
    const marked = await tampered(
      s.record,
      [
        `UPDATE ledger.ledger_entry SET redacted_at = now(), redaction_id = gen_random_uuid() WHERE ledger_seq = 3`,
      ],
      (tx) => verifyLedger(tx, s.keys, { allowRedacted: true }),
    );
    expect(!marked.ok && marked.error.code).toBe('redaction_unaccounted');
  });
});

describe('redacting under the deployed row-level security (the audit migration enables it on the ledger)', () => {
  it('migration 0003 lets the purge role redact; without its policy the UPDATE touches nothing', async () => {
    // what services/audit/migrations/0001_audit.sql deploys on the ledger: RLS with read and append policies
    await s.record.pool.query(`ALTER TABLE ledger.ledger_entry ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ledger_entry_read ON ledger.ledger_entry FOR SELECT USING (true);
      CREATE POLICY ledger_entry_app_append ON ledger.ledger_entry FOR INSERT TO aisdlc_app WITH CHECK (true);`);
    expect((await appendLedgerEntry(s.record.pool, s.deps, decisionDraft('rls'))).ok).toBe(true);
    const seq = Number(
      (
        await s.record.pool.query<{ n: string }>(
          'SELECT max(ledger_seq)::text AS n FROM ledger.ledger_entry',
        )
      ).rows[0]?.n,
    );
    // without 0003's policy: zero rows, and no error (why the deletion checks the count)
    const c = await s.record.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DROP POLICY ledger_entry_purge_redact ON ledger.ledger_entry');
      await c.query('SET LOCAL ROLE aisdlc_purge');
      expect(await redactEntriesFully(c, deletionId, [seq], clock.now())).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await asPurger((x) => redactEntriesFully(x, deletionId, [seq], clock.now()))).toBe(1);
    const row = await s.record.pool.query<{ t: string }>(
      'SELECT entry_type AS t FROM ledger.ledger_entry WHERE ledger_seq = $1',
      [seq],
    );
    expect(row.rows[0]?.t).toBe('redacted');
  });
});
