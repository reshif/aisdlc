import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@aisdlc/kernel';
import {
  Card,
  Checkpoint,
  ConfigRevision,
  CatalogueRef,
  GateInstance,
  GateVote,
  LedgerEntry,
  OnboardingStep,
  RecordEvent,
  S0Record,
  WorkItem,
  WorkRequest,
  cardPayloadHash,
} from '../../src/index.js';
import { CAT, H, T0, U1, U2, U3, U4, card } from './fixtures.js';

const sig = { key_id: 'k1', alg: 'ES256', value: 'abc_DEF-123' };

describe('onboarding', () => {
  const s0 = {
    s0_id: U1,
    project_id: 'acme-web',
    repo_id: 'r1',
    status: 'running',
    requested_level: 'light',
    intake_ref: 'record:evt-1',
    rejected_at: null,
    readiness_version: null,
    catalogue_ref: CAT,
    version: 1,
    created_at: T0,
    updated_at: T0,
  };
  it('S0Record round-trips and stores the catalogue pin', () => {
    expect(S0Record.parse(s0)).toEqual(s0);
    expect(S0Record.safeParse({ ...s0, status: 'nope' }).success).toBe(false);
    expect(S0Record.safeParse({ ...s0, intake_ref: 'g0:abc' }).success).toBe(false);
    expect(S0Record.safeParse({ ...s0, rejected_at: '1.1' }).success).toBe(false);
    const noPin = Object.fromEntries(Object.entries(s0).filter(([k]) => k !== 'catalogue_ref'));
    expect(S0Record.safeParse(noPin).success).toBe(false);
    expect(
      S0Record.safeParse({ ...s0, catalogue_ref: { version: '1.0', hash: CAT.hash } }).success,
    ).toBe(false);
  });

  it('OnboardingStep round-trips; blocked carries a cause code', () => {
    const st = {
      s0_id: U1,
      step: '0.1',
      state: 'running',
      blocked_cause: null,
      started_at: T0,
      finished_at: null,
    };
    expect(OnboardingStep.parse(st)).toEqual(st);
    expect(OnboardingStep.safeParse({ ...st, step: '1.1' }).success).toBe(false);
    expect(OnboardingStep.safeParse({ ...st, state: 'blocked' }).success).toBe(false);
    expect(
      OnboardingStep.safeParse({ ...st, state: 'blocked', blocked_cause: 'detector_crash' })
        .success,
    ).toBe(true);
    expect(OnboardingStep.safeParse({ ...st, blocked_cause: 'detector_crash' }).success).toBe(
      false,
    );
  });

  it('Card round-trips, carries several decisions and list payloads, binds the payload hash', () => {
    const c = card();
    expect(Card.parse(c)).toEqual(c);
    expect(c.decisions).toHaveLength(2);
    expect(Card.safeParse({ ...c, payload_hash: H('x') }).success).toBe(false);
    expect(Card.safeParse({ ...c, role: 'requesters' }).success).toBe(false);
    expect(Card.safeParse({ ...c, card: 'C9' }).success).toBe(false);
    expect(Card.safeParse({ ...c, decisions: [] }).success).toBe(false);
    // decided needs a ledger entry per decision
    expect(Card.safeParse({ ...c, status: 'decided' }).success).toBe(false);
    const decided = {
      ...c,
      status: 'decided',
      decisions: c.decisions.map((d) => ({ ...d, decision: 'approve', ledger_entry_id: U2 })),
    };
    expect(Card.safeParse(decided).success).toBe(true);
  });

  it('a 50-row payload hashes to one value that changes with any row', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      kind: 'claim_verdict' as const,
      claim_id: `c${i}`,
      verdict: 'affirm' as const,
    }));
    const h = cardPayloadHash(rows);
    expect(h).toBe(hashCanonical(rows));
    const changed = rows.map((r, i) => (i === 49 ? { ...r, verdict: 'unknown' as const } : r));
    expect(cardPayloadHash(changed)).not.toBe(h);
    const c = card({ payload: rows, payload_hash: h });
    expect(Card.safeParse(c).success).toBe(true);
  });
});

