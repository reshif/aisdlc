import { CARD_EVENT, cardPayloadHash, cardStream, type CardPayloadItem } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideCard,
  gateInstanceProjection,
  inboxProjection,
  listInbox,
  openCard,
  openCards,
  planCards,
  prepareCard,
  readCardState,
  readCardViews,
  recordCardEvidenceViewed,
  verifyCardPayload,
  withdrawCard,
  type DecisionDeps,
  type PreparedCard,
} from '../src/index.js';
import { hash, ledgerCount, pr, setupProject, startStack, uuid, type Stack } from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  // A single operator (ann) for project solo; a team for project team; one M4 holder in solo.
  setupProject(s, 'solo', {
    tier: 'T1',
    slots: {
      intent: ['ann'],
      design: ['ann'],
      g4: ['ann'],
      g5: ['ann'],
      requesters: ['ann'],
      x: ['ann'],
      m4: ['ann'],
      admin: ['ann'],
    },
  });
  setupProject(s, 'team', {
    tier: 'T1',
    slots: {
      intent: ['ann', 'bob'],
      design: ['cy', 'dee'],
      g4: ['ann', 'bob'],
      g5: ['ann'],
      requesters: ['dee'],
      x: ['ann', 'bob', 'cy'],
      admin: ['root'],
    },
  });
});
afterAll(async () => {
  await s.stop();
});

const g = (gate_id: string) => ({
  gate_id: gate_id as never,
  subject_hash: hash(`${gate_id}-${Math.random()}`),
});

/** prepare, evidence viewed, decide: a whole card for one principal. */
async function decideAs(
  deps: DecisionDeps,
  cardId: string,
  principal: string,
  decision: string,
  extra: {
    payload?: readonly unknown[];
    steps?: Array<{ step: never; decision: string }>;
    stepUp?: (p: PreparedCard) => Record<string, string>;
  } = {},
) {
  const p = await prepareCard(deps, { card_id: cardId, principal: pr(principal) });
  if (!p.ok) return p;
  const seen = await recordCardEvidenceViewed(
    deps,
    p.value.gates.map((x) => ({ nonce: x.nonce, evidence_hash: x.evidence_hash })),
  );
  if (!seen.ok) return seen;
  const proofs = extra.stepUp?.(p.value) ?? {};
  return decideCard(deps, {
    card_id: cardId,
    votes: p.value.gates.map((x) => ({
      nonce: x.nonce,
      decision,
      ...(proofs[x.gate_instance_id]
        ? { step_up: { proof: proofs[x.gate_instance_id] as string } }
        : {}),
    })),
    ...(extra.steps ? { steps: extra.steps } : {}),
    ...(extra.payload ? { payload: extra.payload } : {}),
  });
}

const sync = async () => {
  await runProjection(s.record.pool, gateInstanceProjection);
  await runProjection(s.record.pool, inboxProjection);
};

