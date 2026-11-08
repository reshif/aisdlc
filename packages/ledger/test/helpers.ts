import { checkpointDigestHex } from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { b64urlEncode, type Clock, type Jwk } from '@aisdlc/kernel';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import { hexBytes, type NotaryPort, type WitnessPort } from '@aisdlc/ports';
import { sampleDraft } from '@aisdlc/ports/testing';
import { startTestWitness, type TestWitness } from '@aisdlc/witness/testing';
import type { PoolClient } from 'pg';
import { migrateLedger } from '../src/index.js';
import type { LedgerClientDeps } from '../src/index.js';

export interface Stack {
  /** The record database (ledger schema migrated). */
  record: TestDatabase;
  kms: TestKms;
  notary: TestNotary;
  witness: TestWitness;
  /** What core uses: reserve, sign, confirm, unconfirmed. */
  coreNotary: NotaryPort;
  /** What the checkpointer uses. */
  checkpointerNotary: NotaryPort;
  checkpointerWitness: WitnessPort;
  deps: LedgerClientDeps;
  keys: { notary: Jwk; witness: Jwk };
  /** Signs any checkpoint core as the Witness or Notary key holder (for forging in tests). */
  signWith(
    signer: 'notary' | 'witness',
    core: Parameters<typeof checkpointDigestHex>[0],
  ): Promise<string>;
  stop(): Promise<void>;
}

/** Three real services over HTTP on random ports, three real databases, one real KMS. */
export async function startStack(opts: { clock?: Clock } = {}): Promise<Stack> {
  const kms = await startTestKms();
  const stoppers: Array<() => Promise<void>> = [() => kms.stop()];
  try {
    const record = await createTestDatabase();
    stoppers.push(() => record.drop());
    await migrateLedger(record.pool);
    const notary = await startTestNotary({
      custody: kms.custodyFor('notary'),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    stoppers.push(() => notary.stop());
    const witness = await startTestWitness({
      custody: kms.custodyFor('witness'),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    stoppers.push(() => witness.stop());

    const key = async (id: string): Promise<Jwk> => {
      const k = await kms.custodyFor('witness').publicKey(id);
      if (!k.ok) throw new Error(k.error.message);
      return k.value;
    };
    const keys = { notary: await key('dev:notary'), witness: await key('dev:witness') };
    const coreNotary = notary.clientFor('core');
    return {
      record,
      kms,
      notary,
      witness,
      coreNotary,
      checkpointerNotary: notary.clientFor('checkpointer'),
      checkpointerWitness: witness.clientFor('checkpointer'),
      deps: { notary: coreNotary, notaryKey: keys.notary },
      keys,
      async signWith(signer, core) {
        const r = await kms
          .custodyFor(signer)
          .sign(`dev:${signer}`, hexBytes(checkpointDigestHex(core)));
        if (!r.ok) throw new Error(r.error.message);
        return b64urlEncode(r.value);
      },
      async stop() {
        // Reverse order: services before the databases and the KMS they use.
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

export const draft = (n: number, at?: string) => sampleDraft(n, at);

/** Runs `fn` with all triggers off in a transaction that is rolled back: tamper, verify, undo. */
export async function tampered<T>(
  record: TestDatabase,
  tamper: string[],
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await record.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const sql of tamper) await c.query(sql);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** A NotaryPort that forwards to `base` except where `o` overrides (class instances do not spread). */
export const wrapNotary = (base: NotaryPort, o: Partial<NotaryPort>): NotaryPort => ({
  reserve: (r) => base.reserve(r),
  sign: (r) => base.sign(r),
  confirm: (r) => base.confirm(r),
  unconfirmed: () => base.unconfirmed(),
  signCheckpoint: (r) => base.signCheckpoint(r),
  verify: (e) => base.verify(e),
  ...o,
});
