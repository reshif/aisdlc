import {
  ADMIN_OVERRIDE_ENTRY_TYPE,
  ADMIN_OVERRIDE_EVENT,
  AdminOverrideBody,
  pdpResource,
} from '@aisdlc/contracts';
import { verifyLedger } from '@aisdlc/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeFactoryAdmins,
  decide,
  decideCard,
  openCard,
  prepare,
  prepareCard,
  readGateState,
  recordCardEvidenceViewed,
  recordEvidenceViewed,
  recordOverride,
  type DecisionDeps,
} from '../src/index.js';
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

// Owner decision 2026-11-13 (docs/specs/deletion.md §8): nothing applies to the factory admin. Every rule the
// override bypasses has a test that the admin passes AND that the override is on the ledger with the reason; a
// non-admin is refused exactly as before.

let s: Stack;
let admins: FakeFactoryAdmins;
let deps: DecisionDeps;
beforeAll(async () => {
  s = await startStack();
  admins = new FakeFactoryAdmins(['root']);
  deps = { ...s.deps, admins };
  // Two-person G4 (two holders), a T2 project, an M4 with step-up.
  setupProject(s, 'ov', {
    tier: 'T1',
    slots: { g4: ['ann', 'bob'], m4: ['ann'], intent: ['ann', 'bob'], x: ['ann', 'bob', 'cy'] },
  });
});
afterAll(async () => {
  await s.stop();
});

