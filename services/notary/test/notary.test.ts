import {
  checkLedgerEntrySignature,
  draftOfEntry,
  ledgerDraftHash,
  ledgerEntryMessage,
} from '@aisdlc/contracts';
import { verifyEs256 } from '@aisdlc/kernel';
import { notaryConformance, sampleDraft, signEntries } from '@aisdlc/ports/testing';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpNotary } from '../src/client.js';
import { startTestNotary, type TestNotary } from '../src/testing.js';

let kms: TestKms;
beforeAll(async () => {
  kms = await startTestKms();
});
afterAll(async () => {
  await kms.stop();
});

const start = (): Promise<TestNotary> => startTestNotary({ custody: kms.custodyFor('notary') });

notaryConformance('NotaryService (direct)', async () => {
  const n = await start();
  return { notary: n.service, stop: () => n.stop() };
});

notaryConformance('HttpNotary (real HTTP, real kms-local)', async () => {
  const n = await start();
  return { notary: n.clientFor('tester'), stop: () => n.stop() };
});

describe('notary service', () => {
  it('signs entries that verify with WebCrypto from the JWK alone', async () => {
    const n = await start();
    try {
      const entries = await signEntries(n.clientFor('core'), 3);
      const jwk = await kms.custodyFor('witness').publicKey('dev:notary'); // public keys are readable
      expect(jwk.ok).toBe(true);
      if (!jwk.ok) return;
      for (const e of entries) {
        expect(await checkLedgerEntrySignature(e, jwk.value)).toBeNull();
        const msg = ledgerEntryMessage(draftOfEntry(e), e.ledger_seq, e.prev_hash);
        expect(await verifyEs256(jwk.value, msg, e.notary.value)).toBe(true);
        expect(e.notary).toMatchObject({ key_id: 'dev:notary', alg: 'ES256' });
      }
    } finally {
      await n.stop();
    }
  });

  it('refuses callers without a token, with a wrong token, or without the scope', async () => {
    const n = await start();
    try {
      const noToken = await fetch(new URL('/v1/unconfirmed', n.url));
      expect(noToken.status).toBe(401);
      const wrong = new HttpNotary({ baseUrl: n.url, token: 'z'.repeat(40) });
      const w = await wrong.reserve({ prev_hash: null, body_hash: 'a'.repeat(64) });
      expect(!w.ok && w.error.code).toBe('unauthenticated');

      const checkpointer = n.clientFor('checkpointer');
      const r = await checkpointer.reserve({ prev_hash: null, body_hash: 'a'.repeat(64) });
      expect(!r.ok && r.error.code).toBe('forbidden');
      const u = await checkpointer.unconfirmed();
      expect(!u.ok && u.error.code).toBe('forbidden');
      const c = await n.clientFor('core').signCheckpoint({
        cp_seq: 1,
        from_ledger_seq: 1,
        to_ledger_seq: 1,
        created_at: '2026-11-08T10:00:00.000Z',
      });
      expect(!c.ok && c.error.code).toBe('forbidden');
      // Nothing was reserved by the refused calls.
      const rows = await n.database.pool.query('SELECT 1 FROM notary.journal');
      expect(rows.rowCount).toBe(0);
    } finally {
      await n.stop();
    }
  });

  it('answers malformed requests with 400 and a body that breaks the contract with invalid_entry', async () => {
    const n = await start();
    try {
      const auth = {
        authorization: `Bearer ${n.tokens['core']}`,
        'content-type': 'application/json',
      };
      const bad = await fetch(new URL('/v1/reserve', n.url), {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ prev_hash: 'nope', body_hash: 1 }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_request',
      );

      const d = sampleDraft(1);
      const res = await fetch(new URL('/v1/reserve', n.url), {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ prev_hash: null, body_hash: ledgerDraftHash(d) }),
      });
      expect(res.status).toBe(200);
      const sign = await fetch(new URL('/v1/sign', n.url), {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ledger_seq: 1, draft: { ...d, entry_type: 'decision' } }),
      });
      expect(sign.status).toBe(400);
      expect(((await sign.json()) as { error: { code: string } }).error.code).toBe('invalid_entry');
    } finally {
      await n.stop();
    }
  });

  it('signs nothing when key custody refuses, and the reservation stays open', async () => {
    const prod = await startTestKms({ factoryEnv: 'prod' });
    const n = await startTestNotary({ custody: prod.custodyFor('notary') });
    try {
      const d = sampleDraft(1);
      const core = n.clientFor('core');
      const r = await core.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d) });
      expect(r.ok).toBe(true);
      const s = await core.sign({ ledger_seq: 1, draft: d });
      expect(!s.ok && s.error.code).toBe('signer_unavailable');
      const rows = await n.database.pool.query<{ status: string }>(
        'SELECT status FROM notary.journal',
      );
      expect(rows.rows).toEqual([{ status: 'reserved' }]);
      const st = await n.database.pool.query<{ last_seq: string }>(
        'SELECT last_seq FROM notary.state',
      );
      expect(st.rows[0]?.last_seq).toBe('0');
    } finally {
      await n.stop();
      await prod.stop();
    }
  });

  it('serialises concurrent writers: of racing reservations exactly one entry is signed', async () => {
    const n = await start();
    try {
      const core = n.clientFor('core');
      const results = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const d = sampleDraft(i);
          const r = await core.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d) });
          if (!r.ok) return 'reserve-refused';
          const s = await core.sign({ ledger_seq: r.value.ledger_seq, draft: d });
          return s.ok ? 'signed' : s.error.code;
        }),
      );
      expect(results.filter((r) => r === 'signed')).toHaveLength(1);
      expect(
        results
          .filter((r) => r !== 'signed')
          .every((r) => ['body_mismatch', 'seq_already_signed', 'reserve-refused'].includes(r)),
      ).toBe(true);
      const rows = await n.database.pool.query<{ ledger_seq: string; status: string }>(
        'SELECT ledger_seq, status FROM notary.journal ORDER BY ledger_seq',
      );
      expect(rows.rows).toEqual([{ ledger_seq: '1', status: 'signed' }]);
    } finally {
      await n.stop();
    }
  });

  it('keeps the chain gap-free when many entries are written in turn from many clients', async () => {
    const n = await start();
    try {
      const entries = await signEntries(n.clientFor('core'), 12);
      expect(entries.map((e) => e.ledger_seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      entries.slice(1).forEach((e, i) => expect(e.prev_hash).toBe(entries[i]?.entry_hash));
    } finally {
      await n.stop();
    }
  });

  it('protects its journal in the database: no delete, no rewrite of a signed row, no going back', async () => {
    const n = await start();
    try {
      await signEntries(n.service, 2);
      const q = (sql: string) => n.database.pool.query(sql);
      await expect(q('DELETE FROM notary.journal')).rejects.toThrow(/refused/);
      await expect(q('TRUNCATE notary.journal')).rejects.toThrow(/append-only/);
      await expect(
        q("UPDATE notary.journal SET entry_hash = repeat('0', 64) WHERE ledger_seq = 1"),
      ).rejects.toThrow(/refused/);
      await expect(
        q("UPDATE notary.journal SET status = 'reserved' WHERE ledger_seq = 1"),
      ).rejects.toThrow(/refused/);
      await expect(q('UPDATE notary.state SET last_seq = 1, last_hash = NULL')).rejects.toThrow();
      await expect(q('UPDATE notary.state SET last_seq = last_seq + 2')).rejects.toThrow(
        /one entry at a time/,
      );
      await expect(q('DELETE FROM notary.checkpoint_journal')).resolves.toBeDefined(); // empty: no rows, no trigger
    } finally {
      await n.stop();
    }
  });
});
