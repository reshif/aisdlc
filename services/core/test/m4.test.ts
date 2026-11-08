import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CARD_STEP_ENTRY_TYPE,
  PRR_EVENT,
  PROJECT_EVENT,
  ProjectReadinessRecord,
  S0_EVENT,
  checkLedgerEntrySignature,
  prrRecordHash,
  prrStream,
  projectStream,
  repoIdOf,
} from '@aisdlc/contracts';
import { LEDGER_ENTRY_COLUMNS, main as verifyLedgerCli, toLedgerEntry } from '@aisdlc/ledger';
import { decideCard, readCardState, type FakeStepUp } from '@aisdlc/decisions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyCard,
  c5Context,
  driveS0,
  getProject,
  getRepo,
  loadS0,
  planC5,
  prepareOnboardingCard,
  readPrrState,
  recordOnboardingEvidence,
  resumeS0,
  s0Cards,
  withdrawS0,
} from '../src/index.js';
import { driverDeps, pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness } from './harness.js';

// M4 on the S0 record UUID (PLAN M7.5): card 5 carries the 0.5 sign-off and the M4 gate as two
// ledgered entries, M4 binds to the PRR's record_hash through a step-up, only an approved M4 makes
// the record active, and a rejection leaves it proposed. Real Postgres, real ledger writer and
// Notary; the code host and knowledge are fakes behind their ports.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'm4');
const {
  scenario,
  sync,
  actionable,
  detail,
  decideAs,
  ok,
  throughC1,
  throughC4,
  toC5,
  events,
  stateOf,
} = h;

const prrStreamOf = (project: string, repo: string) => prrStream(project, repoIdOf(repo));
const prrEvents = async (project: string, repo: string, type: string) =>
  (
    await s.record.pool.query<{ body: Record<string, unknown> }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
      [prrStreamOf(project, repo), type],
    )
  ).rows.map((r) => r.body);

