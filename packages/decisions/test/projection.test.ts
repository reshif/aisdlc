import { withTransaction } from '@aisdlc/db';
import { reconcileLedger } from '@aisdlc/ledger';
import { appendEvents, readCheckpoint, rebuild, runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { newId } from '@aisdlc/kernel';
import { appendLedgerEntry, inLedgerTransaction } from '@aisdlc/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateInstanceProjection, openGate, sweepExpired, withdrawGate } from '../src/index.js';
import { applyVote, enterGate } from '../src/vote.js';
import {
  decideAs,
  STEPPED_UP,
  hash,
  open,
  pr,
  rolledBack,
  setupProject,
  startStack,
  type Stack,
} from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'pj', {
    tier: 'T1',
    slots: { g4: ['ann', 'bob'], x: ['ann', 'bob', 'cy'], intent: ['ann'], admin: ['root'] },
  });
});
afterAll(async () => {
  await s.stop();
});

const run = (batchSize?: number) =>
  runProjection(s.record.pool, gateInstanceProjection, batchSize ? { batchSize } : {});
const filler = (n: number) =>
  withTransaction(s.record.pool, async (tx) => {
    for (let i = 0; i < n; i++) {
      const r = await appendEvents(tx, `filler:${Math.random()}`, 0, [
        { type: 'filler.noted', body: {}, actor: 'system.test' },
      ]);
      if (!r.ok) throw new Error('filler');
    }
  });

