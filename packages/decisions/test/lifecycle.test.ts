import { inLedgerTransaction, reconcileLedger, readLedgerEntries } from '@aisdlc/ledger';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gateInstanceProjection,
  openGate,
  readGateState,
  sweepExpired,
  withdrawGate,
  type GateProjectionSnapshot,
} from '../src/index.js';
import { applyVote, enterGate } from '../src/vote.js';
import {
  decideAs,
  hash,
  ledgerCount,
  open,
  pr,
  rolledBack,
  setupProject,
  startStack,
  uuid,
  type Stack,
} from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'proj', {
    tier: 'T0',
    slots: { g4: ['ann', 'bob'], intent: ['ann', 'bob'], design: ['bob'], admin: ['root'] },
  });
  setupProject(s, 'proj-t2', {
    tier: 'T2',
    slots: { m4: ['ann'], x: ['ann', 'bob'], g4: ['ann', 'bob'] },
  });
});
afterAll(async () => {
  await s.stop();
});

const snapshot = async (): Promise<GateProjectionSnapshot> => {
  const r = await runProjection(s.record.pool, gateInstanceProjection);
  expect(r.ok).toBe(true);
  return gateInstanceProjection.snapshot(s.record.pool);
};
const inst = async (id: string) =>
  (await snapshot()).instances.find((i) => i.gate_instance_id === id);
const DAY = 24 * 3600 * 1000;

describe('opening a gate', () => {
  it('is a record event on gate:<id>; no ledger entry; the projection shows it pending', async () => {
    const before = await ledgerCount(s);
    const g = await open(s, 'proj', 'G4', { requester: pr('carol'), facts: { note: 'x' } });
    expect(await ledgerCount(s)).toBe(before);
    const ev = await s.record.pool.query<{ type: string; seq: string; stream: string }>(
      'SELECT type, seq::text, stream FROM record.record_event WHERE stream = $1',
      [`gate:${g.gate_instance_id}`],
    );
    expect(ev.rows).toEqual([
      { type: 'gate.opened', seq: '1', stream: `gate:${g.gate_instance_id}` },
    ]);
    const i = await inst(g.gate_instance_id);
    expect(i).toMatchObject({
      gate_id: 'G4',
      status: 'pending',
      subject_kind: 'item',
      subject_id: g.subject_id,
      subject_hash: g.subject_hash,
      quorum_required: 1,
      requester: 'carol',
      outcome: null,
      decided_at: null,
    });
    expect(i?.facts).toMatchObject({ note: 'x' });
    // facts.expires_at defaults to a TTL after opening
    expect(Date.parse(i?.expires_at ?? '') - s.clock.nowMs()).toBe(7 * DAY);
  });

  it('accepts an S0 record UUID as subject (fix #32) and a given expires_at', async () => {
    const at = new Date(s.clock.nowMs() + 3600_000).toISOString();
    const g = await open(s, 'proj', 'G2', { subject_kind: 's0_record', facts: { expires_at: at } });
    expect(await inst(g.gate_instance_id)).toMatchObject({
      subject_kind: 's0_record',
      expires_at: at,
    });
  });

  it('opening twice for the same subject hash returns the same pending instance', async () => {
    const g = await open(s, 'proj', 'G4');
    const again = await openGate(s.deps, g.input);
    expect(again.ok && [again.value.gate_instance_id, again.value.opened]).toEqual([
      g.gate_instance_id,
      false,
    ]);
  });

  it('concurrent opens of the same subject make one instance', async () => {
    const input = {
      ...(await open(s, 'proj', 'G4')).input,
      subject_id: uuid(),
      subject_hash: hash('c'),
    };
    const rs = await Promise.all([1, 2, 3, 4].map(() => openGate(s.deps, input)));
    const ids = new Set(rs.map((r) => (r.ok ? r.value.gate_instance_id : 'ERR')));
    expect(ids.size).toBe(1);
    expect(rs.filter((r) => r.ok && r.value.opened)).toHaveLength(1);
  });

  it('refuses an expires_at in the past and a gate nobody can decide, writing nothing', async () => {
    const n = (await s.record.pool.query('SELECT count(*) FROM record.record_event')).rows[0].count;
    const past = await openGate(s.deps, {
      gate_id: 'G4',
      project_id: 'proj' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      subject_hash: hash('p'),
      facts: { expires_at: new Date(s.clock.nowMs() - 1).toISOString() },
    });
    expect(!past.ok && past.error.code).toBe('invalid_input');
    const nobody = await openGate(s.deps, {
      gate_id: 'G5',
      project_id: 'proj' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      subject_hash: hash('q'),
    });
    expect(!nobody.ok && nobody.error.code).toBe('quorum_infeasible');
    const unknownProject = await openGate(s.deps, {
      gate_id: 'G4',
      project_id: 'nope' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      subject_hash: hash('r'),
    });
    expect(!unknownProject.ok && unknownProject.error.code).toBe('eligibility_unavailable');
    expect(
      (await s.record.pool.query('SELECT count(*) FROM record.record_event')).rows[0].count,
    ).toBe(n);
  });

  it('a T2 single-person M4 is refused at open (no waiver exists for T2)', async () => {
    const r = await openGate(s.deps, {
      gate_id: 'M4',
      project_id: 'proj-t2' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      subject_hash: hash('m4'),
    });
    expect(!r.ok && r.error.code).toBe('quorum_infeasible');
  });
});