describe('M4 approved on card 5', () => {
  it('makes the PRR active (only the M4 decision does), signs the project and the repo, and the S0 record goes done', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card, d } = await toC5(c);

    // Before M4 the record is proposed: nothing is active, nothing is signed.
    const proposed = await readPrrState(s.record.pool, c.project, repoIdOf(c.repo));
    expect(proposed.versions.map((v) => [v.version, v.status])).toEqual([[1, 'proposed']]);
    expect((await getProject(s.record.pool, c.project))?.tier).toBeNull();
    expect((await getRepo(s.record.pool, c.repo))?.onboarding_level).toBe('none');
    expect(await prrEvents(c.project, c.repo, PRR_EVENT.activated)).toEqual([]);

    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    expect(r.value.applied).toBe('applied');

    const state = await readPrrState(s.record.pool, c.project, repoIdOf(c.repo));
    const v = state.versions[0]!;
    expect(v.status).toBe('active');
    // The stored record, recomputed: its hash is what the gate bound to and the ledger entry signed.
    expect(ProjectReadinessRecord.safeParse(v.prr).success).toBe(true);
    expect(prrRecordHash(v.prr)).toBe(v.prr.record_hash);
    expect(v.prr.status).toBe('active');
    const m4Entry = r.value.decision.entries.find((e) => e.entry_type === 'decision')!;
    expect(m4Entry.subject_hash).toBe(prrRecordHash(v.prr));
    expect(v.prr.m4).toEqual({
      ledger_entry_id: m4Entry.entry_id,
      decision_hash: m4Entry.entry_hash,
    });
    expect(d.view.prr.record_hash).toBe(v.prr.record_hash);

    // signed: the project's tier and level, the repo's level; project.ready lists the lanes.
    expect(await getProject(s.record.pool, c.project)).toMatchObject({
      tier: 'T0',
      level: 'census',
    });
    expect((await getRepo(s.record.pool, c.repo))?.onboarding_level).toBe('census');
    const ready = (
      await s.record.pool.query(
        'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
        [projectStream(c.project), PROJECT_EVENT.ready],
      )
    ).rows.map((x) => x.body);
    expect(ready).toEqual([
      expect.objectContaining({
        prr_version: 1,
        record_hash: v.prr.record_hash,
        level: 'census',
        lanes_eligible: ['L8'],
      }),
    ]);

    const s0 = await stateOf(c);
    expect(s0.record.status).toBe('done');
    expect(s0.steps.get('0.5')?.state).toBe('done');
    expect((await events(c, S0_EVENT.card_applied)).at(-1)).toMatchObject({
      card: 'C5',
      outcome: 'm4_approved',
    });
  });

  it('the M4 ledger entry verifies offline: chain and signatures with verify-ledger, and its subject_hash is the record_hash recomputed from the stored PRR', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card } = await toC5(c);
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    const m4 = r.value.decision.entries.find((e) => e.gate_id === 'M4')!;

    // The entry alone, with the Notary's public key and nothing from this process.
    const row = await s.record.pool.query(
      `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry WHERE entry_id = $1`,
      [m4.entry_id],
    );
    const entry = toLedgerEntry(row.rows[0]);
    expect(await checkLedgerEntrySignature(entry, s.id.keys.notary)).toBeNull();
    const stored = (await prrEvents(c.project, c.repo, PRR_EVENT.proposed))[0] as {
      prr: ProjectReadinessRecord;
    };
    expect(entry.subject_hash).toBe(prrRecordHash(stored.prr));
    expect(entry.subject_kind).toBe('s0_record');
    expect(entry.subject_id).toBe(c.s0);
    // M4 is the decision of a gate that needed a step-up bound to that same hash.
    expect(entry.body).toMatchObject({
      kind: 'vote',
      step_up: { bound_hash: stored.prr.record_hash },
    });
    // A changed record no longer matches what was signed.
    const tampered = { ...stored.prr, writes: 'agent' as const };
    expect(prrRecordHash(tampered)).not.toBe(entry.subject_hash);

    // The same verification the CLI makes (read-only session, chain, every Notary signature).
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-m4-keys-'));
    try {
      writeFileSync(join(dir, 'notary.jwk'), JSON.stringify(s.id.keys.notary));
      writeFileSync(join(dir, 'witness.jwk'), JSON.stringify(s.id.keys.witness));
      const out: string[] = [];
      const code = await verifyLedgerCli(
        [
          'verify-ledger',
          '--db',
          s.record.url,
          '--notary-key',
          join(dir, 'notary.jwk'),
          '--witness-key',
          join(dir, 'witness.jwk'),
          '--allow-tail',
        ],
        { out: (l) => out.push(l), err: (l) => out.push(l) },
      );
      expect(out.join('\n')).toMatch(/ledger OK/);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M4 needs a step-up bound to the record hash: none, or one bound to another hash, decides nothing', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card } = await toC5(c);
    const m4Before = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE gate_id = 'M4' AND subject_id = $1`,
      [c.s0],
    );
    // no proof at all
    const { prepareOnboardingCard, recordOnboardingEvidence, decideOnboardingCard } =
      await import('../src/index.js');
    const p = ok(
      await prepareOnboardingCard(c.deps, {
        card_id: card.card_id,
        principal: 'alice' as never,
      }),
    );
    expect(p.value.step_up).toMatchObject({ required: true });
    ok(
      await recordOnboardingEvidence(c.deps, {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash as never,
      }),
    );
    const none = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: 'alice' as never,
      nonce: p.value.nonce,
      decision: 'approve',
      content: {},
    });
    expect(none).toMatchObject({ ok: false });
    expect(JSON.stringify(none)).toContain('step_up_required');
    // a proof bound to something else (another record's hash)
    const wrong = await decideAs(c, card.card_id, 'alice', 'approve', {}, undefined, {
      stepUpFor: 'f'.repeat(64),
    });
    expect(JSON.stringify(wrong)).toContain('step_up_invalid');
    // nothing was written: no M4 entry, the PRR is still proposed, the record still waits
    const m4After = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE gate_id = 'M4' AND subject_id = $1`,
      [c.s0],
    );
    expect(m4After.rows[0].n).toBe(m4Before.rows[0].n);
    expect((await stateOf(c)).record.status).toBe('card');
    expect(
      (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]?.status,
    ).toBe('proposed');
    // the right proof works
    expect(ok(await decideAs(c, card.card_id, 'alice', 'approve', {})).value.applied).toBe(
      'applied',
    );
  });
});

