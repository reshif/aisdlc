import { CARD_EVENT, cardStream } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessCalendar,
  decideCard,
  listInbox,
  openCard,
  prepareCard,
  readCardState,
  recordCardEvidenceViewed,
  sweepSla,
  type DecisionDeps,
} from '../src/index.js';
import { hash, ledgerCount, pr, setupProject, startStack, uuid, type Stack } from './helpers.js';

// B21 with a manual clock across a weekend. 2026-11-06 is a Friday.
const FRI_15 = '2026-11-06T15:00:00.000Z';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'sla', {
    tier: 'T1',
    slots: { intent: ['ann'], g4: ['ann', 'bob'], admin: ['root', 'mgr'], x: ['ann', 'bob', 'cy'] },
  });
  // The approver is also the only admin: no backup besides them.
  setupProject(s, 'lonely', { tier: 'T1', slots: { g4: ['ann'], admin: ['ann'] } });
});
afterAll(async () => {
  await s.stop();
});

const openG4 = async (deps: DecisionDeps, project: string) => {
  const r = await openCard(deps, {
    project_id: project as never,
    subject_kind: 'item',
    subject_id: uuid(),
    gates: [{ gate_id: 'G4', subject_hash: hash(`g4-${Math.random()}`) }],
    requester: pr('zed'),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const escalations = async (cardId: string) =>
  (
    await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [cardStream(cardId), CARD_EVENT.escalated],
    )
  ).rows.map((r) => r.body);

describe('B21 SLA escalation', () => {
  it('escalates after one business day across a weekend, to the backup, and never approves', async () => {
    s.clock.set(FRI_15);
    const card = await openG4(s.deps, 'sla');
    const gate = card.gate_instance_ids[0] as string;
    const ledgerBefore = await ledgerCount(s);

    // Friday evening, Saturday, Sunday, Monday just before 15:00: not due.
    for (const t of [
      '2026-11-06T23:00:00.000Z',
      '2026-11-07T15:00:00.000Z',
      '2026-11-08T15:00:00.000Z',
      '2026-11-09T14:59:59.999Z',
    ]) {
      s.clock.set(t);
      const r = await sweepSla(s.deps);
      expect(r.ok && r.value.escalated, t).toEqual([]);
    }
    expect(await escalations(card.card_id)).toHaveLength(0);

    // Monday 15:00: one business day has passed.
    s.clock.set('2026-11-09T15:00:00.000Z');
    const r = await sweepSla(s.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.escalated).toEqual([
      { card_id: card.card_id, gate_instance_id: gate, backup: ['mgr', 'root'] },
    ]);
    const ev = await escalations(card.card_id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      level: 1,
      reason: 'sla_b21',
      backup_slot: 'admin',
      due_at: '2026-11-09T15:00:00.000Z',
      backup: ['mgr', 'root'],
    });

    // NEVER approves: no ledger entry, the gate is still pending, the card still open.
    expect(await ledgerCount(s)).toBe(ledgerBefore);
    const st = await readCardState(s.record.pool, card.card_id);
    expect(st?.status).toBe('open');
    expect(st?.gates[0]?.state.status).toBe('pending');
    expect(st?.gates[0]?.state.decisions).toEqual([]);

    // The backup has an inbox entry, as escalated_backup, and no right to decide.
    const inbox = await listInbox(s.deps, pr('root'));
    const item = inbox.ok ? inbox.value.find((i) => i.card.card_id === card.card_id) : undefined;
    expect(item).toMatchObject({ reason: 'escalated_backup', overdue: true });
    expect(item?.card.escalated).toBe(true);
    const denied = await prepareCard(s.deps, { card_id: card.card_id, principal: pr('root') });
    expect(denied.ok).toBe(false);
    // The approvers still see it, as eligible.
    const ann = await listInbox(s.deps, pr('ann'));
    expect(ann.ok && ann.value.find((i) => i.card.card_id === card.card_id)?.reason).toBe(
      'eligible',
    );

    // A repeat sweep is a no-op.
    for (let i = 0; i < 2; i++) {
      const again = await sweepSla(s.deps);
      expect(again.ok && again.value.escalated).toEqual([]);
    }
    expect(await escalations(card.card_id)).toHaveLength(1);
    expect(await ledgerCount(s)).toBe(ledgerBefore);

    // Late is still decidable by the approver (escalation is not expiry, nor a decision).
    const p = await prepareCard(s.deps, { card_id: card.card_id, principal: pr('ann') });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    await recordCardEvidenceViewed(s.deps, [
      { nonce: p.value.gates[0]!.nonce, evidence_hash: p.value.gates[0]!.evidence_hash },
    ]);
    const d = await decideCard(s.deps, {
      card_id: card.card_id,
      votes: [{ nonce: p.value.gates[0]!.nonce, decision: 'approve' }],
    });
    expect(d.ok).toBe(true);
    // a decided card is not escalated again, and leaves the backup's inbox
    const gone = await listInbox(s.deps, pr('root'));
    expect(gone.ok && gone.value.some((i) => i.card.card_id === card.card_id)).toBe(false);
  });

  it('a decided gate is never escalated, even if the read model has not seen the decision', async () => {
    s.clock.set(FRI_15);
    const card = await openG4(s.deps, 'sla');
    const p = await prepareCard(s.deps, { card_id: card.card_id, principal: pr('bob') });
    if (!p.ok) throw new Error('prepare');
    await recordCardEvidenceViewed(s.deps, [
      { nonce: p.value.gates[0]!.nonce, evidence_hash: p.value.gates[0]!.evidence_hash },
    ]);
    expect(
      (
        await decideCard(s.deps, {
          card_id: card.card_id,
          votes: [{ nonce: p.value.gates[0]!.nonce, decision: 'approve' }],
        })
      ).ok,
    ).toBe(true);
    s.clock.set('2026-11-10T12:00:00.000Z');
    const r = await sweepSla(s.deps);
    expect(r.ok && r.value.escalated.filter((e) => e.card_id === card.card_id)).toEqual([]);
    expect(await escalations(card.card_id)).toHaveLength(0);
  });

  it('holidays move the due time; the calendar and the SLA length are configurable', async () => {
    s.clock.set(FRI_15);
    const deps: DecisionDeps = {
      ...s.deps,
      calendar: businessCalendar({ holidays: ['2026-11-09'] }),
    };
    const card = await openG4(deps, 'sla');
    const view = await readCardState(s.record.pool, card.card_id);
    expect(view?.open.sla_due_at).toBe('2026-11-10T15:00:00.000Z'); // Monday is a holiday

    s.clock.set('2026-11-09T15:00:00.000Z');
    expect((await sweepSla(deps)).ok).toBe(true);
    expect(await escalations(card.card_id)).toHaveLength(0);
    s.clock.set('2026-11-10T15:00:00.000Z');
    const r = await sweepSla(deps);
    expect(r.ok && r.value.escalated.map((e) => e.card_id)).toContain(card.card_id);

    s.clock.set(FRI_15);
    const long = await openG4({ ...s.deps, slaBusinessDays: 3 }, 'sla');
    expect((await readCardState(s.record.pool, long.card_id))?.open.sla_due_at).toBe(
      '2026-11-11T15:00:00.000Z',
    );
  });

  it('with nobody but the approver in the backup slot the escalation is recorded with an empty backup', async () => {
    s.clock.set(FRI_15);
    const card = await openG4(s.deps, 'lonely');
    s.clock.set('2026-11-09T15:00:00.000Z');
    const r = await sweepSla(s.deps);
    expect(r.ok && r.value.escalated.filter((e) => e.card_id === card.card_id)).toEqual([
      { card_id: card.card_id, gate_instance_id: card.gate_instance_ids[0], backup: [] },
    ]);
  });

  it('an identity failure leaves the card unescalated for the next sweep, and writes nothing', async () => {
    setupProject(s, 'blip', { tier: 'T1', slots: { g4: ['ann'], admin: ['root'] } });
    s.clock.set(FRI_15);
    const card = await openG4(s.deps, 'blip');
    s.elig.breakProject('blip' as never);
    s.clock.set('2026-11-09T15:00:00.000Z');
    const r = await sweepSla(s.deps);
    expect(r.ok && r.value.failed.map((f) => f.card_id)).toContain(card.card_id);
    expect(await escalations(card.card_id)).toHaveLength(0);
  });
});
