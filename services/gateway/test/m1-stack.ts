import { PrincipalId, ProjectId, type RoleSlot } from '@aisdlc/contracts';
import {
  ConfigRegistry,
  migrateConfig,
  registerGatewayConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  migrateDecisions,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import { manualClock, type ManualClock } from '@aisdlc/kernel';
import { startTestKms } from '@aisdlc/kms-local/testing';
import { migrateLedger } from '@aisdlc/ledger';
import { startTestNotary } from '@aisdlc/notary/testing';
import { migrateRecord } from '@aisdlc/record';

// A real M1 stack for the routing-table tests: kms-local, the Notary, and one database with record,
// ledger, decisions and config migrated (the same stack `@aisdlc/config`'s own tests run on).

export const pr = (s: string): PrincipalId => PrincipalId.parse(s);

export interface M1Stack {
  record: TestDatabase;
  elig: FakeEligibility;
  clock: ManualClock;
  deps: ConfigDeps;
  stop(): Promise<void>;
}

export async function startM1Stack(): Promise<M1Stack> {
  const kms = await startTestKms();
  const stoppers: Array<() => Promise<void>> = [() => kms.stop()];
  try {
    const record = await createTestDatabase();
    stoppers.push(() => record.drop());
    await migrateRecord(record.pool);
    await migrateLedger(record.pool);
    await migrateDecisions(record.pool);
    await migrateConfig(record.pool);
    const clock = manualClock('2026-11-09T10:00:00.000Z');
    const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
    stoppers.push(() => notary.stop());
    const k = await kms.custodyFor('witness').publicKey('dev:notary');
    if (!k.ok) throw new Error(k.error.message);
    const elig = new FakeEligibility();
    const factory = ProjectId.parse('factory');
    elig.setPolicy(factory, { tier: 'T1' });
    for (const slot of [
      'admin',
      'requesters',
      'intent',
      'design',
      'g4',
      'g5',
      'x',
      'sec',
      'm4',
      'kill',
    ] as RoleSlot[]) {
      elig.setHolders(factory, slot, slot === 'admin' ? [pr('root'), pr('rita')] : []);
    }
    return {
      record,
      elig,
      clock,
      deps: {
        pool: record.pool,
        ledger: { notary: notary.clientFor('core'), notaryKey: k.value },
        eligibility: elig,
        stepUp: new FakeStepUp(),
        clock,
        registry: registerGatewayConfig(new ConfigRegistry()),
      },
      async stop() {
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

/** prepare, evidence viewed, decide: how a human decides an M1 gate. */
export async function decideGate(s: M1Stack, gate: string, principal: string, decision: string) {
  const p = await prepare(s.deps, { gate_instance_id: gate, principal: pr(principal) });
  if (!p.ok) return p;
  const v = await recordEvidenceViewed(s.deps, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  return decide(s.deps, { nonce: p.value.nonce, decision });
}