describe('what the owner must attest before M4 can sign (DEC-4)', () => {
  it('a census assembled before card 1 blocks M4 until card 1 attests regulatory and criticality; with them, the PRR carries the T0 attestation', async () => {
    const c = await scenario({ census: { unattested: true } });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    expect(d.view.tier.blocks_m4_reasons).toEqual([
      't0_unattested',
      'regulatory_unattested',
      'criticality_unattested',
    ]);
    // card 1 refuses a decision that leaves M4 unable to sign
    const no = await decideAs(c, card.card_id, 'alice', 'approve', h.c1Content(d.view));
    expect(no).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(no)).toMatch(/regulatory/);
    const noCrit = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      h.c1Content(d.view, { regulatory_attested: true }),
    );
    expect(JSON.stringify(noCrit)).toMatch(/criticality/);
    ok(
      await decideAs(
        c,
        card.card_id,
        'alice',
        'approve',
        h.c1Content(d.view, { regulatory_attested: true, criticality_attested: true }),
      ),
    );
    await throughC4(c);
    const { card: c5, d: d5 } = await toC5(c);
    expect(d5.view.tier).toMatchObject({ value: 'T0' });
    ok(await decideAs(c, c5.card_id, 'alice', 'approve', {}));
    const v = (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]!;
    expect(v.prr.tier).toMatchObject({ value: 'T0', t0_attested: true });
  });

  it('an incomplete detector run cannot be signed: card 5 does not open, and says why', async () => {
    const c = await scenario({ census: { detectorsIncomplete: true } });
    await throughC1(c);
    await throughC4(c);
    await c.drive();
    const r = await sync(c);
    expect(r.opened).toEqual([]);
    expect(r.pending.join(' ')).toMatch(/risk_unattested.*detectors_incomplete/);
    expect((await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions).toEqual([]);
  });
});

describe('M4 rejected, and the sign-off sent back', () => {
  it('a reject leaves the PRR proposed and the S0 record rejected at 0.5; nothing is signed, no lane opens', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card } = await toC5(c);
    const r = ok(await decideAs(c, card.card_id, 'alice', 'reject', undefined, 'not now'));
    expect(r.value.decision.status).toBe('rejected');
    const state = await readPrrState(s.record.pool, c.project, repoIdOf(c.repo));
    expect(state.versions.map((v) => v.status)).toEqual(['proposed']);
    expect(await prrEvents(c.project, c.repo, PRR_EVENT.activated)).toEqual([]);
    expect((await stateOf(c)).record).toMatchObject({ status: 'rejected', rejected_at: '0.5' });
    expect((await getProject(s.record.pool, c.project))?.tier).toBeNull();
    expect((await getRepo(s.record.pool, c.repo))?.onboarding_level).toBe('none');
    // both decisions are on the ledger: the sign-off and the M4 reject
    expect(r.value.decision.entries.map((e) => [e.entry_type, e.decision])).toEqual([
      [CARD_STEP_ENTRY_TYPE, 'reject'],
      ['decision', 'reject'],
    ]);
    // the rejected gate's card is closed; syncing opens no new card for a rejected record
    expect((await sync(c)).opened).toEqual([]);
  });

  it('a send-back re-raises card 5 with a NEW proposed version; approving it activates that one, the first stays proposed', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const first = await toC5(c);
    ok(await decideAs(c, first.card.card_id, 'alice', 'request_changes', undefined, 'recompute'));
    expect((await stateOf(c)).record.status).toBe('running');
    s.clock.advance(1000);
    const second = await toC5(c);
    expect(second.card.card_id).not.toBe(first.card.card_id);
    expect(second.d.view.prr.version).toBe(2);
    expect(second.d.view.prr.record_hash).not.toBe(first.d.view.prr.record_hash);
    ok(await decideAs(c, second.card.card_id, 'alice', 'approve', {}));
    const state = await readPrrState(s.record.pool, c.project, repoIdOf(c.repo));
    expect(state.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'proposed'],
      [2, 'active'],
    ]);
    expect((await stateOf(c)).record.readiness_version).toBe(2);
  });
});

