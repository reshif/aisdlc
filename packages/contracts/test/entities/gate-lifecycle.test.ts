import { describe, expect, it } from 'vitest';
import {
  DecisionBody,
  GATE_EVENT,
  GateEventType,
  GateOpenedPayload,
  GateIdValues,
  GATE_POLICIES,
  KILL_RELEASE_POLICY,
  RoleSlotValues,
  gatePolicy,
  stepUpOf,
  gateStream,
} from '../../src/index.js';

const H = 'a'.repeat(64);
const U = '0190aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const opened = {
  gate_instance_id: U,
  gate_id: 'M4',
  project_id: 'proj',
  subject_kind: 's0_record',
  subject_id: U,
  subject_hash: H,
  evidence_pack_hash: null,
  requester: null,
  facts: { expires_at: '2026-11-15T10:00:00.000Z' },
  quorum: { required: 2, slot: 'm4', basis: 'two_person' },
  step_up: { required: true, bound_hash: H },
  supersedes: null,
  opened_by: 'system.gate',
};

describe('gate lifecycle contracts', () => {
  it('parses a gate.opened payload and refuses a missing expires_at or an unknown quorum basis', () => {
    expect(GateOpenedPayload.safeParse(opened).success).toBe(true);
    expect(GateOpenedPayload.safeParse({ ...opened, facts: {} }).success).toBe(false);
    expect(GateOpenedPayload.safeParse({ ...opened, facts: { expires_at: 'soon' } }).success).toBe(
      false,
    );
    expect(
      GateOpenedPayload.safeParse({ ...opened, quorum: { ...opened.quorum, basis: 'x' } }).success,
    ).toBe(false);
    expect(
      GateOpenedPayload.safeParse({ ...opened, quorum: { ...opened.quorum, required: 0 } }).success,
    ).toBe(false);
    expect(GateOpenedPayload.safeParse({ ...opened, subject_kind: 'repo' }).success).toBe(false);
  });

  it('decision bodies are discriminated by kind', () => {
    expect(
      DecisionBody.safeParse({ kind: 'expire', expires_at: '2026-11-15T10:00:00.000Z' }).success,
    ).toBe(true);
    expect(DecisionBody.safeParse({ kind: 'withdraw', reason: '' }).success).toBe(false);
    expect(DecisionBody.safeParse({ kind: 'approve' }).success).toBe(false);
  });

  it('every gate has a policy on an existing slot; event types and streams are stable', () => {
    for (const g of GateIdValues) expect(RoleSlotValues).toContain(GATE_POLICIES[g].slot);
    expect(gatePolicy('kill_release')).toBe(KILL_RELEASE_POLICY);
    expect(GateEventType.options.sort()).toEqual(Object.values(GATE_EVENT).sort());
    expect(gateStream(U)).toBe(`gate:${U}`);
  });
});

describe('stepUpOf (RC-SEC-4): a gate that needs two people needs each to step up', () => {
  const h = 'a'.repeat(64);
  const p = (required: number, stepUp: boolean) => ({
    quorum: {
      required,
      slot: 'x',
      basis: required >= 2 ? 'two_person' : 'single',
    } as never,
    step_up: { required: stepUp, bound_hash: h } as never,
  });
  it('is required for a quorum of two or more, even on a payload opened without it', () => {
    expect(stepUpOf(p(2, false))).toEqual({ required: true, bound_hash: h });
    expect(stepUpOf(p(3, false)).required).toBe(true);
  });
  it('follows the payload for a single decider', () => {
    expect(stepUpOf(p(1, false)).required).toBe(false);
    expect(stepUpOf(p(1, true)).required).toBe(true);
  });
});