describe('decisions', () => {
  const event = {
    event_id: U1,
    stream_id: U2,
    stream_seq: 1,
    global_seq: 10,
    type: 'item.created',
    payload: { a: 1 },
    actor: 'system:test',
    occurred_at: T0,
    idempotency_key: 'k',
    prev_hash: '0'.repeat(64),
    hash: H('e1'),
  };
  it('RecordEvent round-trips; only the first event links to the genesis hash', () => {
    expect(RecordEvent.parse(event)).toEqual(event);
    expect(RecordEvent.safeParse({ ...event, stream_seq: 2 }).success).toBe(false);
    expect(RecordEvent.safeParse({ ...event, stream_seq: 2, prev_hash: H('e0') }).success).toBe(
      true,
    );
    expect(RecordEvent.safeParse({ ...event, prev_hash: H('e0') }).success).toBe(false);
    expect(RecordEvent.safeParse({ ...event, prev_hash: null }).success).toBe(false);
    expect(RecordEvent.safeParse({ ...event, actor: '' }).success).toBe(false);
    expect(
      RecordEvent.safeParse({ ...event, stream_seq: 2, prev_hash: '0'.repeat(64) }).success,
    ).toBe(false);
    expect(RecordEvent.safeParse({ ...event, type: 'Item Created' }).success).toBe(false);
    expect(RecordEvent.safeParse({ ...event, hash: 'zz' }).success).toBe(false);
  });

  const gi = {
    gate_instance_id: U1,
    gate_id: 'M4',
    subject_kind: 's0_record',
    subject_id: U2,
    subject_hash: H('s'),
    evidence_pack_hash: null,
    status: 'pending',
    facts: {},
    opened_at: T0,
    decided_at: null,
  };
  it('GateInstance round-trips with item or s0_record subjects and the status enum', () => {
    expect(GateInstance.parse(gi)).toEqual(gi);
    expect(GateInstance.safeParse({ ...gi, subject_kind: 'access' }).success).toBe(false);
    expect(GateInstance.safeParse({ ...gi, gate_id: 'G99' }).success).toBe(false);
    expect(GateInstance.safeParse({ ...gi, status: 'approved' }).success).toBe(false);
    expect(GateInstance.safeParse({ ...gi, status: 'decided' }).success).toBe(false);
    expect(GateInstance.safeParse({ ...gi, status: 'decided', decided_at: T0 }).success).toBe(true);
    expect(GateInstance.safeParse({ ...gi, decided_at: T0 }).success).toBe(false);
    expect(GateInstance.safeParse({ ...gi, status: 'expired' }).success).toBe(true);
  });

  it('GateVote round-trips; only the three quorum decisions are votes', () => {
    const v = { gate_instance_id: U1, approver: 'alice', decision: 'approve', ledger_entry_id: U2 };
    expect(GateVote.parse(v)).toEqual(v);
    expect(GateVote.safeParse({ ...v, decision: 'expire' }).success).toBe(false);
  });

  const entry = {
    entry_id: U1,
    ledger_seq: 2,
    entry_type: 'decision',
    gate_instance_id: U2,
    gate_id: 'G4',
    subject_kind: 'item',
    subject_id: U3,
    subject_hash: H('s'),
    decision: 'approve',
    actor: 'alice',
    sod_waiver: false,
    policy_bundle_version: 'roles-2.0.0',
    body: {},
    prev_hash: H('p'),
    entry_hash: H('h'),
    notary: sig,
    created_at: T0,
  };
  it('LedgerEntry round-trips; decision entries need every gate field', () => {
    expect(LedgerEntry.parse(entry)).toEqual(entry);
    expect(LedgerEntry.safeParse({ ...entry, decision: 'maybe' }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...entry, gate_id: null }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...entry, notary: { ...sig, alg: 'HS256' } }).success).toBe(
      false,
    );
    expect(LedgerEntry.safeParse({ ...entry, ledger_seq: 1 }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...entry, ledger_seq: 1, prev_hash: null }).success).toBe(true);
    const publish = {
      ...entry,
      entry_type: 'config_publish',
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      subject_hash: null,
      decision: null,
      actor: null,
    };
    expect(LedgerEntry.safeParse(publish).success).toBe(true);
    expect(LedgerEntry.safeParse({ ...entry, sod_waiver: 'no' }).success).toBe(false);
  });

  it('Checkpoint round-trips and needs the Witness co-signature', () => {
    const cp = {
      cp_seq: 1,
      from_ledger_seq: 1,
      to_ledger_seq: 5,
      head_hash: H('head'),
      signatures: [
        { signer: 'notary', signature: sig },
        { signer: 'witness', signature: { ...sig, key_id: 'w1' } },
      ],
      created_at: T0,
    };
    expect(Checkpoint.parse(cp)).toEqual(cp);
    expect(Checkpoint.safeParse({ ...cp, signatures: [cp.signatures[0]] }).success).toBe(false);
    expect(Checkpoint.safeParse({ ...cp, to_ledger_seq: 0 }).success).toBe(false);
  });
});