describe('who signs M4 (DEC-6, sod_waiver)', () => {
  it('one person holds the m4 slot: the sign-off and M4 are both stamped sod_waiver', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card, d } = await toC5(c);
    expect(d.m4_deciders).toMatchObject({ slot: 'm4', holders: ['alice'], sod_waiver: true });
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    expect(r.value.decision.entries.map((e) => e.sod_waiver)).toEqual([true, true]);
    const v = (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]!;
    expect(v.prr.signer).toMatchObject({
      principal: 'alice',
      role: 'TL',
      mode: 'solo',
      sod_waiver: true,
    });
  });

  it('two people hold it and two-person is on: one approval is not enough, the second activates it, no waiver', async () => {
    const c = await scenario({
      slots: { admin: ['alice', 'bob'], sec: ['alice'], m4: ['alice', 'bob'], intent: ['alice'] },
    });
    await throughC1(c);
    // card 4's role map names both for the m4 slot
    await c.drive();
    await sync(c);
    const c4 = await actionable(c, 'C4');
    const d4 = await detail(c, c4.card_id);
    ok(
      await decideAs(
        c,
        c4.card_id,
        'alice',
        'approve',
        h.c4Content(d4.view, {
          role_map: {
            ...d4.view.role_map.proposed,
            admin: { kind: 'principals', principals: ['alice', 'bob'] },
            m4: { kind: 'principals', principals: ['alice', 'bob'] },
          },
        }),
      ),
    );
    const { card } = await toC5(c);
    const first = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    expect(first.value.applied).toBe('pending');
    expect(first.value.apply_error).toMatch(/still waiting/);
    expect((await stateOf(c)).record.status).toBe('card');
    expect(
      (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]?.status,
    ).toBe('proposed');
    // the same person cannot approve it twice; the second holder completes it
    expect(await decideAs(c, card.card_id, 'alice', 'approve', {})).toMatchObject({ ok: false });
    const second = ok(await decideAs(c, card.card_id, 'bob', 'approve', {}));
    expect(second.value.applied).toBe('applied');
    expect(second.value.decision.entries.map((e) => e.sod_waiver)).toEqual([false]);
    const v = (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]!;
    expect(v.status).toBe('active');
    expect(v.prr.signer).toMatchObject({ mode: 'team', sod_waiver: false });
    // the PRR is made active by the decision that reached the quorum
    expect(v.prr.m4?.ledger_entry_id).toBe(second.value.decision.entries[0]?.entry_id);
    expect((await stateOf(c)).record.status).toBe('done');
  });

  it('two people hold it and two-person is OFF: one approval decides, stamped sod_waiver', async () => {
    const c = await scenario({
      slots: { admin: ['alice'], sec: ['alice'], m4: ['alice', 'bob'], intent: ['alice'] },
    });
    s.elig.setPolicy(pid(c.project), { tier: 'T1', two_person: { enabled: false } });
    await throughC1(c);
    await c.drive();
    await sync(c);
    const c4 = await actionable(c, 'C4');
    const d4 = await detail(c, c4.card_id);
    ok(
      await decideAs(
        c,
        c4.card_id,
        'alice',
        'approve',
        h.c4Content(d4.view, {
          two_person_enabled: false,
          role_map: {
            ...d4.view.role_map.proposed,
            m4: { kind: 'principals', principals: ['alice', 'bob'] },
          },
        }),
      ),
    );
    const { card } = await toC5(c);
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    expect(r.value.applied).toBe('applied');
    expect(r.value.decision.entries.map((e) => e.sod_waiver)).toEqual([true, true]);
    const v = (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]!;
    expect(v.status).toBe('active');
    expect(v.prr.role_map.two_person.enabled).toBe(false);
    expect(v.prr.signer).toMatchObject({ sod_waiver: true });
  });

  it('a T2 project is never signed by one person: with a single m4 holder card 5 cannot even open', async () => {
    const c = await scenario({
      tier: 'T2',
      slots: { admin: ['alice', 'bob'], sec: ['alice'], m4: ['alice'], intent: ['alice'] },
      census: { tierFloor: 'T2' },
    });
    await throughC1(c, { tier: 'T2' });
    await c.drive();
    await sync(c);
    const c4 = await actionable(c, 'C4');
    const d4 = await detail(c, c4.card_id);
    ok(
      await decideAs(
        c,
        c4.card_id,
        'alice',
        'approve',
        h.c4Content(d4.view, {
          role_map: {
            ...d4.view.role_map.proposed,
            admin: { kind: 'principals', principals: ['alice', 'bob'] },
            m4: { kind: 'principals', principals: ['alice'] },
          },
        }),
      ),
    );
    await c.drive();
    const report = await sync(c);
    expect(report.opened).toEqual([]);
    expect(report.pending.join(' ')).toMatch(/quorum_infeasible|T2/);
    const cards = await readCardState(s.record.pool, (await h.summaries(c)).at(-1)!.card_id);
    expect(cards?.open.label).not.toBe('C5');
    expect((await events(c, S0_EVENT.signoff_ready)).length).toBe(0);
  });
});

