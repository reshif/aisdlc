import { checkpointDigestHex } from '@aisdlc/contracts';
import { b64urlEncode } from '@aisdlc/kernel';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { FakeNotary, hexBytes } from '@aisdlc/ports';
import {
  checkpointRequest,
  signEntries,
  witnessConformance,
  type WitnessHarness,
} from '@aisdlc/ports/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpWitness } from '../src/client.js';
import { WitnessService } from '../src/service.js';
import { startTestWitness, type TestWitness } from '../src/testing.js';

let kms: TestKms;
beforeAll(async () => {
  kms = await startTestKms();
});
afterAll(async () => {
  await kms.stop();
});

const T1 = '2026-11-08T10:05:00.000Z';
const T2 = '2026-11-08T10:10:00.000Z';

async function harness(
  via: 'direct' | 'http',
): Promise<WitnessHarness & { w: TestWitness; stop(): Promise<void> }> {
  const w = await startTestWitness({ custody: kms.custodyFor('witness') });
  // The notary here is a FakeNotary over the real kms-local notary key: real signatures, no service.
  const notaryCustody = kms.custodyFor('notary');
  const key = async (id: string) => {
    const k = await kms.custodyFor('witness').publicKey(id);
    if (!k.ok) throw new Error(k.error.message);
    return k.value;
  };
  return {
    w,
    witness: via === 'direct' ? w.service : w.clientFor('checkpointer'),
    notary: new FakeNotary(notaryCustody),
    forkedNotary: new FakeNotary(notaryCustody),
    notaryKey: () => key('dev:notary'),
    witnessKey: () => key('dev:witness'),
    signAsNotary: async (core) => {
      const s = await notaryCustody.sign('dev:notary', hexBytes(checkpointDigestHex(core)));
      if (!s.ok) throw new Error(s.error.message);
      return { key_id: 'dev:notary', alg: 'ES256', value: b64urlEncode(s.value) };
    },
    stop: () => w.stop(),
  };
}

witnessConformance('WitnessService (direct)', () => harness('direct'));
witnessConformance('HttpWitness (real HTTP, real kms-local)', () => harness('http'));

describe('witness service', () => {
  it('refuses callers without a token, with a wrong token, or not on its list', async () => {
    const h = await harness('http');
    try {
      expect((await fetch(new URL('/v1/last', h.w.url))).status).toBe(401);
      const wrong = new HttpWitness({ baseUrl: h.w.url, token: 'z'.repeat(40) });
      const a = await wrong.last();
      expect(!a.ok && a.error.code).toBe('unauthenticated');
      const core = h.w.clientFor('core'); // authenticated, but only the checkpointer may call
      const b = await core.last();
      expect(!b.ok && b.error.code).toBe('forbidden');
      const entries = await signEntries(h.notary, 2);
      const c = await core.cosign(await checkpointRequest(h.notary, entries, 1, 0, 2, T1));
      expect(!c.ok && c.error.code).toBe('forbidden');
      const rows = await h.w.database.pool.query('SELECT 1 FROM witness.cosigned');
      expect(rows.rowCount).toBe(0);
    } finally {
      await h.stop();
    }
  });

  it('answers a malformed request with 400', async () => {
    const h = await harness('http');
    try {
      const res = await fetch(new URL('/v1/cosign', h.w.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.w.tokens.checkpointer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ core: {}, entries: 'x' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await h.stop();
    }
  });

  it('keeps its state across a restart: the next checkpoint is still checked against the last', async () => {
    const h = await harness('direct');
    try {
      const entries = await signEntries(h.notary, 6);
      expect(
        (await h.witness.cosign(await checkpointRequest(h.notary, entries, 1, 0, 3, T1))).ok,
      ).toBe(true);
      // A new service object over the same database has no memory but the rows.
      const again = new WitnessService({
        pool: h.w.database.pool,
        custody: kms.custodyFor('witness'),
      });
      const bad = await again.cosign(await checkpointRequest(h.notary, entries, 2, 0, 5, T2));
      expect(!bad.ok && bad.error.code).toBe('entries_invalid'); // does not start at its stored head
      const good = await again.cosign(await checkpointRequest(h.notary, entries, 2, 3, 6, T2));
      expect(good.ok).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it('signs nothing when key custody refuses', async () => {
    const prod = await startTestKms({ factoryEnv: 'prod' });
    const w = await startTestWitness({ custody: prod.custodyFor('witness') });
    try {
      const notary = new FakeNotary(kms.custodyFor('notary'));
      const entries = await signEntries(notary, 2);
      const r = await w.service.cosign(await checkpointRequest(notary, entries, 1, 0, 2, T1));
      expect(!r.ok && r.error.code).toBe('signer_unavailable');
      expect((await w.database.pool.query('SELECT 1 FROM witness.cosigned')).rowCount).toBe(0);
    } finally {
      await w.stop();
      await prod.stop();
    }
  });

  it('protects its table in the database: no rewrite, no delete, no gap, no shrink', async () => {
    const h = await harness('direct');
    try {
      const entries = await signEntries(h.notary, 4);
      expect(
        (await h.witness.cosign(await checkpointRequest(h.notary, entries, 1, 0, 2, T1))).ok,
      ).toBe(true);
      const q = (sql: string) => h.w.database.pool.query(sql);
      await expect(q('DELETE FROM witness.cosigned')).rejects.toThrow(/append-only/);
      await expect(q("UPDATE witness.cosigned SET root_hash = repeat('0', 64)")).rejects.toThrow(
        /append-only/,
      );
      await expect(q('TRUNCATE witness.cosigned')).rejects.toThrow(/append-only/);
      const copy = (seq: number, to: number) =>
        q(
          `INSERT INTO witness.cosigned SELECT ${seq}, ${to}, root_hash, head_hash, frontier, checkpoint, cosigned_at FROM witness.cosigned WHERE cp_seq = 1`,
        );
      await expect(copy(3, 3)).rejects.toThrow(/advance by one/);
      await expect(copy(2, 1)).rejects.toThrow(/never shrink/);
      await expect(copy(2, 2)).resolves.toBeDefined();
    } finally {
      await h.stop();
    }
  });
});