/** The whole path as the admin: prepare, evidence, decide, all with the override. */
async function overrideAs(
  gate: string,
  principal: string,
  decision: string,
  reason = 'urgent fix',
) {
  const p = await prepare(deps, {
    gate_instance_id: gate,
    principal: pr(principal),
    override: { reason },
  });
  if (!p.ok) return p;
  const v = await recordEvidenceViewed(deps, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  return decide(deps, { nonce: p.value.nonce, decision, override: { reason } });
}

async function overrideEventsFor(entryId: string) {
  const q = await s.record.pool.query<{ body: unknown; type: string }>(
    `SELECT type, body FROM record.record_event WHERE type = $1 AND body ->> 'decision_entry_id' = $2`,
    [ADMIN_OVERRIDE_EVENT, entryId],
  );
  return q.rows.map((r) => AdminOverrideBody.parse(r.body));
}

describe('a gate decided by the factory admin outside its rules', () => {
  it('slot + two-person: the admin holds no slot of a two-approver gate, approves alone, the gate is decided', async () => {
    const g = await open(s, 'ov', 'X1');
    const d = await overrideAs(g.gate_instance_id, 'root', 'approve', 'customer outage');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.after.status).toBe('decided');
    expect(d.value.after.outcome).toBe('approve');
    expect(d.value.entry.actor).toBe('root');
    expect(d.value.entry.sod_waiver).toBe(true);
    expect(d.value.entry.body['override']).toMatchObject({
      reason: 'customer outage',
      bypassed: expect.arrayContaining(['slot']),
    });
    // The authoritative read (a fold of the ledger) agrees.
    const st = await readGateState(s.record.pool, g.gate_instance_id);
    expect(st?.status).toBe('decided');
    const ev = await overrideEventsFor(d.value.entry.entry_id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      actor: 'root',
      action: 'gate.decide',
      reason: 'customer outage',
      gate: { gate_instance_id: g.gate_instance_id, gate_id: 'X1' },
    });
    expect(ev[0]?.bypassed).toContain('slot');
  });

  it('two-person: a holder of a two-person gate approves alone with the override, recorded as two_person', async () => {
    const g = await open(s, 'ov', 'X1');
    admins.add('ann');
    try {
      const d = await overrideAs(g.gate_instance_id, 'ann', 'approve', 'one approver is away');
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.value.after.status).toBe('decided');
      const ov = d.value.entry.body['override'] as { bypassed: string[]; reason: string };
      expect(ov.bypassed).toEqual(expect.arrayContaining(['two_person', 'step_up']));
      expect(ov.reason).toBe('one approver is away');
    } finally {
      admins = new FakeFactoryAdmins(['root']);
      deps = { ...s.deps, admins };
    }
  });

  it('own request: the admin decides its own request, recorded as own_request', async () => {
    setupProject(s, 'ov-own', { tier: 'T1', slots: { intent: ['root', 'bob'] } });
    const g = await open(s, 'ov-own', 'G0', { requester: pr('root') });
    const plain = await decideAs(s, g.gate_instance_id, 'root', 'approve', { deps });
    expect(!plain.ok && plain.error.code).toBe('own_request');
    const d = await overrideAs(g.gate_instance_id, 'root', 'approve', 'my own fix, nobody else');
    expect(d.ok && d.value.after.status).toBe('decided');
    if (!d.ok) return;
    expect((d.value.entry.body['override'] as { bypassed: string[] }).bypassed).toContain(
      'own_request',
    );
  });

  it('step-up: an M4 needs a step-up; the admin decides without one, recorded as step_up', async () => {
    const g = await open(s, 'ov', 'M4');
    const plain = await decideAs(s, g.gate_instance_id, 'ann', 'approve');
    expect(!plain.ok && plain.error.code).toBe('step_up_required');
    const d = await overrideAs(g.gate_instance_id, 'root', 'approve', 'sign-off by the owner');
    expect(d.ok && d.value.after.status).toBe('decided');
    if (!d.ok) return;
    expect(d.value.entry.body['step_up']).toBeNull();
    expect((d.value.entry.body['override'] as { bypassed: string[] }).bypassed).toEqual(
      expect.arrayContaining(['slot', 'step_up']),
    );
  });

  it('already voted: an admin who approved once decides with the override on the second vote', async () => {
    setupProject(s, 'ov-twice', { tier: 'T1', slots: { x: ['root', 'bob', 'cy'] } });
    const g = await open(s, 'ov-twice', 'X1');
    const first = await decideAs(s, g.gate_instance_id, 'root', 'approve', {
      deps,
      steppedUp: true,
    });
    expect(first.ok && first.value.after.status).toBe('pending');
    const d = await overrideAs(g.gate_instance_id, 'root', 'approve', 'cannot wait for a second');
    expect(d.ok && d.value.after.status).toBe('decided');
    if (!d.ok) return;
    expect((d.value.entry.body['override'] as { bypassed: string[] }).bypassed).toContain(
      'already_voted',
    );
  });

  it('the ledger with overrides still verifies', async () => {
    const k = await s.kms.custodyFor('witness').publicKey('dev:witness');
    if (!k.ok) throw new Error('key');
    const v = await verifyLedger(
      s.record.pool,
      { notary: s.notaryKey, witness: k.value },
      { allowUncoveredTail: true },
    );
    expect(v.ok).toBe(true);
  });
});