describe('the record moves on while card 5 waits', () => {
  it('a parked record closes the M4 gate with the card (a system withdraw, never a vote); a restore proposes a new version', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const first = await toC5(c);
    s.clock.set(new Date(s.clock.now().getTime() + 8 * 24 * 3600 * 1000));
    await driveS0(driverDeps(s, c.host, c.knowledge), c.s0);
    expect((await stateOf(c)).record.status).toBe('parked');
    const w = await sync(c);
    expect(w.withdrawn).toEqual([first.card.card_id]);
    const st = (await readCardState(s.record.pool, first.card.card_id))!;
    expect(st.status).toBe('withdrawn');
    expect(st.gates[0]?.state.status).toBe('closed');
    // it cannot be prepared any more, and nothing was approved
    expect(await decideAs(c, first.card.card_id, 'alice', 'approve', {})).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(
      (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions.map(
        (v) => v.status,
      ),
    ).toEqual(['proposed']);
    // restored: a new card on a new version
    ok(await resumeS0(s.deps, c.s0, { actor: 'alice' }));
    const second = await toC5(c);
    expect(second.card.card_id).not.toBe(first.card.card_id);
    expect(second.d.view.prr.version).toBe(2);
    ok(await decideAs(c, second.card.card_id, 'alice', 'approve', {}));
    expect(
      (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions.map((v) => [
        v.version,
        v.status,
      ]),
    ).toEqual([
      [1, 'proposed'],
      [2, 'active'],
    ]);
  });

  it('an M4 on the ledger for a record that was withdrawn is applied stale: the PRR stays proposed, nothing is signed', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    const { card } = await toC5(c);
    // The decision reaches the ledger through the kernel only (a crash before the record was
    // touched); then the owner withdraws the onboarding.
    const p = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    ok(
      await recordOnboardingEvidence(c.deps, {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash,
      }),
    );
    const loaded = (await loadS0(s.record.pool, c.s0))!;
    const cards = await s0Cards(s.record.pool, c.s0);
    const prr = (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]!;
    const ctx = ok(c5Context(loaded, cards, prr.prr));
    await decideCard(c.deps.decisions, {
      card_id: card.card_id,
      votes: [
        {
          nonce: p.value.nonce,
          decision: 'approve',
          step_up: {
            proof: (s.config.stepUp as FakeStepUp).issue(p.value.step_up!.bound_hash, 'alice'),
          },
        },
      ],
      steps: [{ step: '0.5' as never, decision: 'approve' }],
      payload: ok(planC5(ctx.value, {})).value,
      steps_first: true,
    }).then(ok);
    ok(await withdrawS0(s.deps, c.s0, { actor: 'alice' }));
    expect(ok(await applyCard(c.deps, card.card_id, {})).value).toBe('applied');
    expect((await events(c, S0_EVENT.card_applied)).at(-1)).toMatchObject({
      card: 'C5',
      outcome: 'stale',
    });
    expect(
      (await readPrrState(s.record.pool, c.project, repoIdOf(c.repo))).versions[0]?.status,
    ).toBe('proposed');
    expect((await getProject(s.record.pool, c.project))?.tier).toBeNull();
    expect((await getRepo(s.record.pool, c.repo))?.onboarding_level).toBe('none');
    expect((await stateOf(c)).record.status).toBe('withdrawn');
  });
});