describe('superseding', () => {
  it('reopening with a new subject hash supersedes the pending instance with a ledger decision', async () => {
    const old = await open(s, 'proj', 'G2', { subject_kind: 's0_record' });
    const before = await ledgerCount(s);
    const r = await openGate(s.deps, {
      ...old.input,
      subject_hash: hash('v2'),
      opened_by: 'system.gate',
    });
    expect(r.ok && r.value.opened).toBe(true);
    if (!r.ok) return;
    expect(r.value.superseded).toEqual([old.gate_instance_id]);
    expect(await ledgerCount(s)).toBe(before + 1);

    const [entry] = await readLedgerEntries(s.record.pool, before + 1, before + 1);
    expect(entry).toMatchObject({
      entry_type: 'decision',
      decision: 'supersede',
      gate_instance_id: old.gate_instance_id,
      subject_hash: old.subject_hash,
      gate_id: 'G2',
      sod_waiver: false,
    });
    expect(entry?.body).toMatchObject({
      kind: 'supersede',
      superseded_by: r.value.gate_instance_id,
      new_subject_hash: hash('v2'),
    });

    const snap = await snapshot();
    const o = snap.instances.find((i) => i.gate_instance_id === old.gate_instance_id);
    const n = snap.instances.find((i) => i.gate_instance_id === r.value.gate_instance_id);
    expect(o).toMatchObject({ status: 'superseded', superseded_by: r.value.gate_instance_id });
    expect(n).toMatchObject({
      status: 'pending',
      supersedes: old.gate_instance_id,
      subject_hash: hash('v2'),
    });
    // markers on the old stream
    expect(
      snap.events.filter((e) => e.gate_instance_id === old.gate_instance_id).map((e) => e.type),
    ).toEqual(['gate.superseded']);
  });

  it('does not supersede a decided instance: a new instance opens and the old one is untouched', async () => {
    const g = await open(s, 'proj', 'G4', { requester: pr('carol') });
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
    const r = await openGate(s.deps, { ...g.input, subject_hash: hash('after-decision') });
    expect(r.ok && [r.value.opened, r.value.superseded]).toEqual([true, []]);
    expect((await inst(g.gate_instance_id))?.status).toBe('decided');
  });
});

