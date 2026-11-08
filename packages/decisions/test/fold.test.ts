import { describe, expect, it } from 'vitest';
import { foldDecisions, type DecisionRow } from '../src/index.js';

const H = 'a'.repeat(64);
let n = 0;
const row = (
  decision: DecisionRow['decision'],
  actor: string,
  over: Partial<DecisionRow> = {},
): DecisionRow => ({
  ledger_seq: ++n,
  entry_id: `e${n}`,
  subject_hash: H,
  decision,
  actor,
  sod_waiver: false,
  created_at: `2026-11-08T10:00:0${n % 10}.000Z`,
  body: {},
  ...over,
});
const fold = (q: number, rows: DecisionRow[]) =>
  foldDecisions({ subject_hash: H, quorum_required: q }, rows);

describe('foldDecisions (status is a fold of ledger decisions)', () => {
  it('is pending with no decisions', () => {
    expect(fold(1, [])).toMatchObject({ status: 'pending', outcome: null, approvers: [] });
  });
  it('one approval decides a quorum-1 gate', () => {
    expect(fold(1, [row('approve', 'ann')])).toMatchObject({
      status: 'decided',
      outcome: 'approve',
      approvers: ['ann'],
    });
  });
  it('quorum 2: a repeat by the same principal counts once', () => {
    const f = fold(2, [row('approve', 'ann'), row('approve', 'ann')]);
    expect(f).toMatchObject({ status: 'pending', approvers: ['ann'] });
    expect(
      fold(2, [row('approve', 'ann'), row('approve', 'ann'), row('approve', 'bob')]),
    ).toMatchObject({
      status: 'decided',
      approvers: ['ann', 'bob'],
    });
  });
  it('reject and request_changes end the gate at once', () => {
    expect(fold(2, [row('approve', 'ann'), row('reject', 'bob')])).toMatchObject({
      status: 'decided',
      outcome: 'reject',
    });
    expect(fold(2, [row('request_changes', 'bob')])).toMatchObject({
      status: 'decided',
      outcome: 'request_changes',
    });
  });
  it('a decided instance is never changed by a later entry', () => {
    const f = fold(1, [
      row('approve', 'ann'),
      row('expire', 'system.sweep'),
      row('withdraw', 'ann'),
      row('reject', 'bob'),
      row('supersede', 'system.gate'),
    ]);
    expect(f).toMatchObject({ status: 'decided', outcome: 'approve', approvers: ['ann'] });
  });
  it('an expired instance stays expired, an approval after expiry does not approve', () => {
    expect(fold(1, [row('expire', 'system.sweep'), row('approve', 'ann')])).toMatchObject({
      status: 'expired',
      outcome: null,
    });
  });
  it('supersede, expire and withdraw end the gate as superseded, expired and closed', () => {
    const to = '0190aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    expect(
      fold(1, [row('supersede', 'system.gate', { body: { superseded_by: to } })]),
    ).toMatchObject({ status: 'superseded', superseded_by: to });
    expect(fold(1, [row('expire', 'system.sweep')]).status).toBe('expired');
    expect(fold(1, [row('withdraw', 'ann')]).status).toBe('closed');
  });
  it('ignores an entry bound to another subject hash', () => {
    expect(fold(1, [row('approve', 'ann', { subject_hash: 'b'.repeat(64) })]).status).toBe(
      'pending',
    );
  });
  it('an approval by a system actor counts for nothing', () => {
    expect(fold(1, [row('approve', 'system.sweep')]).status).toBe('pending');
  });
  it('orders by ledger_seq whatever order the rows come in', () => {
    const a = row('reject', 'bob');
    const b = row('approve', 'ann');
    expect(fold(1, [b, a]).outcome).toBe('reject');
  });
});