describe('config and work', () => {
  it('ConfigRevision round-trips', () => {
    const r = {
      rev_hash: H('r2'),
      layer: 'catalogue',
      scope: { kind: 'fleet', ref: '*' },
      previous_rev_hash: H('r1'),
      state: 'current',
      ledger_entry_id: U4,
      content: { x: 1 },
      published_at: T0,
    };
    expect(ConfigRevision.parse(r)).toEqual(r);
    expect(ConfigRevision.safeParse({ ...r, state: 'draft' }).success).toBe(false);
    expect(ConfigRevision.safeParse({ ...r, previous_rev_hash: r.rev_hash }).success).toBe(false);
    expect(ConfigRevision.safeParse({ ...r, scope: { kind: 'fleet', ref: 'x' } }).success).toBe(
      false,
    );
  });

  it('CatalogueRef needs a semver version and a sha256', () => {
    expect(CatalogueRef.parse(CAT)).toEqual(CAT);
    expect(CatalogueRef.safeParse({ ...CAT, hash: 'abc' }).success).toBe(false);
    expect(CatalogueRef.safeParse({ version: 'v1', hash: CAT.hash }).success).toBe(false);
    expect(CatalogueRef.safeParse({ ...CAT, extra: 1 }).success).toBe(false);
  });

  it('WorkRequest and WorkItem carry the pin', () => {
    const req = {
      request_id: U1,
      project_id: 'acme-web',
      channel: 'N1',
      requester: 'alice',
      received_at: T0,
      catalogue_ref: CAT,
    };
    expect(WorkRequest.parse(req)).toEqual(req);
    expect(WorkRequest.safeParse({ ...req, channel: 'N9' }).success).toBe(false);
    const noPin = Object.fromEntries(Object.entries(req).filter(([k]) => k !== 'catalogue_ref'));
    expect(WorkRequest.safeParse(noPin).success).toBe(false);
    const item = {
      item_id: U2,
      project_id: 'acme-web',
      request_id: U1,
      phase: 'S1',
      lane: null,
      stage: 'S1',
      owner_of_record: null,
      tier: null,
      catalogue_ref: CAT,
    };
    expect(WorkItem.parse(item)).toEqual(item);
    expect(WorkItem.safeParse({ ...item, phase: 'Nowhere' }).success).toBe(false);
    expect(WorkItem.safeParse({ ...item, catalogue_ref: undefined }).success).toBe(false);
    expect(WorkItem.safeParse({ ...item, lane: 'L9' }).success).toBe(false);
  });
});
