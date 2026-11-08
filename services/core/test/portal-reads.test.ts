import { S0_EVENT } from '@aisdlc/contracts';
import { LedgerAuditView, ProjectPrrView, SettingsRevisionView } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BootstrapEligibility,
  coreInbox,
  decideRevision,
  ledgerAudit,
  prepareRevision,
  projectPrr,
  publishRevision,
  recordRevisionEvidence,
  revisionOfS0,
  settingsRevision,
} from '../src/index.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness } from './harness.js';

// The portal's reads and the settings revision path (PLAN M8.3, M8.4): the inbox across projects, the
// revision card 4 proposes (the M1 gate that publishes the role map) with its prepare / evidence /
// decide / publish, the readiness record of a project and the ledger entries of a project.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'prt');
const { scenario, sync, actionable, detail, decideAs, ok, c4Content, events, throughC1, toC5 } = h;

const kernel = () => ({
  pool: s.record.pool,
  config: { ...s.config, eligibility: new BootstrapEligibility(s.elig, { pool: s.record.pool }) },
});

describe('the inbox', () => {
  it('lists the open cards of live records with who decides them and the SLA, then the settings revision after card 4', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const mine = (items: Awaited<ReturnType<typeof coreInbox>>) =>
      items.filter((i) => i.project_id === c.project);
    const first = mine(await coreInbox({ cards: c.deps, config: kernel().config, clock: s.clock }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'onboarding_card',
      label: 'C1',
      s0_id: c.s0,
      slot: 'admin',
      holders: ['alice'],
      overdue: false,
      escalated: false,
    });
    expect(Date.parse(first[0]!.sla_due_at as string)).toBeGreaterThan(s.clock.now().getTime());

    await throughC1(c);
    await c.drive();
    await sync(c);
    const card4 = await actionable(c, 'C4');
    const d4 = await detail(c, card4.card_id);
    ok(await decideAs(c, card4.card_id, 'alice', 'approve', c4Content(d4.view)));
    const after = mine(await coreInbox({ cards: c.deps, config: kernel().config, clock: s.clock }));
    expect(after.map((i) => i.kind)).toEqual(['settings_revision']);
    expect(after[0]).toMatchObject({ slot: 'admin', holders: ['alice'], label: null });
  });

  it('a card past its SLA is marked overdue', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await c.drive();
    await sync(c);
    s.clock.advance(3 * 24 * 3600 * 1000);
    const items = (
      await coreInbox({ cards: c.deps, config: kernel().config, clock: s.clock })
    ).filter((i) => i.project_id === c.project);
    expect(items[0]).toMatchObject({ label: 'C1', overdue: true });
  });
});

