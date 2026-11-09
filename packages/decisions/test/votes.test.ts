import { readLedgerEntries } from '@aisdlc/ledger';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateInstanceProjection, openGate } from '../src/index.js';
import {
  decideAs,
  hash,
  ledgerCount,
  open,
  pr,
  setupProject,
  startStack,
  uuid,
  type Stack,
} from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s.stop();
});

const state = async (id: string) => {
  await runProjection(s.record.pool, gateInstanceProjection);
  return (await gateInstanceProjection.snapshot(s.record.pool)).instances.find(
    (i) => i.gate_instance_id === id,
  );
};
const entriesOf = async (id: string) => {
  const n = await ledgerCount(s);
  return (await readLedgerEntries(s.record.pool, 1, n)).filter((e) => e.gate_instance_id === id);
};

describe('single approval gate, real Notary (main path)', () => {
  it('writes exactly one signed decision entry, a marker event, and the projection shows decided', async () => {
    setupProject(s, 'p1', { tier: 'T1', slots: { g4: ['ann', 'bob'] } });
    const g = await open(s, 'p1', 'G4', { requester: pr('carol') });
    const before = await ledgerCount(s);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.confirmed).toBe(true);
    expect(r.value.after).toMatchObject({
      status: 'decided',
      outcome: 'approve',
      approvers: ['ann'],
    });
    expect(await ledgerCount(s)).toBe(before + 1);

    const [e] = await entriesOf(g.gate_instance_id);
    expect(e).toMatchObject({
      entry_type: 'decision',
      decision: 'approve',
      actor: 'ann',
      gate_id: 'G4',
      subject_kind: 'item',
      subject_id: g.subject_id,
      subject_hash: g.subject_hash,
      sod_waiver: false,
      policy_bundle_version: 'decisions-1.0.0',
    });
    expect(e?.body).toMatchObject({
      kind: 'vote',
      quorum_required: 1,
      approvals_after: 1,
      step_up: null,
    });
    // The Notary's signature checks out, and the Notary journal has it committed.
    expect((await s.coreNotary.verify(e!)).ok).toBe(true);
    const j = await s.notary.database.pool.query<{ status: string }>(
      'SELECT status FROM notary.journal WHERE ledger_seq = $1',
      [e!.ledger_seq],
    );
    expect(j.rows[0]?.status).toBe('committed');

    expect(await state(g.gate_instance_id)).toMatchObject({
      status: 'decided',
      outcome: 'approve',
      decided_ledger_seq: e!.ledger_seq,
    });
    const ev = await s.record.pool.query<{ type: string }>(
      'SELECT type FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [`gate:${g.gate_instance_id}`],
    );
    expect(ev.rows.map((r) => r.type)).toEqual([
      'gate.opened',
      'gate.evidence_viewed',
      'gate.vote',
    ]);

    // A decided instance is never changed
    const more = await decideAs(s, g.gate_instance_id, 'bob', 'reject');
    expect(!more.ok && more.error.code).toBe('gate_not_pending');
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(1);
  });

  it('the requester cannot approve their own request; a non-holder is not eligible', async () => {
    setupProject(s, 'p2', { tier: 'T0', slots: { g4: ['ann', 'carol'] } });
    const g = await open(s, 'p2', 'G4', { requester: pr('carol') });
    const own = await decideAs(s, g.gate_instance_id, 'carol', 'approve');
    expect(!own.ok && own.error.code).toBe('own_request');
    const zed = await decideAs(s, g.gate_instance_id, 'zed', 'approve');
    expect(!zed.ok && zed.error.code).toBe('not_eligible');
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(0);
    expect((await state(g.gate_instance_id))?.status).toBe('pending');
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
  });

  it('the sole holder deciding their own request is stamped sod_waiver (not T2)', async () => {
    setupProject(s, 'p3', { tier: 'T1', slots: { g4: ['carol'] } });
    const g = await open(s, 'p3', 'G4', { requester: pr('carol') });
    expect((await decideAs(s, g.gate_instance_id, 'carol', 'approve')).ok).toBe(true);
    expect((await entriesOf(g.gate_instance_id))[0]).toMatchObject({
      actor: 'carol',
      sod_waiver: true,
    });
    setupProject(s, 'p3t2', { tier: 'T2', slots: { g4: ['carol'] } });
    const refused = await openGate(s.deps, {
      gate_id: 'G4',
      project_id: 'p3t2' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      subject_hash: hash('t2'),
      requester: pr('carol'),
    });
    expect(!refused.ok && refused.error.code).toBe('quorum_infeasible');
  });
});