describe('what the override never does', () => {
  it('a non-admin asking for an override is refused and nothing is written', async () => {
    const g = await open(s, 'ov', 'X1');
    const before = await ledgerCount(s);
    const p = await prepare(deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('zed'),
      override: { reason: 'please' },
    });
    expect(!p.ok && p.error.code).toBe('not_eligible');
    // A holder who is not an admin: prepare is fine (they hold the slot), the override at decide is refused.
    const q = await prepare(deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!q.ok) throw new Error('prepare');
    await recordEvidenceViewed(deps, {
      nonce: q.value.nonce,
      evidence_hash: q.value.evidence_hash,
    });
    const d = await decide(deps, {
      nonce: q.value.nonce,
      decision: 'approve',
      override: { reason: 'please' },
    });
    expect(!d.ok && d.error.code).toBe('not_eligible');
    expect(await ledgerCount(s)).toBe(before);
  });

  it('a blank reason is refused', async () => {
    const g = await open(s, 'ov', 'X1');
    const r = await overrideAs(g.gate_instance_id, 'root', 'approve', '   ');
    expect(!r.ok && r.error.code).toBe('invalid_input');
  });

  it('no admin port, or one that is down, refuses every override (fail closed)', async () => {
    const g = await open(s, 'ov', 'X1');
    const none = await prepare(s.deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('root'),
      override: { reason: 'x' },
    });
    expect(!none.ok && none.error.code).toBe('not_eligible');
    const down = new FakeFactoryAdmins(['root']);
    down.down = true;
    const r = await prepare(
      { ...s.deps, admins: down },
      { gate_instance_id: g.gate_instance_id, principal: pr('root'), override: { reason: 'x' } },
    );
    expect(!r.ok && r.error.code).toBe('eligibility_unavailable');
  });

  it('an expired gate stays expired: expiry is not a rule the override bypasses', async () => {
    const g = await open(s, 'ov', 'X1', {
      facts: { expires_at: new Date(s.clock.nowMs() + 60_000).toISOString() },
    });
    const p = await prepare(deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('root'),
      override: { reason: 'late' },
    });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    await recordEvidenceViewed(deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    s.clock.advance(120_000);
    const d = await decide(deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      override: { reason: 'late' },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.code).toBe('gate_expired');
  });
});

describe('a card decided by the factory admin', () => {
  it('decides every gate of a card it holds no slot for, each gate an override with the reason', async () => {
    setupProject(s, 'ov-card', { tier: 'T1', slots: { intent: ['ann', 'bob'] } });
    const a = await openCard(deps, {
      project_id: 'ov-card' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [
        { gate_id: 'G0' as never, subject_hash: hash(`g0-${Math.random()}`) },
        { gate_id: 'G1' as never, subject_hash: hash(`g1-${Math.random()}`) },
      ],
    });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const plain = await prepareCard(deps, { card_id: a.value.card_id, principal: pr('root') });
    expect(!plain.ok && plain.error.code).toBe('not_eligible');
    const p = await prepareCard(deps, {
      card_id: a.value.card_id,
      principal: pr('root'),
      override: { reason: 'release blocker' },
    });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    await recordCardEvidenceViewed(
      deps,
      p.value.gates.map((x) => ({ nonce: x.nonce, evidence_hash: x.evidence_hash })),
    );
    const d = await decideCard(deps, {
      card_id: a.value.card_id,
      votes: p.value.gates.map((x) => ({ nonce: x.nonce, decision: 'approve' })),
      override: { reason: 'release blocker' },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.status).toBe('decided');
    expect(d.value.entries).toHaveLength(2);
    for (const e of d.value.entries) {
      expect(e.body['override']).toMatchObject({ reason: 'release blocker' });
      expect(await overrideEventsFor(e.entry_id)).toHaveLength(1);
    }
  });
});

describe('an override that is not a gate decision', () => {
  it('is an admin.override ledger entry and record event with who, what, the reason and the rule', async () => {
    const before = await ledgerCount(s);
    const r = await recordOverride(deps, {
      actor: 'root',
      action: 'config.decide',
      resource: pdpResource.project('ov'),
      gate: null,
      reason: 'apply now',
      bypassed: ['m1_second_approver'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await ledgerCount(s)).toBe(before + 1);
    expect(r.value.entry.entry_type).toBe(ADMIN_OVERRIDE_ENTRY_TYPE);
    expect(r.value.entry.actor).toBe('root');
    expect(AdminOverrideBody.parse(r.value.entry.body)).toMatchObject({
      action: 'config.decide',
      reason: 'apply now',
      bypassed: ['m1_second_approver'],
    });
    const ev = await s.record.pool.query(
      `SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2`,
      [`admin_override:${r.value.override_id}`, ADMIN_OVERRIDE_EVENT],
    );
    expect(ev.rowCount).toBe(1);
  });
});
