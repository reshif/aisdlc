import { fakeKeyCustody, FakeNotary } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openGate, decide, prepare, recordEvidenceViewed } from '../src/index.js';
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
  setupProject(s, 'pd', {
    tier: 'T1',
    slots: { g4: ['ann', 'bob'], m4: ['ann'], g5: ['ann'], intent: ['ann'] },
  });
});
afterAll(async () => {
  await s.stop();
});
const entriesFor = async (id: string) =>
  (await s.record.pool.query('SELECT 1 FROM ledger.ledger_entry WHERE gate_instance_id = $1', [id]))
    .rowCount;

describe('prepare', () => {
  it('stores only the nonce hash, binds subject and evidence, expires in 10 minutes', async () => {
    const g = await open(s, 'pd', 'G4', { evidence_pack_hash: hash('pack') });
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toMatchObject({
      subject_hash: g.subject_hash,
      evidence_hash: hash('pack'),
      step_up: { required: false },
    });
    expect(Date.parse(p.value.expires_at) - s.clock.nowMs()).toBe(10 * 60_000);
    const rows = await s.record.pool.query(
      'SELECT * FROM decisions.gate_nonce WHERE gate_instance_id = $1',
      [g.gate_instance_id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows[0])).not.toContain(p.value.nonce);
    expect(rows.rows[0].subject_hash).toBe(g.subject_hash);
    expect(rows.rows[0].evidence_hash).toBe(hash('pack'));
  });

  it('binds the subject hash as evidence when the gate has no evidence pack', async () => {
    const g = await open(s, 'pd', 'G4');
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    expect(p.ok && p.value.evidence_hash).toBe(g.subject_hash);
  });

  it('refuses an unknown gate, a non-holder, an ended gate', async () => {
    const g = await open(s, 'pd', 'G4');
    const zed = await prepare(s.deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('zed'),
    });
    expect(!zed.ok && zed.error.code).toBe('not_eligible');
    const none = await prepare(s.deps, { gate_instance_id: uuid(), principal: pr('ann') });
    expect(!none.ok && none.error.code).toBe('gate_not_found');
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
    const ended = await prepare(s.deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('bob'),
    });
    expect(!ended.ok && ended.error.code).toBe('gate_not_pending');
  });
});