describe('TTL sweep', () => {
  it('expires pending instances past facts.expires_at with an expire ledger decision, and never approves', async () => {
    const at = new Date(s.clock.nowMs() + 60_000).toISOString();
    const due = await open(s, 'proj', 'G4', { facts: { expires_at: at } });
    const later = await open(s, 'proj', 'G4', {
      facts: { expires_at: new Date(s.clock.nowMs() + 10 * DAY).toISOString() },
    });
    const before = await ledgerCount(s);

    const none = await sweepExpired(s.deps);
    expect(none.ok && none.value.expired.includes(due.gate_instance_id)).toBe(false);
    s.clock.advance(61_000);
    const r = await sweepExpired(s.deps);
    expect(r.ok && r.value.expired).toContain(due.gate_instance_id);
    expect(r.ok && r.value.expired).not.toContain(later.gate_instance_id);

    const entries = await readLedgerEntries(s.record.pool, before + 1, await ledgerCount(s));
    const mine = entries.find((e) => e.gate_instance_id === due.gate_instance_id);
    expect(mine).toMatchObject({ decision: 'expire', actor: 'system.sweep', sod_waiver: false });
    expect(await inst(due.gate_instance_id)).toMatchObject({ status: 'expired', outcome: null });
    expect((await inst(later.gate_instance_id))?.status).toBe('pending');
    expect(
      (await snapshot()).events
        .filter((e) => e.gate_instance_id === due.gate_instance_id)
        .map((e) => e.type),
    ).toEqual(['gate.expired']);

    // idempotent: a second sweep finds nothing to do for it
    const again = await sweepExpired(s.deps);
    expect(again.ok && again.value.expired).not.toContain(due.gate_instance_id);
    // and a decision on an expired gate is refused
    const late = await decideAs(s, due.gate_instance_id, 'ann', 'approve');
    expect(!late.ok && late.error.code).toBe('gate_not_pending');
    s.clock.advance(-61_000);
  });

  it('a vote past expires_at is refused even before the sweep wrote the expire entry', async () => {
    const at = new Date(s.clock.nowMs() + 120_000).toISOString();
    const g = await open(s, 'proj', 'G4', { facts: { expires_at: at } });
    s.clock.advance(121_000);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(!r.ok && r.error.code).toBe('gate_expired');
    s.clock.advance(-121_000);
  });

  it('never touches a decided instance, even when the decision happened before expiry and the TTL has passed', async () => {
    const at = new Date(s.clock.nowMs() + 60_000).toISOString();
    const g = await open(s, 'proj', 'G4', { facts: { expires_at: at } });
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'reject')).ok).toBe(true);
    const mine = async () =>
      (
        await s.record.pool.query('SELECT 1 FROM ledger.ledger_entry WHERE gate_instance_id = $1', [
          g.gate_instance_id,
        ])
      ).rowCount;
    expect(await mine()).toBe(1);
    s.clock.advance(5 * 60_000);
    const r = await sweepExpired(s.deps);
    expect(r.ok && r.value.expired).not.toContain(g.gate_instance_id);
    expect(await mine()).toBe(1);
    expect(await inst(g.gate_instance_id)).toMatchObject({ status: 'decided', outcome: 'reject' });
    s.clock.advance(-5 * 60_000);
  });
});

describe('withdraw', () => {
  it('closes a pending gate for the requester, an admin or a system actor; refuses anyone else', async () => {
    const g = await open(s, 'proj', 'G4', { requester: pr('carol') });
    const stranger = await withdrawGate(s.deps, {
      gate_instance_id: g.gate_instance_id,
      actor: 'mallory',
      reason: 'x',
    });
    expect(!stranger.ok && stranger.error.code).toBe('not_allowed');
    const blank = await withdrawGate(s.deps, {
      gate_instance_id: g.gate_instance_id,
      actor: 'carol',
      reason: ' ',
    });
    expect(!blank.ok && blank.error.code).toBe('invalid_input');
    const ok = await withdrawGate(s.deps, {
      gate_instance_id: g.gate_instance_id,
      actor: 'carol',
      reason: 'changed my mind',
    });
    expect(ok.ok).toBe(true);
    expect(await inst(g.gate_instance_id)).toMatchObject({ status: 'closed' });
    const again = await withdrawGate(s.deps, {
      gate_instance_id: g.gate_instance_id,
      actor: 'root',
      reason: 'x',
    });
    expect(!again.ok && again.error.code).toBe('gate_not_pending');

    const g2 = await open(s, 'proj', 'G4', { requester: pr('carol') });
    expect(
      (
        await withdrawGate(s.deps, {
          gate_instance_id: g2.gate_instance_id,
          actor: 'root',
          reason: 'admin',
        })
      ).ok,
    ).toBe(true);
    const g3 = await open(s, 'proj', 'G4');
    expect(
      (
        await withdrawGate(s.deps, {
          gate_instance_id: g3.gate_instance_id,
          actor: 'system.gate',
          reason: 'item ended',
        })
      ).ok,
    ).toBe(true);
  });

  it('refuses a decided gate', async () => {
    const g = await open(s, 'proj', 'G4');
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
    const r = await withdrawGate(s.deps, {
      gate_instance_id: g.gate_instance_id,
      actor: 'system.gate',
      reason: 'x',
    });
    expect(!r.ok && r.error.code).toBe('gate_not_pending');
  });
});