describe('consolidation (FL PROFILES SOLO cards)', () => {
  const plan = async (project: string, gates: string[], requester?: string) => {
    const r = await planCards(s.deps, {
      project_id: project as never,
      ...(requester ? { requester: pr(requester) } : {}),
      gates: gates.map(g),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.map((c) => c.map((x) => x.gate_id));
  };

  it('a single operator gets cards 1 to 5: G0+G1, G2+G3o, G3d+G3+G3s, G4, G5+G6', async () => {
    expect(
      await plan('solo', ['G0', 'G1', 'G2', 'G3o', 'G3d', 'G3', 'G3s', 'G4', 'G5', 'G6'], 'ann'),
    ).toEqual([['G0', 'G1'], ['G2', 'G3o'], ['G3d', 'G3', 'G3s'], ['G4'], ['G5', 'G6']]);
  });

  it('card 5 only when the requester is the operator', async () => {
    expect(await plan('solo', ['G5', 'G6'], 'zed')).toEqual([['G5'], ['G6']]);
    expect(await plan('solo', ['G5', 'G6'])).toEqual([['G5'], ['G6']]);
  });

  it('nothing consolidates where the roles are not one person', async () => {
    expect(await plan('team', ['G0', 'G1'])).toEqual([['G0'], ['G1']]);
    expect(await plan('team', ['G3d', 'G3', 'G3s'])).toEqual([['G3d'], ['G3'], ['G3s']]);
  });

  it('X, E, M, Q and SECT always get a card of their own, even for the single operator', async () => {
    expect(await plan('solo', ['X1', 'X2', 'E1', 'M4', 'Q1', 'SECT'])).toEqual([
      ['X1'],
      ['X2'],
      ['E1'],
      ['M4'],
      ['Q1'],
      ['SECT'],
    ]);
    expect(await plan('solo', ['G4', 'G5'])).toEqual([['G4'], ['G5']]);
  });

  it('an identity failure is a refusal, not "consolidate anyway"', async () => {
    setupProject(s, 'broken', { tier: 'T1', slots: { intent: ['ann'] } });
    s.elig.breakProject('broken' as never);
    const r = await planCards(s.deps, { project_id: 'broken' as never, gates: [g('G0'), g('G1')] });
    expect(r.ok).toBe(false);
  });

  it('openCard refuses gates that may not share a card', async () => {
    const subject = {
      project_id: 'solo' as never,
      subject_kind: 'item' as const,
      subject_id: uuid(),
    };
    for (const gates of [
      ['X1', 'X2'],
      ['G4', 'G5'],
      ['G0', 'G2'],
      ['M4', 'G6'],
      ['G0', 'G0'],
    ]) {
      const r = await openCard(s.deps, { ...subject, gates: gates.map(g) });
      expect(r.ok, gates.join('+')).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_input');
    }
    expect((await openCard(s.deps, { ...subject, gates: [] })).ok).toBe(false);
  });
});

describe('opening and deciding a card', () => {
  it('opens one gate per target under one card id, and reopening is a no-op', async () => {
    const subject = {
      project_id: 'solo' as never,
      subject_kind: 'item' as const,
      subject_id: uuid(),
    };
    const input = { ...subject, gates: [g('G0'), g('G1')], requester: pr('zed') };
    const a = await openCard(s.deps, input);
    expect(a.ok && a.value.opened).toBe(true);
    if (!a.ok) return;
    expect(a.value.group).toBe('solo1');
    expect(a.value.gate_instance_ids).toHaveLength(2);
    const b = await openCard(s.deps, input); // same gates, same hashes
    expect(b.ok && b.value.card_id).toBe(a.value.card_id);
    expect(b.ok && b.value.opened).toBe(false);
    const events = await s.record.pool.query(
      'SELECT 1 FROM record.record_event WHERE stream = $1',
      [cardStream(a.value.card_id)],
    );
    expect(events.rowCount).toBe(1);
  });

  it('G0+G1: one decision writes one ledger entry per gate, in one transaction', async () => {
    const subject_id = uuid();
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 'item',
      subject_id,
      gates: [g('G0'), g('G1')],
      requester: pr('zed'),
    });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const before = await ledgerCount(s);
    const d = await decideAs(s.deps, a.value.card_id, 'ann', 'approve');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(await ledgerCount(s)).toBe(before + 2);
    expect(d.value.entries.map((e) => e.gate_id)).toEqual(['G0', 'G1']); // card order
    expect(d.value.entries.map((e) => e.gate_instance_id)).toEqual(a.value.gate_instance_ids);
    expect(d.value.entries.every((e) => e.decision === 'approve' && e.actor === 'ann')).toBe(true);
    expect(d.value.status).toBe('decided');
    const st = await readCardState(s.record.pool, a.value.card_id);
    expect(st?.status).toBe('decided');
    expect(st?.gates.map((x) => x.state.status)).toEqual(['decided', 'decided']);
    expect(st?.decided).toHaveLength(1);
    // every entry names the card
    for (const e of d.value.entries) {
      expect(e.body).toMatchObject({ kind: 'vote', card: { card_id: a.value.card_id } });
    }
    // and a decided card cannot be decided again
    const again = await prepareCard(s.deps, { card_id: a.value.card_id, principal: pr('ann') });
    expect(again.ok).toBe(false);
  });

  it('never auto-approves: a card with an undecided gate stays open, and a partial decision writes nothing', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('G0'), g('G1')],
    });
    if (!a.ok) throw new Error('open');
    const p = await prepareCard(s.deps, { card_id: a.value.card_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordCardEvidenceViewed(
      s.deps,
      p.value.gates.map((x) => ({ nonce: x.nonce, evidence_hash: x.evidence_hash })),
    );
    const before = await ledgerCount(s);
    const first = p.value.gates[0]!;
    const partial = await decideCard(s.deps, {
      card_id: a.value.card_id,
      votes: [{ nonce: first.nonce, decision: 'approve' }],
    });
    expect(partial.ok).toBe(false);
    expect(await ledgerCount(s)).toBe(before);
    expect((await readCardState(s.record.pool, a.value.card_id))?.status).toBe('open');
    // the nonces were not consumed by the refusal: the full decision still works
    const full = await decideCard(s.deps, {
      card_id: a.value.card_id,
      votes: p.value.gates.map((x) => ({ nonce: x.nonce, decision: 'approve' })),
    });
    expect(full.ok).toBe(true);
  });

  it('a refusal on one gate rolls the whole card back (G5 needs a step-up)', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('G5'), g('G6')],
      requester: pr('ann'),
    });
    if (!a.ok) throw new Error('open');
    expect(a.value.group).toBe('solo5');
    const before = await ledgerCount(s);
    const noProof = await decideAs(s.deps, a.value.card_id, 'ann', 'approve');
    expect(noProof.ok).toBe(false);
    if (!noProof.ok) expect(noProof.error.code).toBe('step_up_required');
    expect(await ledgerCount(s)).toBe(before);
    expect((await readCardState(s.record.pool, a.value.card_id))?.status).toBe('open');

    const ok = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', {
      stepUp: (p) =>
        Object.fromEntries(
          p.gates
            .filter((x) => x.step_up.required)
            .map((x) => [x.gate_instance_id, s.stepUp.issue(x.step_up.bound_hash, 'ann')]),
        ),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(await ledgerCount(s)).toBe(before + 2);
  });

  it('a reject on one gate decides the card as rejected; request_changes sends it back', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('G0'), g('G1')],
    });
    if (!a.ok) throw new Error('open');
    const p = await prepareCard(s.deps, { card_id: a.value.card_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordCardEvidenceViewed(
      s.deps,
      p.value.gates.map((x) => ({ nonce: x.nonce, evidence_hash: x.evidence_hash })),
    );
    const d = await decideCard(s.deps, {
      card_id: a.value.card_id,
      votes: [
        { nonce: p.value.gates[0]!.nonce, decision: 'approve' },
        { nonce: p.value.gates[1]!.nonce, decision: 'request_changes' },
      ],
    });
    expect(d.ok && d.value.status).toBe('sent_back');
  });

  it('refuses a principal who does not hold the slot, and a second principal on one card', async () => {
    const a = await openCard(s.deps, {
      project_id: 'team' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('G0')],
    });
    if (!a.ok) throw new Error('open');
    const p = await prepareCard(s.deps, { card_id: a.value.card_id, principal: pr('cy') });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.code).toBe('not_eligible');
  });

  it('a two-person gate on a card stays open after one approval', async () => {
    const a = await openCard(s.deps, {
      project_id: 'team' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('X1')],
    });
    if (!a.ok) throw new Error('open');
    const one = await decideAs(s.deps, a.value.card_id, 'ann', 'approve');
    expect(one.ok && one.value.status).toBe('open');
    const dup = await decideAs(s.deps, a.value.card_id, 'ann', 'approve');
    expect(dup.ok).toBe(false);
    const two = await decideAs(s.deps, a.value.card_id, 'bob', 'approve');
    expect(two.ok && two.value.status).toBe('decided');
  });

  it('concurrent decisions of one card: exactly one wins, nothing deadlocks', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [g('G3d'), g('G3'), g('G3s')],
    });
    if (!a.ok) throw new Error('open');
    const before = await ledgerCount(s);
    const results = await Promise.all([
      decideAs(s.deps, a.value.card_id, 'ann', 'approve'),
      decideAs(s.deps, a.value.card_id, 'ann', 'approve'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await ledgerCount(s)).toBe(before + 3);
  });

  it('card 5 of onboarding: a sign-off step and M4 are two ledger entries on one card', async () => {
    const s0 = uuid();
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: s0,
      gates: [g('M4')],
      steps: [{ step: '0.5', slot: 'admin' }],
      label: 'C5',
    });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const before = await ledgerCount(s);
    // the step must be decided with the first decision
    const missing = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', {
      stepUp: (p) =>
        Object.fromEntries(
          p.gates.map((x) => [x.gate_instance_id, s.stepUp.issue(x.step_up.bound_hash, 'ann')]),
        ),
    });
    expect(missing.ok).toBe(false);
    expect(await ledgerCount(s)).toBe(before);
    const d = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', {
      steps: [{ step: '0.5' as never, decision: 'approve' }],
      stepUp: (p) =>
        Object.fromEntries(
          p.gates.map((x) => [x.gate_instance_id, s.stepUp.issue(x.step_up.bound_hash, 'ann')]),
        ),
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(await ledgerCount(s)).toBe(before + 2);
    expect(d.value.entries.map((e) => e.entry_type)).toEqual(['decision', 'card.step_decision']);
    expect(d.value.entries[0]?.gate_id).toBe('M4');
    expect(d.value.status).toBe('decided');
    const st = await readCardState(s.record.pool, a.value.card_id);
    expect(st?.steps).toEqual([
      expect.objectContaining({
        step: '0.5',
        decision: 'approve',
        ledger_entry_id: d.value.entries[1]?.entry_id,
      }),
    ]);
  });
});