describe('the settings revision of card 4', () => {
  it('is shown, decided by the bootstrap grantee, published by the same call, and then in force', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card4 = await actionable(c, 'C4');
    const d4 = await detail(c, card4.card_id);
    const rm = {
      ...d4.view.role_map.proposed,
      admin: { kind: 'principals', principals: ['alice', 'bob'] },
      m4: { kind: 'principals', principals: ['alice', 'bob'] },
    };
    ok(await decideAs(c, card4.card_id, 'alice', 'approve', c4Content(d4.view, { role_map: rm })));

    const none = ok(await revisionOfS0(kernel(), c.s0)).value;
    const rev = SettingsRevisionView.parse(none.revision);
    expect(rev).toMatchObject({
      project_id: c.project,
      s0_id: c.s0,
      status: 'pending',
      outcome: null,
      published: false,
      proposed_by: 'alice',
      deciders: { slot: 'admin', holders: ['alice'], can_decide: true },
    });
    expect(rev.settings.role_map.admin).toEqual({
      kind: 'principals',
      principals: ['alice', 'bob'],
    });
    expect(ok(await settingsRevision(kernel(), rev.gate_instance_id)).value.rev_hash).toBe(
      rev.rev_hash,
    );

    // bob is nobody yet: refused at prepare
    expect(
      await prepareRevision(kernel(), { gate: rev.gate_instance_id, principal: pr('bob') }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    const p = ok(
      await prepareRevision(kernel(), { gate: rev.gate_instance_id, principal: pr('alice') }),
    );
    expect(p.value.evidence_hash).toBe(rev.evidence_hash);
    // deciding before the evidence was shown is refused
    expect(
      await decideRevision(kernel(), { nonce: p.value.nonce, decision: 'approve' }),
    ).toMatchObject({
      ok: false,
    });
    const p2 = ok(
      await prepareRevision(kernel(), { gate: rev.gate_instance_id, principal: pr('alice') }),
    );
    ok(
      await recordRevisionEvidence(kernel(), {
        nonce: p2.value.nonce,
        evidence_hash: p2.value.evidence_hash,
      }),
    );
    const d = ok(await decideRevision(kernel(), { nonce: p2.value.nonce, decision: 'approve' }));
    expect(d.value).toMatchObject({ outcome: 'approve', published: true, publish_error: null });
    expect(d.value.entry.ledger_seq).toBeGreaterThan(0);

    const done = SettingsRevisionView.parse(ok(await revisionOfS0(kernel(), c.s0)).value.revision);
    expect(done).toMatchObject({ status: 'decided', outcome: 'approve', published: true });
    // idempotent: a retry of the publish finds it in force
    expect(await publishRevision(kernel(), rev.gate_instance_id)).toMatchObject({ ok: true });
    // and it is no longer in the inbox
    const inbox = (
      await coreInbox({ cards: c.deps, config: kernel().config, clock: s.clock })
    ).filter((i) => i.project_id === c.project && i.kind === 'settings_revision');
    expect(inbox).toEqual([]);
  });

  it('a rejection ends the gate and publishes nothing; a publish of an undecided revision is refused', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card4 = await actionable(c, 'C4');
    const d4 = await detail(c, card4.card_id);
    ok(await decideAs(c, card4.card_id, 'alice', 'approve', c4Content(d4.view)));
    const rev = SettingsRevisionView.parse(ok(await revisionOfS0(kernel(), c.s0)).value.revision);
    expect(await publishRevision(kernel(), rev.gate_instance_id)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    const p = ok(
      await prepareRevision(kernel(), { gate: rev.gate_instance_id, principal: pr('alice') }),
    );
    ok(
      await recordRevisionEvidence(kernel(), {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash,
      }),
    );
    const d = ok(await decideRevision(kernel(), { nonce: p.value.nonce, decision: 'reject' }));
    expect(d.value).toMatchObject({ outcome: 'reject', published: false });
    expect(await publishRevision(kernel(), rev.gate_instance_id)).toMatchObject({ ok: false });
  });

  it('a record with no card-4 approval has no revision; an unknown gate is not found', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    expect(ok(await revisionOfS0(kernel(), c.s0)).value).toEqual({ revision: null });
    expect(await settingsRevision(kernel(), '0199a1a1-0000-7000-8000-000000000001')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('the readiness record and the ledger of a project', () => {
  it('shows the governing record once M4 made it active, and every ledger entry of the onboarding', async () => {
    const c = await scenario();
    const before = ProjectPrrView.parse(await projectPrr(s.record.pool, c.project, s.clock));
    expect(before.repos[0]).toMatchObject({ governing: null, proposed: null });
    await throughC1(c);
    await h.throughC4(c);
    const { card } = await toC5(c);
    const proposed = ProjectPrrView.parse(await projectPrr(s.record.pool, c.project, s.clock));
    expect(proposed.repos[0]?.proposed).toMatchObject({ version: 1 });
    expect(proposed.repos[0]?.governing).toBeNull();

    ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    const prr = ProjectPrrView.parse(await projectPrr(s.record.pool, c.project, s.clock));
    const g = prr.repos[0]?.governing;
    expect(g).toMatchObject({ version: 1, status: 'active', effective_status: 'active' });
    expect(g?.record.level.signed).toBe('census');
    expect(g?.record.record_hash).toMatch(/^[0-9a-f]{64}$/);
    // expiry never approves: after fresh_until the record reads expired
    s.clock.advance(100 * 24 * 3600 * 1000);
    const later = ProjectPrrView.parse(await projectPrr(s.record.pool, c.project, s.clock));
    expect(later.repos[0]?.governing).toMatchObject({
      status: 'active',
      effective_status: 'expired',
    });
    expect(await projectPrr(s.record.pool, 'no-such-project', s.clock)).toBeNull();

    const audit = LedgerAuditView.parse(await ledgerAudit(s.record.pool, c.project));
    const kinds = audit.entries.map((e) => `${e.entry_type}:${e.gate_id ?? e.step ?? ''}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['card.step_decision:0.1', 'card.step_decision:0.4']),
    );
    expect(audit.entries.some((e) => e.gate_id === 'M4' && e.decision === 'approve')).toBe(true);
    expect(audit.entries.every((e) => /^[0-9a-f]{64}$/.test(e.entry_hash))).toBe(true);
    const seqs = audit.entries.map((e) => e.ledger_seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(audit.head?.ledger_seq).toBeGreaterThanOrEqual(seqs.at(-1) as number);
    // limited to the record
    const one = await ledgerAudit(s.record.pool, c.project, { s0_id: c.s0 });
    expect(one.s0_id).toBe(c.s0);
    expect(one.entries.length).toBe(audit.entries.length);
    // another project's entries are not in it
    const other = await scenario();
    await throughC1(other);
    const otherAudit = await ledgerAudit(s.record.pool, other.project);
    expect(
      otherAudit.entries.every((e) => !audit.entries.some((x) => x.entry_id === e.entry_id)),
    ).toBe(true);
    expect(await events(c, S0_EVENT.card_applied)).not.toHaveLength(0);
  });
});