describe('gate_instance projection over the record and the ledger', () => {
  it('folds record events and ledger decisions, and rebuild equals live (steps interleaved)', async () => {
    const a = await open(s, 'pj', 'G4', { requester: pr('carol') });
    await run(2);
    expect((await decideAs(s, a.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
    const b = await open(s, 'pj', 'X1');
    await run(1);
    expect((await decideAs(s, b.gate_instance_id, 'ann', 'approve', STEPPED_UP)).ok).toBe(true);
    await run(3);
    expect((await decideAs(s, b.gate_instance_id, 'bob', 'approve', STEPPED_UP)).ok).toBe(true);
    const c = await open(s, 'pj', 'G2', { subject_kind: 's0_record' });
    const c2 = await openGate(s.deps, { ...c.input, subject_hash: hash('c2') });
    expect(c2.ok).toBe(true);
    await run();
    const d = await open(s, 'pj', 'G4', {
      facts: { expires_at: new Date(s.clock.nowMs() + 1000).toISOString() },
    });
    const w = await open(s, 'pj', 'G4', { requester: pr('carol') });
    expect(
      (
        await withdrawGate(s.deps, {
          gate_instance_id: w.gate_instance_id,
          actor: 'carol',
          reason: 'x',
        })
      ).ok,
    ).toBe(true);
    await run(1);
    s.clock.advance(2000);
    const sw = await sweepExpired(s.deps);
    expect(sw.ok && sw.value.expired).toContain(d.gate_instance_id);
    const e = await open(s, 'pj', 'X2');
    expect((await decideAs(s, e.gate_instance_id, 'cy', 'reject', STEPPED_UP)).ok).toBe(true);
    s.clock.advance(-2000);

    const snap = await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
    const by = (id: string) => snap.instances.find((i) => i.gate_instance_id === id);
    expect(by(a.gate_instance_id)).toMatchObject({ status: 'decided', outcome: 'approve' });
    expect(by(b.gate_instance_id)).toMatchObject({
      status: 'decided',
      approvers: ['ann', 'bob'],
      quorum_required: 2,
    });
    expect(by(c.gate_instance_id)).toMatchObject({ status: 'superseded' });
    expect(by(d.gate_instance_id)).toMatchObject({ status: 'expired' });
    expect(by(w.gate_instance_id)).toMatchObject({ status: 'closed' });
    expect(by(e.gate_instance_id)).toMatchObject({ status: 'decided', outcome: 'reject' });
    expect(snap.votes.length).toBeGreaterThanOrEqual(6);
    // The ledger feed has its own checkpoint, at the ledger head
    const cp = await readCheckpoint(s.record.pool, 'gate_instance#ledger');
    expect(cp?.last_global_seq).toBe(Math.max(...snap.votes.map((v) => v.ledger_seq)));
  });

  it('does not depend on which source is folded first: the ledger feed running ahead of the record', async () => {
    // Many unrelated record events come first, so with batchSize 1 the feed folds decisions of a
    // gate whose `gate.opened` event has not been folded yet.
    await filler(8);
    const g = await open(s, 'pj', 'G4', { requester: pr('carol') });
    expect((await decideAs(s, g.gate_instance_id, 'bob', 'approve')).ok).toBe(true);
    // The decision's ledger_seq is below the open event's global_seq: with batchSize 1 the feed
    // folds the decision before the record reaches `gate.opened`.
    const pos = await s.record.pool.query<{ ev: string; lg: string }>(
      `SELECT (SELECT global_seq FROM record.record_event WHERE stream = $1 AND seq = 1)::text AS ev,
              (SELECT ledger_seq FROM ledger.ledger_entry WHERE gate_instance_id = $2)::text AS lg`,
      [`gate:${g.gate_instance_id}`, g.gate_instance_id],
    );
    expect(Number(pos.rows[0]?.lg)).toBeLessThan(Number(pos.rows[0]?.ev));
    // Drop only the state, keep checkpoints at 0, then fold with tiny batches.
    await s.record.pool.query(
      "UPDATE record.projection_checkpoint SET last_global_seq = 0 WHERE name LIKE 'gate_instance%'",
    );
    await gateInstanceProjection.reset(s.record.pool as never);
    const r = await run(1);
    expect(r.ok).toBe(true);
    const snap = await gateInstanceProjection.snapshot(s.record.pool);
    expect(snap.instances.find((i) => i.gate_instance_id === g.gate_instance_id)).toMatchObject({
      status: 'decided',
      outcome: 'approve',
    });
    await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection, undefined, {
      batchSize: 1,
    });
  });

  it('a decision entry for a gate with no open event is stored, changes no instance, and rebuilds the same', async () => {
    const orphan = newId<'GateInstance'>();
    const w = await appendLedgerEntry(s.record.pool, s.deps.ledger, {
      entry_id: newId<'LedgerEntry'>(),
      entry_type: 'decision',
      gate_instance_id: orphan,
      gate_id: 'G4',
      subject_kind: 'item',
      subject_id: newId<'WorkItem'>(),
      subject_hash: hash('orphan'),
      decision: 'approve',
      actor: pr('ann'),
      sod_waiver: false,
      policy_bundle_version: 'test',
      body: {},
      created_at: s.clock.now().toISOString(),
    });
    expect(w.ok).toBe(true);
    const snap = await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
    expect(snap.instances.some((i) => i.gate_instance_id === orphan)).toBe(false);
    expect(snap.votes.some((v) => v.gate_instance_id === orphan)).toBe(true);
  });

  it('a stranded decision appears only after the reconciler, and rebuild equals live after it', async () => {
    const g = await open(s, 'pj', 'X1');
    await run();
    await inLedgerTransaction(s.record.pool, async (tx) => {
      const st = await enterGate(tx, s.deps, g.gate_instance_id);
      if (!st.ok) throw new Error('enter');
      const v = await applyVote(tx, s.deps, st.value.state, {
        gate_instance_id: g.gate_instance_id,
        voter: pr('ann'),
        decision: 'reject',
        evidence: {
          evidence_hash: g.subject_hash as never,
          evidence_viewed_at: s.clock.now().toISOString(),
          nonce_sha256: hash('z') as never,
          step_up: null,
        },
      });
      if (!v.ok) throw new Error('vote');
      return rolledBack();
    });
    await run();
    let snap = await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
    expect(snap.instances.find((i) => i.gate_instance_id === g.gate_instance_id)?.status).toBe(
      'pending',
    );
    expect((await reconcileLedger(s.record.pool, s.deps.ledger)).ok).toBe(true);
    snap = await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
    expect(snap.instances.find((i) => i.gate_instance_id === g.gate_instance_id)).toMatchObject({
      status: 'decided',
      outcome: 'reject',
    });
  });

  it('drifted rows are discarded by a rebuild', async () => {
    await run();
    const good = await gateInstanceProjection.snapshot(s.record.pool);
    await s.record.pool.query(
      "UPDATE decisions.gate_instance SET status = 'pending', outcome = NULL, decided_at = NULL, decided_ledger_seq = NULL WHERE status = 'decided'",
    );
    await s.record.pool.query(
      'DELETE FROM decisions.gate_vote WHERE ledger_seq = (SELECT min(ledger_seq) FROM decisions.gate_vote)',
    );
    expect(await gateInstanceProjection.snapshot(s.record.pool)).not.toEqual(good);
    await rebuild(s.record.pool, gateInstanceProjection);
    expect(await gateInstanceProjection.snapshot(s.record.pool)).toEqual(good);
    await expectRebuildEqualsLive(s.record.pool, gateInstanceProjection);
  });
});