describe('list payloads (SP-PROC-2)', () => {
  const rows = (n: number): CardPayloadItem[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'gap_disposition' as const,
      gap_id: `gap:r1:RS-GAP-${i}`,
      criterion: `RS-GAP-${i}`,
      disposition: (['file_issue', 'track_only', 'waive'] as const)[i % 3] as 'waive',
    }));

  it('a 50-row payload decides and hashes into one ledger entry; the full list is on the card stream', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [g('G2')],
    });
    if (!a.ok) throw new Error('open');
    const payload = rows(50);
    const before = await ledgerCount(s);
    const d = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', { payload });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(await ledgerCount(s)).toBe(before + 1);
    const want = cardPayloadHash(payload);
    expect(d.value.payload_hash).toBe(want);
    expect(d.value.entries).toHaveLength(1);
    expect(d.value.entries[0]?.body).toMatchObject({ card: { payload_hash: want } });
    // the full list is stored once, as a record event on the card stream
    const ev = await s.record.pool.query<{ body: { payload: unknown[]; payload_hash: string } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [cardStream(a.value.card_id), CARD_EVENT.payload_recorded],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.body.payload).toHaveLength(50);
    expect(ev.rows[0]?.body.payload_hash).toBe(want);
    expect(await verifyCardPayload(s.deps, a.value.card_id)).toMatchObject({
      ok: true,
      payload_hash: want,
      rows: 50,
    });
    // the read model carries the hash
    await sync();
    const [view] = await readCardViews(s.record.pool, { card_ids: [a.value.card_id] });
    expect(view?.payload_hash).toBe(want);
  });

  it('a tampered stored payload is detected by the hash', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [g('G2')],
    });
    if (!a.ok) throw new Error('open');
    const payload = rows(50);
    const d = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', { payload });
    expect(d.ok).toBe(true);
    expect((await verifyCardPayload(s.deps, a.value.card_id)).ok).toBe(true);

    // an attacker with database rights flips one row from waive to file_issue
    const pool = s.record.pool;
    await pool.query('ALTER TABLE record.record_event DISABLE TRIGGER USER');
    try {
      await pool.query(
        `UPDATE record.record_event
            SET body = jsonb_set(body, '{payload,2,disposition}', '"file_issue"')
          WHERE stream = $1 AND type = $2`,
        [cardStream(a.value.card_id), CARD_EVENT.payload_recorded],
      );
      const check = await verifyCardPayload(s.deps, a.value.card_id);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(/does not match the hash/);

      // even if the recorded hash is rewritten too, the signed ledger entry disagrees
      const tampered = rows(50);
      (tampered[2] as { disposition: string }).disposition = 'file_issue';
      await pool.query(
        `UPDATE record.record_event SET body = jsonb_set(body, '{payload_hash}', to_jsonb($3::text))
          WHERE stream = $1 AND type = $2`,
        [cardStream(a.value.card_id), CARD_EVENT.payload_recorded, cardPayloadHash(tampered)],
      );
      const check2 = await verifyCardPayload(s.deps, a.value.card_id);
      expect(check2.ok).toBe(false);
      if (!check2.ok) expect(check2.reason).toMatch(/different payload hash/);
    } finally {
      await pool.query('ALTER TABLE record.record_event ENABLE TRIGGER USER');
    }
  });

  it('refuses malformed, duplicate and oversized payloads before anything is written', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [g('G2')],
    });
    if (!a.ok) throw new Error('open');
    const p = await prepareCard(s.deps, { card_id: a.value.card_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    const nonce = p.value.gates[0]!.nonce;
    const before = await ledgerCount(s);
    for (const payload of [
      [{ kind: 'gap_disposition', gap_id: 'x' }],
      [...rows(2), ...rows(1)],
      rows(1001),
    ]) {
      const r = await decideCard(s.deps, {
        card_id: a.value.card_id,
        votes: [{ nonce, decision: 'approve' }],
        payload,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_input');
    }
    expect(await ledgerCount(s)).toBe(before);
  });

  it('per-claim affirm rows hash too', async () => {
    const a = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [g('G2')],
    });
    if (!a.ok) throw new Error('open');
    const payload: CardPayloadItem[] = [
      { kind: 'claim_verdict', claim_id: 'c1', verdict: 'affirm' },
      { kind: 'claim_verdict', claim_id: 'c2', verdict: 'correct' },
    ];
    const d = await decideAs(s.deps, a.value.card_id, 'ann', 'approve', { payload });
    expect(d.ok && d.value.payload_hash).toBe(cardPayloadHash(payload));
  });
});

