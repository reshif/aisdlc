import { PrincipalId, ProjectId, type RoleSlot } from '@aisdlc/contracts';
import { ConfigRegistry, migrateConfig, type ConfigDeps } from '@aisdlc/config';
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
import { registerPdpConfig } from '../src/index.js';

// A real stack for the config-published bundle: record, ledger, decisions and config in one
// database, a real kms-local and Notary, and a ConfigRegistry that knows `pdp.bundle`.

export const pr = (s: string): PrincipalId => PrincipalId.parse(s);
const START = '2026-11-09T10:00:00.000Z';

export interface Stack {
  record: TestDatabase;
  elig: FakeEligibility;
  clock: ManualClock;
  deps: ConfigDeps;
  stop(): Promise<void>;
}

export async function startStack(registry: ConfigRegistry): Promise<Stack> {
  const kms = await startTestKms();
  const stoppers: Array<() => Promise<void>> = [() => kms.stop()];
  try {
    const record = await createTestDatabase();
    stoppers.push(() => record.drop());
    await migrateRecord(record.pool);
    await migrateLedger(record.pool);
    await migrateDecisions(record.pool);
    await migrateConfig(record.pool);
    const clock = manualClock(START);
    const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
    stoppers.push(() => notary.stop());
    const k = await kms.custodyFor('witness').publicKey('dev:notary');
    if (!k.ok) throw new Error(k.error.message);
    const elig = new FakeEligibility();
    const deps: ConfigDeps = {
      pool: record.pool,
      ledger: { notary: notary.clientFor('core'), notaryKey: k.value },
      eligibility: elig,
      stepUp: new FakeStepUp(),
      clock,
      registry,
    };
    return {
      record,
      elig,
      clock,
      deps,
      async stop() {
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

export function factoryAdmins(s: Stack, admins: string[]): void {
  const id = ProjectId.parse('factory');
  s.elig.setPolicy(id, { tier: 'T1' });
  const slots: RoleSlot[] = [
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
  ];
  for (const slot of slots) s.elig.setHolders(id, slot, slot === 'admin' ? admins.map(pr) : []);
}

export async function decideGate(s: Stack, gate: string, principal: string, decision: string) {
  const p = await prepare(s.deps, { gate_instance_id: gate, principal: pr(principal) });
  if (!p.ok) return p;
  const v = await recordEvidenceViewed(s.deps, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  return decide(s.deps, { nonce: p.value.nonce, decision });
}

export const newRegistry = (): ConfigRegistry => registerPdpConfig(new ConfigRegistry());
