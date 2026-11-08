import { PrincipalId, ProjectId, type RoleSlot } from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { manualClock, type ManualClock } from '@aisdlc/kernel';
import { startTestKms } from '@aisdlc/kms-local/testing';
import { migrateLedger } from '@aisdlc/ledger';
import { startTestNotary } from '@aisdlc/notary/testing';
import { migrateRecord } from '@aisdlc/record';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  migrateDecisions,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import { z } from 'zod';
import { ConfigRegistry, migrateConfig, type ConfigDeps } from '../src/index.js';

export const pr = (s: string): PrincipalId => PrincipalId.parse(s);
export const pid = (s: string): ProjectId => ProjectId.parse(s);

export const START = '2026-11-09T10:00:00.000Z';

export const makeRegistry = (): ConfigRegistry =>
  new ConfigRegistry()
    .setting({
      key: 'gateway.budget_usd',
      schema: z.number().int().min(0),
      default: 100,
      overridable: true,
      description: 'per-unit budget',
    })
    .setting({
      key: 'catalogue.pin',
      schema: z.string().regex(/^\d+\.\d+\.\d+$/),
      default: '1.0.0',
      description: 'catalogue version (factory only)',
    })
    .setting({
      key: 'roles.map',
      schema: z.strictObject({ admin: z.array(z.string()).min(1) }),
      default: { admin: ['root'] },
      overridable: true,
      description: 'role map',
    })
    .opsFlag({ key: 'ops.kill.enabled', default: true, description: 'kill switch armed' })
    .opsFlag({ key: 'ops.beta', default: false, overridable: true, description: 'beta features' });

export interface Stack {
  record: TestDatabase;
  elig: FakeEligibility;
  clock: ManualClock;
  deps: ConfigDeps;
  stop(): Promise<void>;
}

/** Real kms-local, real Notary, one database with record, ledger, decisions and config migrated. */
export async function startStack(registry = makeRegistry()): Promise<Stack> {
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

export function setupProject(
  s: Stack,
  project: string,
  slots: Partial<Record<RoleSlot, string[]>>,
) {
  const id = pid(project);
  s.elig.setPolicy(id, { tier: 'T1' });
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
  ] as const) {
    s.elig.setHolders(id, slot, (slots[slot] ?? []).map(pr));
  }
}

/** prepare, evidence viewed, decide on a gate. */
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

export const ledgerCount = async (s: Stack): Promise<number> =>
  Number(
    (
      await s.record.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM ledger.ledger_entry',
      )
    ).rows[0]?.n,
  );