describe('inbox read model', () => {
  it('lists open cards for eligible principals only, with status and SLA, and rebuilds equal to live', async () => {
    const subject = uuid();
    const open1 = await openCards(s.deps, {
      project_id: 'team' as never,
      subject_kind: 'item',
      subject_id: subject,
      gates: [g('G0'), g('G1'), g('G4')],
    });
    if (!open1.ok) throw new Error(JSON.stringify(open1.error));
    expect(open1.value).toHaveLength(3); // team: nothing consolidates

    const bob = await listInbox(s.deps, pr('bob'));
    expect(bob.ok).toBe(true);
    if (!bob.ok) return;
    const mine = bob.value.filter((i) => i.card.subject_id === subject);
    expect(mine.map((i) => i.card.gates[0]?.gate_id).sort()).toEqual(['G0', 'G1', 'G4']);
    expect(mine.every((i) => i.reason === 'eligible' && i.card.status === 'open')).toBe(true);
    expect(mine.every((i) => !i.overdue)).toBe(true);
    expect(mine[0]?.card.sla_due_at).toBe('2026-11-10T00:00:00.000Z'); // opened Sunday 10:00: clock starts Monday 00:00

    const cy = await listInbox(s.deps, pr('cy'));
    expect(cy.ok && cy.value.filter((i) => i.card.subject_id === subject)).toHaveLength(0);

    // decide one card; it leaves the inbox
    const g0 = open1.value.find((c) => c.group === 'solo1');
    const d = await decideAs(s.deps, g0!.card_id, 'bob', 'approve');
    expect(d.ok).toBe(true);
    const after = await listInbox(s.deps, pr('bob'));
    expect(after.ok && after.value.filter((i) => i.card.subject_id === subject)).toHaveLength(2);
    const [decided] = await readCardViews(s.record.pool, { card_ids: [g0!.card_id] });
    expect(decided?.status).toBe('decided');

    await sync(); // gate_instance current, so the derived views are comparable
    await expectRebuildEqualsLive(s.record.pool, inboxProjection);
  });

  it('an identity failure hides the cards: unknown means not eligible', async () => {
    setupProject(s, 'flaky', { tier: 'T1', slots: { g4: ['bob'] } });
    const subject = uuid();
    await openCard(s.deps, {
      project_id: 'flaky' as never,
      subject_kind: 'item',
      subject_id: subject,
      gates: [g('G4')],
    });
    const before = await listInbox(s.deps, pr('bob'));
    expect(before.ok && before.value.filter((i) => i.card.subject_id === subject)).toHaveLength(1);
    s.elig.breakProject('flaky' as never);
    const r = await listInbox(s.deps, pr('bob'));
    expect(r.ok && r.value.filter((i) => i.card.subject_id === subject)).toHaveLength(0);
  });

  it('a new subject hash supersedes the pending gate and its card shows superseded', async () => {
    const subject = uuid();
    const first = await openCard(s.deps, {
      project_id: 'team' as never,
      subject_kind: 'item',
      subject_id: subject,
      gates: [g('G4')],
    });
    const second = await openCard(s.deps, {
      project_id: 'team' as never,
      subject_kind: 'item',
      subject_id: subject,
      gates: [g('G4')],
    });
    if (!first.ok || !second.ok) throw new Error('open');
    expect(second.value.superseded).toEqual(first.value.gate_instance_ids);
    expect(second.value.card_id).not.toBe(first.value.card_id);
    await sync();
    const views = await readCardViews(s.record.pool, { subject: { kind: 'item', id: subject } });
    const status = (id: string) => views.find((v) => v.card_id === id)?.status;
    expect(status(first.value.card_id)).toBe('superseded');
    expect(status(second.value.card_id)).toBe('open');
  });
});