describe('the author of a hand-written plan (B5) is barred from G3 like the requester', () => {
  it('cannot decide G3 on their plan while another holder can; the open event carries the author', async () => {
    setupProject(s, 'pa1', { tier: 'T0', slots: { design: ['ann', 'bob'] } });
    const g = await open(s, 'pa1', 'G3', { requester: pr('carol'), authors: [pr('ann')] });
    const own = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(!own.ok && own.error.code).toBe('own_request');
    // a rejection by the author is a decision as well: refused too
    const rej = await decideAs(s, g.gate_instance_id, 'ann', 'reject');
    expect(!rej.ok && rej.error.code).toBe('own_request');
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(0);
    const opened = await s.record.pool.query<{ body: { authors?: string[] } }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${g.gate_instance_id}`],
    );
    expect(opened.rows[0]?.body.authors).toEqual(['ann']);
    expect((await decideAs(s, g.gate_instance_id, 'bob', 'approve')).ok).toBe(true);
    expect((await entriesOf(g.gate_instance_id))[0]).toMatchObject({
      actor: 'bob',
      sod_waiver: false,
    });
  });

  it('the sole design holder who wrote the plan decides with a stamped sod_waiver, never at T2', async () => {
    setupProject(s, 'pa2', { tier: 'T1', slots: { design: ['ann'] } });
    const g = await open(s, 'pa2', 'G3', { requester: pr('carol'), authors: [pr('ann')] });
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
    expect((await entriesOf(g.gate_instance_id))[0]).toMatchObject({
      actor: 'ann',
      sod_waiver: true,
    });
    setupProject(s, 'pa3', { tier: 'T2', slots: { design: ['ann'] } });
    const refused = await openGate(s.deps, {
      gate_id: 'G3',
      project_id: 'pa3' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      subject_hash: hash('t2-plan'),
      requester: pr('carol'),
      authors: [pr('ann')],
    });
    expect(!refused.ok && refused.error.code).toBe('quorum_infeasible');
  });

  it('with no author recorded nothing changes (the requester rule as before)', async () => {
    setupProject(s, 'pa4', { tier: 'T0', slots: { design: ['ann', 'bob'] } });
    const g = await open(s, 'pa4', 'G3', { requester: pr('carol') });
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
  });
});

describe('two-person gates', () => {
  it.each(['X1', 'X2', 'E2'] as const)(
    '%s with two-person on: two distinct approvers, a repeat counts once, no waiver',
    async (gate) => {
      setupProject(s, `tp-${gate.toLowerCase()}`, {
        tier: 'T1',
        slots: { x: ['ann', 'bob', 'cy'] },
      });
      const g = await open(s, `tp-${gate.toLowerCase()}`, gate, { requester: pr('cy') });
      expect(await state(g.gate_instance_id)).toMatchObject({ quorum_required: 2 });
      const a = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
      expect(a.ok && a.value.after).toMatchObject({ status: 'pending', approvers: ['ann'] });
      const again = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
      expect(!again.ok && again.error.code).toBe('already_voted');
      expect(await entriesOf(g.gate_instance_id)).toHaveLength(1);
      expect((await state(g.gate_instance_id))?.status).toBe('pending');
      const b = await decideAs(s, g.gate_instance_id, 'bob', 'approve');
      expect(b.ok && b.value.after).toMatchObject({
        status: 'decided',
        outcome: 'approve',
        approvers: ['ann', 'bob'],
      });
      const es = await entriesOf(g.gate_instance_id);
      expect(es.map((e) => [e.actor, e.sod_waiver])).toEqual([
        ['ann', false],
        ['bob', false],
      ]);
      expect(await state(g.gate_instance_id)).toMatchObject({
        status: 'decided',
        approvers: ['ann', 'bob'],
      });
    },
  );

  it('single holder (not T2): decides alone, stamped; two-person off: alone, stamped', async () => {
    setupProject(s, 'solo-m4', { tier: 'T1', slots: { m4: ['ann'] } });
    const g = await open(s, 'solo-m4', 'M4', { subject_kind: 's0_record' });
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve', {
      stepUp: s.stepUp.issue(g.subject_hash, 'ann'),
    });
    expect(r.ok).toBe(true);
    expect((await entriesOf(g.gate_instance_id))[0]).toMatchObject({ sod_waiver: true });

    setupProject(s, 'off-x1', {
      tier: 'T0',
      two_person: { enabled: false },
      slots: { x: ['ann', 'bob'] },
    });
    const g2 = await open(s, 'off-x1', 'X1');
    expect((await decideAs(s, g2.gate_instance_id, 'bob', 'approve')).ok).toBe(true);
    expect((await entriesOf(g2.gate_instance_id))[0]).toMatchObject({
      actor: 'bob',
      sod_waiver: true,
    });
  });

  it('T2: M4 needs two approvers and no entry is ever stamped; single-person T2 M4 is refused', async () => {
    setupProject(s, 't2-one', { tier: 'T2', slots: { m4: ['ann'] } });
    const refused = await openGate(s.deps, {
      gate_id: 'M4',
      project_id: 't2-one' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      subject_hash: hash('x'),
    });
    expect(!refused.ok && refused.error.code).toBe('quorum_infeasible');

    setupProject(s, 't2-two', {
      tier: 'T2',
      two_person: { enabled: false },
      slots: { m4: ['ann', 'bob'] },
    });
    const g = await open(s, 't2-two', 'M4', { subject_kind: 's0_record' });
    expect(await state(g.gate_instance_id)).toMatchObject({ quorum_required: 2 });
    const proof = (p: string) => s.stepUp.issue(g.subject_hash, p);
    expect(
      (await decideAs(s, g.gate_instance_id, 'ann', 'approve', { stepUp: proof('ann') })).ok,
    ).toBe(true);
    expect((await state(g.gate_instance_id))?.status).toBe('pending');
    expect(
      (await decideAs(s, g.gate_instance_id, 'bob', 'approve', { stepUp: proof('bob') })).ok,
    ).toBe(true);
    expect((await entriesOf(g.gate_instance_id)).map((e) => e.sod_waiver)).toEqual([false, false]);
    expect((await state(g.gate_instance_id))?.status).toBe('decided');
  });

  it('a role that shrinks to one person after a two-person gate was decided-for is refused when it cannot be met (T2)', async () => {
    setupProject(s, 't2-shrink', { tier: 'T2', slots: { m4: ['ann', 'bob'] } });
    const g = await open(s, 't2-shrink', 'M4', { subject_kind: 's0_record' });
    s.elig.setHolders('t2-shrink' as never, 'm4', [pr('ann')]);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve', {
      stepUp: s.stepUp.issue(g.subject_hash, 'ann'),
    });
    expect(!r.ok && r.error.code).toBe('quorum_infeasible');
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(0);
  });

  it('refuses a vote when the policy now needs more approvals than the gate was opened for', async () => {
    setupProject(s, 'drift', { tier: 'T0', slots: { x: ['ann'] } });
    const g = await open(s, 'drift', 'X1');
    expect(await state(g.gate_instance_id)).toMatchObject({ quorum_required: 1 });
    s.elig.setHolders('drift' as never, 'x', [pr('ann'), pr('bob')]);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(!r.ok && r.error.code).toBe('policy_changed');
  });
});

describe('reject and request_changes end the gate', () => {
  it.each(['reject', 'request_changes'] as const)(
    '%s by one eligible voter ends a two-person gate',
    async (d) => {
      setupProject(s, `end-${d}`, { tier: 'T0', slots: { x: ['ann', 'bob', 'cy'] } });
      const g = await open(s, `end-${d}`, 'X2');
      expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
      const r = await decideAs(s, g.gate_instance_id, 'bob', d);
      expect(r.ok && r.value.after).toMatchObject({ status: 'decided', outcome: d });
      expect(await state(g.gate_instance_id)).toMatchObject({ status: 'decided', outcome: d });
      const late = await decideAs(s, g.gate_instance_id, 'cy', 'approve');
      expect(!late.ok && late.error.code).toBe('gate_not_pending');
    },
  );
});

describe('fail closed', () => {
  it('an unreachable identity source is a refusal, not an approval', async () => {
    setupProject(s, 'down', { tier: 'T0', slots: { g4: ['ann'] } });
    const g = await open(s, 'down', 'G4');
    s.elig.breakProject('down' as never);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(!r.ok && r.error.code).toBe('eligibility_unavailable');
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(0);
  });

  it('concurrent decisions on one gate: exactly one decides, nobody deadlocks', async () => {
    setupProject(s, 'race', { tier: 'T0', slots: { g4: ['ann', 'bob', 'cy', 'di'] } });
    const g = await open(s, 'race', 'G4');
    const rs = await Promise.all(
      ['ann', 'bob', 'cy', 'di'].map((p, i) =>
        decideAs(s, g.gate_instance_id, p, i % 2 ? 'reject' : 'approve'),
      ),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === 'gate_not_pending')).toBe(
      true,
    );
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(1);
  });

  it('concurrent approvals of a two-person gate by the same principal count once', async () => {
    setupProject(s, 'race2', { tier: 'T0', slots: { x: ['ann', 'bob'] } });
    const g = await open(s, 'race2', 'X1');
    const rs = await Promise.all(
      [1, 2, 3].map(() => decideAs(s, g.gate_instance_id, 'ann', 'approve')),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await entriesOf(g.gate_instance_id)).toHaveLength(1);
    expect((await state(g.gate_instance_id))?.status).toBe('pending');
  });
});