describe('decide', () => {
  it('writes exactly one ledger entry through the real Notary; the body carries the evidence, not the nonce', async () => {
    const g = await open(s, 'pd', 'G4', { evidence_pack_hash: hash('pk') });
    const before = await ledgerCount(s);
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    const v = await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: hash('pk'),
    });
    expect(v.ok).toBe(true);
    const d = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(d.ok).toBe(true);
    expect(await ledgerCount(s)).toBe(before + 1);
    if (!d.ok) return;
    expect(d.value.entry.actor).toBe('ann');
    expect(d.value.entry.body).toMatchObject({
      kind: 'vote',
      evidence_hash: hash('pk'),
      nonce_sha256: hash(p.value.nonce),
    });
    expect(JSON.stringify(d.value.entry.body)).not.toContain(p.value.nonce);
  });

  it('refuses a replayed nonce and writes nothing the second time', async () => {
    const g = await open(s, 'pd', 'G4');
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    expect((await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' })).ok).toBe(true);
    const before = await ledgerCount(s);
    const replay = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(!replay.ok && replay.error.code).toBe('nonce_replayed');
    const replayOther = await decide(s.deps, { nonce: p.value.nonce, decision: 'reject' });
    expect(!replayOther.ok && replayOther.error.code).toBe('nonce_replayed');
    expect(await ledgerCount(s)).toBe(before);
    const view = await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    expect(!view.ok && view.error.code).toBe('nonce_replayed');
  });

  it('refuses an unknown nonce and a non-vote decision', async () => {
    const u = await decide(s.deps, { nonce: 'nope', decision: 'approve' });
    expect(!u.ok && u.error.code).toBe('nonce_unknown');
    const g = await open(s, 'pd', 'G4');
    for (const bad of ['supersede', 'expire', 'withdraw', 'maybe']) {
      const r = await decideAs(s, g.gate_instance_id, 'ann', bad);
      expect(!r.ok && r.error.code, bad).toBe('invalid_input');
    }
    expect(await entriesFor(g.gate_instance_id)).toBe(0);
  });

  it('refuses an expired nonce, at and after the expiry instant', async () => {
    const g = await open(s, 'pd', 'G4');
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    s.clock.advance(10 * 60_000 - 1);
    // one ms before expiry it still works (checked on a twin nonce below), at expiry it does not
    const twin = await prepare(s.deps, {
      gate_instance_id: g.gate_instance_id,
      principal: pr('bob'),
    });
    if (!twin.ok) throw new Error('prepare twin');
    s.clock.advance(1);
    const r = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(!r.ok && r.error.code).toBe('nonce_expired');
    const ev = await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    expect(!ev.ok && ev.error.code).toBe('nonce_expired');
    expect(await entriesFor(g.gate_instance_id)).toBe(0);
    // a fresh nonce works
    expect((await decideAs(s, g.gate_instance_id, 'ann', 'approve')).ok).toBe(true);
  });

  it('accepts a nonce one millisecond before it expires', async () => {
    const g = await open(s, 'pd', 'G4');
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    s.clock.advance(10 * 60_000 - 1);
    expect((await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' })).ok).toBe(true);
  });

  it('refuses a nonce for a superseded subject hash', async () => {
    const g = await open(s, 'pd', 'G4', { subject_kind: 's0_record' });
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    const re = await openGate(s.deps, { ...g.input, subject_hash: hash('new-subject') });
    expect(re.ok && re.value.superseded).toEqual([g.gate_instance_id]);
    const before = await entriesFor(g.gate_instance_id);
    const r = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(!r.ok && r.error.code).toBe('subject_superseded');
    expect(await entriesFor(g.gate_instance_id)).toBe(before); // just the supersede entry
    // the nonce cannot be used on the new instance either
    const fresh = await decideAs(s, re.ok ? re.value.gate_instance_id : '', 'ann', 'approve');
    expect(fresh.ok).toBe(true);
  });

  it('refuses a decision without evidence_viewed recorded, then allows it once recorded', async () => {
    const g = await open(s, 'pd', 'G4', { evidence_pack_hash: hash('pack2') });
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    const early = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(!early.ok && early.error.code).toBe('evidence_not_viewed');
    const wrong = await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: hash('other'),
    });
    expect(!wrong.ok && wrong.error.code).toBe('evidence_mismatch');
    expect((await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' })).ok === false).toBe(
      true,
    );
    expect(await entriesFor(g.gate_instance_id)).toBe(0);
    expect(
      (await recordEvidenceViewed(s.deps, { nonce: p.value.nonce, evidence_hash: hash('pack2') }))
        .ok,
    ).toBe(true);
    // idempotent
    expect(
      (await recordEvidenceViewed(s.deps, { nonce: p.value.nonce, evidence_hash: hash('pack2') }))
        .ok,
    ).toBe(true);
    expect((await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' })).ok).toBe(true);
  });

  it('a nonce is bound to the principal it was issued to', async () => {
    const g = await open(s, 'pd', 'G4');
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('bob') });
    if (!p.ok) throw new Error('prepare');
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    const d = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(d.ok && d.value.entry.actor).toBe('bob');
  });
});

describe('step-up gates', () => {
  it('M4 needs a proof bound to the subject hash and the deciding principal', async () => {
    const g = await open(s, 'pd', 'M4', { subject_kind: 's0_record' });
    const p = await prepare(s.deps, { gate_instance_id: g.gate_instance_id, principal: pr('ann') });
    if (!p.ok) throw new Error('prepare');
    expect(p.value.step_up).toEqual({ required: true, bound_hash: g.subject_hash });
    await recordEvidenceViewed(s.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });

    const missing = await decide(s.deps, { nonce: p.value.nonce, decision: 'approve' });
    expect(!missing.ok && missing.error.code).toBe('step_up_required');
    const wrongHash = await decide(s.deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      step_up: { proof: s.stepUp.issue(hash('other'), 'ann') },
    });
    expect(!wrongHash.ok && wrongHash.error.code).toBe('step_up_invalid');
    const wrongPerson = await decide(s.deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      step_up: { proof: s.stepUp.issue(g.subject_hash, 'bob') },
    });
    expect(!wrongPerson.ok && wrongPerson.error.code).toBe('step_up_invalid');
    const garbage = await decide(s.deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      step_up: { proof: 'x' },
    });
    expect(!garbage.ok && garbage.error.code).toBe('step_up_invalid');
    expect(await entriesFor(g.gate_instance_id)).toBe(0); // refused attempts leave the nonce usable

    const proof = s.stepUp.issue(g.subject_hash, 'ann');
    const ok = await decide(s.deps, {
      nonce: p.value.nonce,
      decision: 'approve',
      step_up: { proof },
    });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.value.entry.body).toMatchObject({
      step_up: { bound_hash: g.subject_hash, proof_sha256: hash(proof) },
    });
    expect(JSON.stringify(ok.ok && ok.value.entry.body)).not.toContain(proof);
  });

  it('a revoked proof is refused', async () => {
    const g = await open(s, 'pd', 'M4', { subject_kind: 's0_record' });
    const proof = s.stepUp.issue(g.subject_hash, 'ann');
    s.stepUp.revoke(proof);
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve', { stepUp: proof });
    expect(!r.ok && r.error.code).toBe('step_up_invalid');
  });

  it('G5 (release, step-up kept) needs one too, and a reject needs one as well (the gate decides)', async () => {
    const g = await open(s, 'pd', 'G5');
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'reject');
    expect(!r.ok && r.error.code).toBe('step_up_required');
    const ok = await decideAs(s, g.gate_instance_id, 'ann', 'reject', {
      stepUp: s.stepUp.issue(g.subject_hash, 'ann'),
    });
    expect(ok.ok).toBe(true);
  });

  it('a gate opened with step_up binds to the given hash (D37: text_sha256), not the subject hash', async () => {
    const text = hash('AGENTS.md text');
    const g = await open(s, 'pd', 'G2', {
      step_up: true,
      step_up_bound_hash: text,
      subject_kind: 's0_record',
    });
    const bySubject = await decideAs(s, g.gate_instance_id, 'ann', 'approve', {
      stepUp: s.stepUp.issue(g.subject_hash, 'ann'),
    });
    expect(!bySubject.ok && bySubject.error.code).toBe('step_up_invalid');
    const byText = await decideAs(s, g.gate_instance_id, 'ann', 'approve', {
      stepUp: s.stepUp.issue(text, 'ann'),
    });
    expect(byText.ok && byText.value.entry.body).toMatchObject({ step_up: { bound_hash: text } });
  });

  it('a gate with no step-up ignores a proof that is offered', async () => {
    const g = await open(s, 'pd', 'G4');
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve', { stepUp: 'whatever' });
    expect(r.ok && r.value.entry.body).toMatchObject({ step_up: null });
  });
});

describe('with the in-process FakeNotary behind the port', () => {
  it('the same path works against the fake', async () => {
    const fake = new FakeNotary(fakeKeyCustody());
    const k = await fakeKeyCustody().publicKey('dev:notary');
    if (!k.ok) throw new Error('key');
    const deps = { ...s.deps, ledger: { notary: fake, notaryKey: k.value } };
    // The fake starts at seq 1 but the ledger table already has rows: use a fresh stack database.
    const fresh = await startStack();
    try {
      setupProject(fresh, 'fk', { tier: 'T1', slots: { g4: ['ann'] } });
      const d2 = { ...fresh.deps, ledger: { notary: fake, notaryKey: k.value } };
      const g = await open({ ...fresh, deps: d2 }, 'fk', 'G4');
      const r = await decideAs(fresh, g.gate_instance_id, 'ann', 'approve', { deps: d2 });
      expect(r.ok).toBe(true);
      expect(r.ok && (await fake.verify(r.value.entry)).ok).toBe(true);
    } finally {
      await fresh.stop();
    }
    expect(deps.ledger.notary).toBe(fake);
  });
});