describe('cards without a gate (S0 step cards, PLAN M7.3)', () => {
  const evidence = hash('what the person is shown');
  const stepCard = async (key: string, project = 'solo', slot = 'admin') => {
    const a = await openCard(s.deps, {
      project_id: project as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [],
      key,
      steps: [{ step: '0.1' as never, slot: slot as never }],
      label: 'C1',
    });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    return a.value;
  };
  /** prepare, evidence viewed, decide a card without a gate. */
  async function decideStep(
    cardId: string,
    principal: string,
    decision: string,
    o: { payload?: readonly unknown[]; evidence?: string; skipView?: boolean } = {},
  ) {
    const p = await prepareCard(s.deps, {
      card_id: cardId,
      principal: pr(principal),
      evidence_hash: (o.evidence ?? evidence) as never,
    });
    if (!p.ok) return p;
    const nonce = p.value.step_nonce?.nonce as string;
    if (!o.skipView) {
      const v = await recordCardEvidenceViewed(s.deps, [
        { nonce, evidence_hash: o.evidence ?? evidence },
      ]);
      if (!v.ok) return v;
    }
    return decideCard(s.deps, {
      card_id: cardId,
      votes: [],
      step_nonce: nonce,
      steps: [{ step: '0.1' as never, decision }],
      ...(o.payload ? { payload: o.payload } : {}),
    });
  }

  it('opens once under a key, is decided by its step nonce, and writes one ledger entry stamped sod_waiver', async () => {
    const a = await stepCard('k1');
    expect(a.opened).toBe(true);
    expect(a.gate_instance_ids).toEqual([]);
    expect((await stepCard('k1')).card_id).toBe(a.card_id);
    expect((await stepCard('k2')).card_id).not.toBe(a.card_id);
    const before = await ledgerCount(s);
    const d = await decideStep(a.card_id, 'ann', 'approve');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(await ledgerCount(s)).toBe(before + 1);
    expect(d.value.status).toBe('decided');
    expect(d.value.entries[0]).toMatchObject({
      entry_type: 'card.step_decision',
      decision: 'approve',
      actor: 'ann',
      sod_waiver: true,
      body: { card_id: a.card_id, step: '0.1', evidence: { evidence_hash: evidence } },
    });
    const st = await readCardState(s.record.pool, a.card_id);
    expect(st?.steps[0]).toMatchObject({ decision: 'approve', actor: 'ann', sod_waiver: true });
  });

  it('refuses without a key, without the evidence hash, with votes, and a second decision', async () => {
    const noKey = await openCard(s.deps, {
      project_id: 'solo' as never,
      subject_kind: 's0_record',
      subject_id: uuid(),
      gates: [],
      steps: [{ step: '0.1' as never, slot: 'admin' }],
    });
    expect(noKey.ok).toBe(false);
    const a = await stepCard('k3');
    const noEvidence = await prepareCard(s.deps, { card_id: a.card_id, principal: pr('ann') });
    expect(noEvidence.ok).toBe(false);
    const notViewed = await decideStep(a.card_id, 'ann', 'approve', { skipView: true });
    expect(notViewed.ok).toBe(false);
    if (!notViewed.ok) expect(notViewed.error.code).toBe('evidence_not_viewed');
    const strangers = await decideStep(a.card_id, 'mallory', 'approve');
    expect(strangers.ok).toBe(false);
    if (!strangers.ok) expect(strangers.error.code).toBe('not_eligible');
    expect((await decideStep(a.card_id, 'ann', 'approve')).ok).toBe(true);
    expect((await decideStep(a.card_id, 'ann', 'approve')).ok).toBe(false);
  });

  it('binds the nonce to the evidence it was prepared for', async () => {
    const a = await stepCard('k4');
    const p = await prepareCard(s.deps, {
      card_id: a.card_id,
      principal: pr('ann'),
      evidence_hash: evidence as never,
    });
    if (!p.ok) throw new Error('prepare');
    const wrong = await recordCardEvidenceViewed(s.deps, [
      { nonce: p.value.step_nonce?.nonce as string, evidence_hash: hash('another page') },
    ]);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('evidence_mismatch');
  });

  it('a send-back and a rejection are decisions of the card, with the payload hash on the entry', async () => {
    const a = await stepCard('k5');
    const d = await decideStep(a.card_id, 'ann', 'request_changes');
    expect(d.ok && d.value.status).toBe('sent_back');
    const b = await stepCard('k6');
    const r = await decideStep(b.card_id, 'ann', 'reject');
    expect(r.ok && r.value.status).toBe('rejected');
    if (r.ok) expect(r.value.payload_hash).toBe(cardPayloadHash([]));
  });

  it('T2: a sole holder cannot decide (no waiver of any kind); two holders can', async () => {
    setupProject(s, 't2one', { tier: 'T2', slots: { admin: ['ann'] } });
    setupProject(s, 't2two', { tier: 'T2', slots: { admin: ['ann', 'bob'] } });
    const one = await stepCard('k7', 't2one');
    const refused = await decideStep(one.card_id, 'ann', 'approve');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('quorum_infeasible');
    const two = await stepCard('k8', 't2two');
    const ok = await decideStep(two.card_id, 'ann', 'approve');
    expect(ok.ok && ok.value.entries[0]?.sod_waiver).toBe(false);
  });

  it('is open in the inbox of the slot, not of others, and a withdrawn card leaves it', async () => {
    const a = await stepCard('k9', 'team', 'admin');
    await sync();
    const root = await listInbox(s.deps, pr('root'));
    expect(root.ok && root.value.map((i) => i.card.card_id)).toContain(a.card_id);
    const ann = await listInbox(s.deps, pr('ann'));
    expect(ann.ok && ann.value.map((i) => i.card.card_id)).not.toContain(a.card_id);
    const w = await withdrawCard(s.deps, {
      card_id: a.card_id,
      reason: 'parked',
      by: 'system.core',
    });
    expect(w.ok && w.value.withdrawn).toBe(true);
    // idempotent, and no ledger entry
    const again = await withdrawCard(s.deps, {
      card_id: a.card_id,
      reason: 'parked',
      by: 'system.core',
    });
    expect(again.ok && again.value.withdrawn).toBe(false);
    await sync();
    const after = await listInbox(s.deps, pr('root'));
    expect(after.ok && after.value.map((i) => i.card.card_id)).not.toContain(a.card_id);
    expect((await readCardState(s.record.pool, a.card_id))?.status).toBe('withdrawn');
    // a withdrawn card cannot be decided
    const late = await decideStep(a.card_id, 'root', 'approve');
    expect(late.ok).toBe(false);
  });

  it('rebuild equals live with step cards in the record', async () => {
    await expectRebuildEqualsLive(s.record.pool, inboxProjection);
  });
});
