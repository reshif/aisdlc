// Entrypoint of the M2 exit demo (`dist/demo-writer.js`, run by `scripts/demo-ledger.mjs`). It is
// the "core" side of the ledger: migrates the record database, writes entries through the real
// ledger writer to the Notary over HTTP, runs one checkpoint round against the Notary and the
// Witness, and prints one JSON line. It is not a service and holds no key.
import { LedgerEntryDraft } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { newId } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  requiredEnv,
  resolveSecretRef,
  type Env,
} from '@aisdlc/service-kit';
import { HttpWitness } from '@aisdlc/witness/client';
import { appendLedgerEntry } from './writer.js';
import { runCheckpoint } from './checkpoint.js';
import { reconcileLedger } from './reconcile.js';
import { migrateLedger } from './migrations.js';

const token = (env: Env, name: string): string => resolveSecretRef(requiredEnv(env, name), { env });

async function run(env: Env): Promise<void> {
  const dbUrl = databaseUrl(env, 'LEDGER_DB_URL');
  const count = Number(env['DEMO_ENTRIES'] ?? 10);
  if (!Number.isInteger(count) || count < 1) throw new ServiceConfigError('DEMO_ENTRIES');
  const core = new HttpNotary({
    baseUrl: httpUrlEnv(env, 'NOTARY_URL'),
    token: token(env, 'NOTARY_CORE_TOKEN_REF'),
  });
  const checkpointerNotary = new HttpNotary({
    baseUrl: httpUrlEnv(env, 'NOTARY_URL'),
    token: token(env, 'NOTARY_CHECKPOINTER_TOKEN_REF'),
  });
  const witness = new HttpWitness({
    baseUrl: httpUrlEnv(env, 'WITNESS_URL'),
    token: token(env, 'WITNESS_CHECKPOINTER_TOKEN_REF'),
  });
  // Any authenticated caller may read a public key; the writer then checks every signature.
  const notaryKey = await httpKeyCustodyFromEnv(env).publicKey('dev:notary');
  if (!notaryKey.ok) throw new Error(`notary public key: ${notaryKey.error.message}`);

  const pool = createPool(dbUrl, 5);
  try {
    const migrated = await migrateLedger(pool);
    const deps = { notary: core, notaryKey: notaryKey.value };
    for (let n = 1; n <= count; n++) {
      const draft = LedgerEntryDraft.parse({
        entry_id: newId<'LedgerEntry'>(),
        entry_type: 'config_publish',
        gate_instance_id: null,
        gate_id: null,
        subject_kind: null,
        subject_id: null,
        subject_hash: null,
        decision: null,
        actor: null,
        sod_waiver: false,
        policy_bundle_version: 'roles-2.0.0',
        body: { demo: true, n },
        created_at: new Date().toISOString(),
      });
      const r = await appendLedgerEntry(pool, deps, draft);
      if (!r.ok) throw new Error(`entry ${n}: [${r.error.code}] ${r.error.message}`);
    }
    const rec = await reconcileLedger(pool, deps);
    if (!rec.ok) throw new Error(`reconcile: [${rec.error.code}] ${rec.error.message}`);
    const cp = await runCheckpoint(pool, { notary: checkpointerNotary, witness });
    if (!cp.ok) throw new Error(`checkpoint: [${cp.error.code}] ${cp.error.message}`);
    console.log(
      JSON.stringify({
        migrations: migrated.applied.length,
        entries: count,
        reconciled: rec.value,
        checkpoint: cp.value.kind === 'created' ? cp.value.checkpoint.cp_seq : null,
      }),
    );
  } finally {
    await pool.end();
  }
}

try {
  await run(process.env);
} catch (e) {
  console.error(`demo-writer: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof ServiceConfigError ? 78 : 1;
}
