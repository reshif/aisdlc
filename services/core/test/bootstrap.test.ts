import {
  BOOTSTRAP_ENTRY_TYPE,
  S0BootstrapGrantedPayload,
  S0_EVENT,
  type PrincipalId,
} from '@aisdlc/contracts';
import { configPublish } from '@aisdlc/config';
import { prepare, recordEvidenceViewed, decide, type FakeStepUp } from '@aisdlc/decisions';
import { verifyLedger } from '@aisdlc/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BootstrapEligibility,
  liveBootstrap,
  requestOnboarding,
  withdrawS0,
  type CoreDeps,
} from '../src/index.js';
import {
  pid,
  pr,
  publishSettings,
  request,
  setAdmins,
  setSlots,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';
import { makeHarness } from './harness.js';
import { settingsOf } from '@aisdlc/identity/testing';

// The bootstrap decider (PLAN M7.4a; user decision 2026-11-08). A project that has never published a
// role map has nobody who holds a slot, so nobody could decide its first onboarding. On that first
// onboarding the requester, who passed `project.onboard`, is the provisional admin of THAT S0
// record's cards 1, 4 and 5: recorded on the record and on the ledger, resolved only for the
// `admin` slot, and replaced by the role map the moment card 4's revision is published.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'bs');
const { scenario, sync, actionable, detail, decideAs, ok, c1Content, c4Content, events } = h;

const ledgerCount = async (type: string, s0: string) =>
  (
    await s.record.pool.query(
      'SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE entry_type = $1 AND subject_id = $2',
      [type, s0],
    )
  ).rows[0].n as number;

describe('the grant at the intake', () => {
  it('a brand-new project: an event on the S0 record and a ledger entry that states the provisional grant', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    expect(c.intake.value.bootstrap).toMatchObject({ grantee: 'alice' });
    const granted = await events(c, S0_EVENT.bootstrap_granted);
    expect(granted).toHaveLength(1);
    expect(S0BootstrapGrantedPayload.parse(granted[0])).toMatchObject({
      s0_id: c.s0,
      project_id: c.project,
      grantee: 'alice',
      slot: 'admin',
      cards: ['C1', 'C4', 'C5'],
      basis: 'first_onboarding_no_role_map',
      ledger_entry_id: c.intake.value.bootstrap?.ledger_entry_id,
    });
    // the ledger entry, signed by the Notary, stating the grant: who, to whom, for which cards
    const row = await s.record.pool.query(
      'SELECT entry_id, actor, subject_kind, subject_id, decision, sod_waiver, body FROM ledger.ledger_entry WHERE entry_type = $1 AND subject_id = $2',
      [BOOTSTRAP_ENTRY_TYPE, c.s0],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      entry_id: c.intake.value.bootstrap?.ledger_entry_id,
      actor: 'alice',
      subject_kind: 's0_record',
      decision: null,
      sod_waiver: false,
      body: {
        kind: 'bootstrap_grant',
        grantee: 'alice',
        slot: 'admin',
        cards: ['C1', 'C4', 'C5'],
        project_id: c.project,
      },
    });
    const v = await verifyLedger(s.record.pool, s.id.keys, { allowUncoveredTail: true });
    expect(v.ok).toBe(true);
    expect(await liveBootstrap(s.record.pool, c.project)).toEqual({
      s0_id: c.s0,
      grantee: 'alice',
    });
  });

  it('a second onboarding of the same project gets no bootstrap: not while the first lives, not after a role map is published', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    // another repo of the same project, while the first record lives
    const second = await requestOnboarding(
      s.deps,
      request({ project_id: pid(c.project), repo: 'acme/bs-second', on_behalf_of: pr('bob') }),
    );
    expect(ok(second).value.bootstrap).toBeNull();
    expect(
      (
        await s.record.pool.query(
          `SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2`,
          [`s0:${ok(second).value.s0_id}`, S0_EVENT.bootstrap_granted],
        )
      ).rowCount,
    ).toBe(0);
    expect(await ledgerCount(BOOTSTRAP_ENTRY_TYPE, ok(second).value.s0_id)).toBe(0);
    // and the grant of the first record stays the first record's: bob decides nothing of it
    expect(await liveBootstrap(s.record.pool, c.project)).toEqual({
      s0_id: c.s0,
      grantee: 'alice',
    });

    // a project whose role map is published: a later onboarding gets none
    setAdmins(s, 'bs-published', ['alice']);
    const first = ok(
      await requestOnboarding(
        s.deps,
        request({ project_id: pid('bs-published'), repo: 'acme/bs-p1' }),
      ),
    );
    expect(first.value.bootstrap).not.toBeNull();
    await publishSettings(
      s,
      'bs-published',
      { role_map: settingsOf('x', { admin: ['alice'] }).role_map },
      'alice',
    );
    expect(await liveBootstrap(s.record.pool, 'bs-published')).toBeNull();
    const later = ok(
      await requestOnboarding(
        s.deps,
        request({ project_id: pid('bs-published'), repo: 'acme/bs-p2' }),
      ),
    );
    expect(later.value.bootstrap).toBeNull();
  });

  it('a request for the same repo that supersedes an unfinished one inherits nothing but is itself the first live onboarding', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    const again = ok(
      await requestOnboarding(
        s.deps,
        request({ project_id: pid(c.project), repo: c.repo, on_behalf_of: pr('alice') }),
      ),
    );
    expect(again.value.superseded).toEqual([c.s0]);
    expect(again.value.bootstrap).toMatchObject({ grantee: 'alice' });
    expect(await liveBootstrap(s.record.pool, c.project)).toEqual({
      s0_id: again.value.s0_id,
      grantee: 'alice',
    });
  });

  it('is made only with the ledger: a writer without one grants nothing (fail closed)', async () => {
    const noLedger: CoreDeps = { pool: s.record.pool, clock: s.clock };
    const r = ok(
      await requestOnboarding(
        noLedger,
        request({ project_id: pid('bs-noledger'), repo: 'acme/bs-nl' }),
      ),
    );
    expect(r.value.bootstrap).toBeNull();
    expect(await liveBootstrap(s.record.pool, 'bs-noledger')).toBeNull();
  });

  it('ends with the record: a withdrawn record grants nothing', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    expect(await liveBootstrap(s.record.pool, c.project)).not.toBeNull();
    ok(await withdrawS0(s.deps, c.s0, { actor: 'alice' }));
    expect(await liveBootstrap(s.record.pool, c.project)).toBeNull();
  });
});