describe('a Notary-signed decision survives a rolled-back caller transaction (M3.1 acceptance)', () => {
  it('shows as decided after the reconciler runs; the sweep does not expire it; rebuild equals live', async () => {
    const at = new Date(s.clock.nowMs() + 60_000).toISOString();
    const g = await open(s, 'proj', 'G4', { requester: pr('carol'), facts: { expires_at: at } });
    expect(
      (await snapshot()).instances.find((i) => i.gate_instance_id === g.gate_instance_id)?.status,
    ).toBe('pending');

    // The caller runs the whole vote (marker event, Notary reserve+sign, ledger row) and then its
    // transaction rolls back.
    const before = await ledgerCount(s);
    let signedSeq = 0;
    const r = await inLedgerTransaction(s.record.pool, async (tx) => {
      const entered = await enterGate(tx, s.deps, g.gate_instance_id);
      if (!entered.ok) throw new Error('enter');
      const v = await applyVote(tx, s.deps, entered.value.state, {
        gate_instance_id: g.gate_instance_id,
        voter: pr('ann'),
        decision: 'approve',
        evidence: {
          evidence_hash: g.subject_hash as never,
          evidence_viewed_at: s.clock.now().toISOString(),
          nonce_sha256: hash('n') as never,
          step_up: null,
        },
      });
      if (!v.ok) throw new Error(`vote ${JSON.stringify(v.error)}`);
      signedSeq = v.value.entry.ledger_seq;
      return rolledBack();
    });
    expect(r.ok).toBe(false);

    // Nothing of it is in the record or the ledger; only the Notary has the signed entry.
    expect(await ledgerCount(s)).toBe(before);
    const un = await s.coreNotary.unconfirmed();
    expect(un.ok && un.value.map((e) => e.ledger_seq)).toEqual([signedSeq]);
    expect(
      (await snapshot()).instances.find((i) => i.gate_instance_id === g.gate_instance_id)?.status,
    ).toBe('pending');
    expect((await readGateState(s.record.pool, g.gate_instance_id))?.status).toBe('pending');
    expect(
      (await snapshot()).events.filter((e) => e.gate_instance_id === g.gate_instance_id),
    ).toEqual([]);

    // The reconciler imports it; the projection catches up and shows decided.
    const rec = await reconcileLedger(s.record.pool, s.deps.ledger);
    expect(rec.ok && rec.value).toEqual({ inserted: 1, confirmed: 1 });
    expect(await ledgerCount(s)).toBe(before + 1);
    const after = (await snapshot()).instances.find(
      (i) => i.gate_instance_id === g.gate_instance_id,
    );
    expect(after).toMatchObject({
      status: 'decided',
      outcome: 'approve',
      approvers: ['ann'],
      decided_ledger_seq: signedSeq,
    });
    expect((await readGateState(s.record.pool, g.gate_instance_id))?.status).toBe('decided');
    // ...although the vote's marker event was rolled back with the transaction.
    expect(
      (await snapshot()).events.filter((e) => e.gate_instance_id === g.gate_instance_id),
    ).toEqual([]);

    // Later writers and sweeps see the decision: no second decision, no expiry.
    const again = await decideAs(s, g.gate_instance_id, 'bob', 'reject');
    expect(!again.ok && again.error.code).toBe('gate_not_pending');
    s.clock.advance(61_000);
    const sw = await sweepExpired(s.deps);
    expect(sw.ok && sw.value.expired).not.toContain(g.gate_instance_id);
    expect((await inst(g.gate_instance_id))?.status).toBe('decided');
    s.clock.advance(-61_000);
    await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
  });

  it('even before the reconciler runs, the sweep finds the stranded decision (it imports under the gate lock)', async () => {
    const at = new Date(s.clock.nowMs() + 60_000).toISOString();
    const g = await open(s, 'proj', 'G4', { facts: { expires_at: at } });
    await runProjection(s.record.pool, gateInstanceProjection);
    await inLedgerTransaction(s.record.pool, async (tx) => {
      const entered = await enterGate(tx, s.deps, g.gate_instance_id);
      if (!entered.ok) throw new Error('enter');
      const v = await applyVote(tx, s.deps, entered.value.state, {
        gate_instance_id: g.gate_instance_id,
        voter: pr('bob'),
        decision: 'approve',
        evidence: {
          evidence_hash: g.subject_hash as never,
          evidence_viewed_at: s.clock.now().toISOString(),
          nonce_sha256: hash('n2') as never,
          step_up: null,
        },
      });
      if (!v.ok) throw new Error('vote');
      return rolledBack();
    });
    s.clock.advance(61_000);
    const sw = await sweepExpired(s.deps);
    expect(sw.ok && sw.value.expired).not.toContain(g.gate_instance_id);
    expect(sw.ok && sw.value.skipped).toContainEqual({
      gate_instance_id: g.gate_instance_id,
      reason: 'decided',
    });
    expect((await inst(g.gate_instance_id))?.status).toBe('decided');
    s.clock.advance(-61_000);
  });
});
