import {
  PrincipalId,
  ProjectId,
  type GateId,
  type RoleSlot,
  type Tier,
  type TwoPerson,
} from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { err, manualClock, newId, sha256Hex, type Jwk, type ManualClock } from '@aisdlc/kernel';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { LedgerWriteError, migrateLedger } from '@aisdlc/ledger';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import type { NotaryPort } from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  migrateDecisions,
  openGate,
  prepare,
  recordEvidenceViewed,
  type DecisionDeps,
  type OpenGateInput,
} from '../src/index.js';

export const pid = (s: string): ProjectId => ProjectId.parse(s);
export const pr = (s: string): PrincipalId => PrincipalId.parse(s);
export const hash = (s: string): string => sha256Hex(s);
export const uuid = (): string => newId<'WorkItem'>();

export interface Stack {
  record: TestDatabase;
  kms: TestKms;
  notary: TestNotary;
  coreNotary: NotaryPort;
  notaryKey: Jwk;
  elig: FakeEligibility;
  stepUp: FakeStepUp;
  clock: ManualClock;
  deps: DecisionDeps;
  /** The same deps with another notary client (to inject faults). */
  withNotary(n: NotaryPort): DecisionDeps;
  stop(): Promise<void>;
}

export const START = '2026-11-08T10:00:00.000Z';

/** Real kms-local, real Notary, one record database with record, ledger and decisions migrated. */
export async function startStack(): Promise<Stack> {
  const kms = await startTestKms();
  const stoppers: Array<() => Promise<void>> = [() => kms.stop()];
  try {
    const record = await createTestDatabase();
    stoppers.push(() => record.drop());
    await migrateRecord(record.pool);
    await migrateLedger(record.pool);
    await migrateDecisions(record.pool);
    const clock = manualClock(START);
    const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
    stoppers.push(() => notary.stop());
    const k = await kms.custodyFor('witness').publicKey('dev:notary');
    if (!k.ok) throw new Error(k.error.message);
    const coreNotary = notary.clientFor('core');
    const elig = new FakeEligibility();
    const stepUp = new FakeStepUp();
    const mk = (n: NotaryPort): DecisionDeps => ({
      pool: record.pool,
      ledger: { notary: n, notaryKey: k.value },
      eligibility: elig,
      stepUp,
      clock,
    });
    return {
      record,
      kms,
      notary,
      coreNotary,
      notaryKey: k.value,
      elig,
      stepUp,
      clock,
      deps: mk(coreNotary),
      withNotary: mk,
      async stop() {
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

export interface ProjectSetup {
  tier: Tier | null;
  two_person?: Partial<TwoPerson>;
  slots: Partial<Record<RoleSlot, string[]>>;
}

/** Registers a project with the fake eligibility port; unlisted slots are empty. */
export function setupProject(
  s: Stack,
  project: string,
  setup: ProjectSetup,
): ReturnType<typeof pid> {
  const id = pid(project);
  s.elig.setPolicy(id, {
    tier: setup.tier,
    ...(setup.two_person ? { two_person: setup.two_person } : {}),
  });
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
    s.elig.setHolders(id, slot, (setup.slots[slot] ?? []).map(pr));
  }
  return id;
}

export interface GateFixture {
  gate_instance_id: string;
  subject_id: string;
  subject_hash: string;
  input: OpenGateInput;
}

/** Opens a gate with fresh subject ids; throws if refused. */
export async function open(
  s: Stack,
  project: string,
  gate_id: GateId,
  over: Partial<OpenGateInput> = {},
): Promise<GateFixture> {
  const input: OpenGateInput = {
    gate_id,
    project_id: pid(project),
    subject_kind: 'item',
    subject_id: uuid(),
    subject_hash: hash(`subject-${Math.random()}`),
    ...over,
  };
  const r = await openGate(s.deps, input);
  if (!r.ok) throw new Error(`open refused: ${JSON.stringify(r.error)}`);
  return {
    gate_instance_id: r.value.gate_instance_id,
    subject_id: input.subject_id,
    subject_hash: input.subject_hash,
    input,
  };
}

/** prepare, evidence viewed, decide: the whole PreparedDecision path for one principal. */
export async function decideAs(
  s: Stack,
  gate: string,
  principal: string,
  decision: string,
  opts: {
    stepUp?: string | null;
    /** The person stepped up: a proof for the gate's bound hash and this principal (RC-SEC-4). */
    steppedUp?: boolean;
    skipEvidence?: boolean;
    deps?: DecisionDeps;
  } = {},
) {
  const deps = opts.deps ?? s.deps;
  const p = await prepare(deps, { gate_instance_id: gate, principal: pr(principal) });
  if (!p.ok) return p;
  const proof = opts.steppedUp
    ? s.stepUp.issue(p.value.step_up.bound_hash, principal)
    : opts.stepUp;
  if (!opts.skipEvidence) {
    const v = await recordEvidenceViewed(deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    if (!v.ok) return v;
  }
  return decide(deps, {
    nonce: p.value.nonce,
    decision,
    ...(proof ? { step_up: { proof } } : {}),
  });
}

/** `decideAs` options for a person who stepped up: what every vote on a two-person gate needs. */
export const STEPPED_UP = { steppedUp: true } as const;

export async function ledgerCount(s: Stack): Promise<number> {
  const q = await s.record.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ledger.ledger_entry',
  );
  return Number(q.rows[0]?.n);
}

/** What a caller returns to roll its transaction back after the Notary has signed. */
export const rolledBack = () =>
  err(LedgerWriteError({ code: 'database' as const, message: 'caller transaction rolled back' }));