describe('who can decide the cards', () => {
  it('cards 1 and 4 are decided by the requester and by nobody else; the security slot and m4 are never granted', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true, findings: 1 });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const card1 = await actionable(c, 'C1');
    const d1 = await detail(c, card1.card_id);
    // who decides it: the requester alone, with a waiver stamped (one person holds the slot)
    expect(d1.deciders).toMatchObject({ slot: 'admin', holders: ['alice'], can_decide: true });
    // nobody else: bob is refused at prepare, and a decision by him writes nothing
    const refusedBob = await decideAs(c, card1.card_id, 'bob', 'approve', c1Content(d1.view));
    expect(refusedBob).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await ledgerCount('card.step_decision', c.s0)).toBe(0);
    const r1 = ok(await decideAs(c, card1.card_id, 'alice', 'approve', c1Content(d1.view)));
    expect(r1.value.decision.entries[0]).toMatchObject({ actor: 'alice', sod_waiver: true });

    await c.drive();
    await sync(c);
    const card4 = await actionable(c, 'C4');
    const d4 = await detail(c, card4.card_id);
    expect(d4.deciders).toMatchObject({ holders: ['alice'], can_decide: true });
    expect(await decideAs(c, card4.card_id, 'bob', 'approve', c4Content(d4.view))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    ok(await decideAs(c, card4.card_id, 'alice', 'approve', c4Content(d4.view)));

    // The security card is the sec slot's: no bootstrap, so nobody holds it and alice cannot decide it.
    const secrs = (await h.summaries(c)).filter((x) => x.card === 'SECR');
    for (const sc of secrs) {
      expect(
        await decideAs(c, sc.card_id, 'alice', 'approve', { state: 'rotated', reason: 'x' }),
      ).toMatchObject({
        ok: false,
      });
    }
    // and the slots the grant does not name resolve through the base port only
    const elig = new BootstrapEligibility(s.elig, { pool: s.record.pool });
    expect((await elig.holders(pid(c.project), 'admin')).ok).toBe(true);
    for (const slot of [
      'sec',
      'm4',
      'requesters',
      'intent',
      'design',
      'g4',
      'g5',
      'x',
      'kill',
    ] as const) {
      expect((await elig.holders(pid(c.project), slot)).ok).toBe(false);
    }
  });

  it("after card 4's role map is published, eligibility follows the role map; the provisional admin is nothing more", async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await h.throughC1(c);
    // card 4 proposes the settings as a revision: its M1 gate is the admin slot's, also the grantee's
    await c.drive();
    await sync(c);
    const card4 = await actionable(c, 'C4');
    const d4 = await detail(c, card4.card_id);
    const rm = {
      ...d4.view.role_map.proposed,
      admin: { kind: 'principals', principals: ['alice', 'bob'] },
      m4: { kind: 'principals', principals: ['alice', 'bob'] },
    };
    const dec = ok(
      await decideAs(c, card4.card_id, 'alice', 'approve', c4Content(d4.view, { role_map: rm })),
    );
    expect(dec.value.applied).toBe('applied');
    const applied = (await events(c, S0_EVENT.card_applied)).at(-1);
    const gate = applied.refs.m1_gate_instance_id as string;
    const rev = applied.refs.config_rev_hash as string;
    expect(gate).toBeTruthy();

    // Until the revision is published the grantee decides the M1 gate (a project-level port).
    const eligibility = new BootstrapEligibility(s.elig, { pool: s.record.pool });
    const cfg = { ...s.config, eligibility };
    const prep = await prepare(cfg, { gate_instance_id: gate, principal: pr('bob') });
    expect(prep.ok).toBe(false); // bob is nobody yet
    const p = ok(await prepare(cfg, { gate_instance_id: gate, principal: pr('alice') }));
    ok(
      await recordEvidenceViewed(cfg, {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash,
      }),
    );
    ok(await decide(cfg, { nonce: p.value.nonce, decision: 'approve' }));
    expect(await liveBootstrap(s.record.pool, c.project)).not.toBeNull(); // decided, not yet published
    ok(await configPublish(cfg, { rev_hash: rev }));

    // Published: the grant is over. The base port (the role map, here a fake of it) decides.
    expect(await liveBootstrap(s.record.pool, c.project)).toBeNull();
    expect((await eligibility.holders(pid(c.project), 'admin')).ok).toBe(false); // base knows no one yet
    setSlots(s, c.project, { admin: ['bob', 'carol'], m4: ['bob', 'carol'], sec: ['carol'] });
    expect(await eligibility.holders(pid(c.project), 'admin')).toMatchObject({
      ok: true,
      value: ['bob', 'carol'],
    });
    expect(await eligibility.holders(pid(c.project), 'sec')).toMatchObject({ value: ['carol'] });
    // alice is not an admin of the role map's making, so she no longer decides anything
    const holders = await eligibility.holders(pid(c.project), 'admin');
    expect(holders.ok && holders.value).not.toContain('alice' as PrincipalId);
  });

  it('a card of another S0 record of the project is not covered: the grant is scoped to its record', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    const other = ok(
      await requestOnboarding(
        s.deps,
        request({ project_id: pid(c.project), repo: 'acme/bs-other', on_behalf_of: pr('bob') }),
      ),
    );
    const base = new BootstrapEligibility(s.elig, { pool: s.record.pool });
    expect((await base.scoped(c.s0).holders(pid(c.project), 'admin')).ok).toBe(true);
    expect((await base.scoped(other.value.s0_id).holders(pid(c.project), 'admin')).ok).toBe(false);
  });

  it('off by default: a deployment that does not turn it on resolves nothing, grant or no grant', async () => {
    const c = await scenario({ slots: 'none', bootstrap: false });
    expect(c.intake.value.bootstrap).not.toBeNull(); // the intake still records the grant ...
    await c.drive();
    await sync(c);
    const card1 = await actionable(c, 'C1');
    // ... but the card layer does not consult it
    expect(
      await decideAs(
        c,
        card1.card_id,
        'alice',
        'approve',
        c1Content((await detail(c, card1.card_id)).view),
      ),
    ).toMatchObject({ ok: false });
  });
});

void ({} as FakeStepUp);
