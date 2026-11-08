import {
  CARD_EVENT,
  CARD_STEP_ENTRY_TYPE,
  S0_EVENT,
  cardPayloadHash,
  cardStream,
  s0Stream,
  type CardPayloadItem,
  type Gap,
} from '@aisdlc/contracts';
import { configPublish } from '@aisdlc/config';
import {
  decideCard,
  listInbox,
  readCardState,
  verifyCardPayload,
  type FakeStepUp,
} from '@aisdlc/decisions';
import { readUnknown, type FakeGitHub } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_S0_SETTINGS,
  DbProjectSettings,
  FakeKnowledge,
  FakePrincipalLinks,
  applyCard,
  buildControlsReport,
  c1Context,
  cardDetail,
  cardsLoop,
  decideOnboardingCard,
  driveS0,
  gapLedgerHash,
  listCards,
  loadS0,
  loadProjectSettings,
  planC1,
  prepareOnboardingCard,
  recheckControls,
  recordOnboardingEvidence,
  requestOnboarding,
  s0Cards,
  syncCards,
  type CardDeps,
} from '../src/index.js';
import {
  cardDeps,
  decideGate,
  driverDeps,
  pid,
  pr,
  request,
  setSlots,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';
import { cardHost, censusFixture, type CensusOptions, type HostOptions } from './cards-fixtures.js';

// The onboarding cards (PLAN M7.3) on real Postgres with the real ledger writer and Notary: cards 1,
// 4, 5 and the security card are opened from `s0.card_required`, decided through the decision
// kernel's prepare / evidence viewed / decide, and applied back to the S0 record. The code host and
// knowledge are fakes behind their ports.

// The views are JSON documents of the portal; they are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});

let n = 0;
interface Scn {
  readonly s0: string;
  readonly project: string;
  readonly repo: string;
  readonly host: FakeGitHub;
  readonly knowledge: FakeKnowledge;
  readonly links: FakePrincipalLinks;
  readonly deps: CardDeps;
  readonly census: ReturnType<typeof censusFixture>;
  drive(): Promise<string>;
}

async function scenario(
  o: {
    level?: 'census' | 'light' | 'full';
    census?: CensusOptions;
    host?: HostOptions;
    findings?: number;
    slots?: Parameters<typeof setSlots>[2];
    tier?: 'T0' | 'T1' | 'T2' | null;
  } = {},
): Promise<Scn> {
  n += 1;
  const project = `cp-${n}`;
  const repo = `acme/cp-${n}`;
  setSlots(
    s,
    project,
    o.slots ?? { admin: ['alice'], sec: ['alice'], m4: ['alice'], intent: ['alice'] },
    o.tier === undefined ? 'T1' : o.tier,
  );
  const host = cardHost(repo, o.host);
  const census = censusFixture(repo, o.census);
  const b1 = census.census.blockers.find((b) => b.id === 'B1')?.status === 'blocked';
  const knowledge = new FakeKnowledge().withCensus((_r, jobId) => ({
    census_id: census.census_id,
    census_hash: census.census_hash,
    job_id: jobId,
    b1_blocked: b1,
    secrets_not_met: b1,
  }));
  knowledge.setCensusRecord(repo, census);
  knowledge.auto = 'done';
  if (o.findings) knowledge.addFindings(repo, o.findings);
  const links = new FakePrincipalLinks().link('alice-gh', 'alice').link('bob-gh', 'bob');
  const r = await requestOnboarding(
    s.deps,
    request({ project_id: pid(project), repo, level: o.level ?? 'census' }),
  );
  if (!r.ok) throw new Error(r.error.message);
  const s0 = r.value.s0_id;
  const d = driverDeps(s, host, knowledge);
  return {
    s0,
    project,
    repo,
    host,
    knowledge,
    links,
    census,
    deps: cardDeps(s, host, knowledge, { links }),
    async drive() {
      for (let i = 0; i < 8; i++) {
        await driveS0(d, s0);
        if ((await loadS0(s.record.pool, s0))?.s0.record.status === 'card') break;
      }
      return (await loadS0(s.record.pool, s0))?.s0.record.status ?? 'gone';
    },
  };
}

const sync = async (c: Scn) => {
  const r = await syncCards(c.deps, c.s0);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const summaries = async (c: Scn) => {
  const r = await listCards(c.deps, c.s0);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
/** The one actionable card of `kind`. */
async function actionable(c: Scn, kind: string) {
  const hit = (await summaries(c)).filter((x) => x.card === kind && x.actionable);
  if (hit.length !== 1) throw new Error(`${hit.length} actionable ${kind} cards`);
  return hit[0] as (typeof hit)[number];
}
const detail = async (
  c: Scn,
  cardId: string,
): Promise<{
  view: Json;
  evidence_hash: string;
  deciders: Json;
  decision_schema: Json;
  summary: Json;
}> => {
  const r = await cardDetail(c.deps, cardId);
  if (!r.ok) throw new Error(r.error.message);
  return r.value as never;
};

/** prepare, evidence viewed, decide: what the portal does for one person. */
async function decideAs(
  c: Scn,
  cardId: string,
  principal: string,
  decision: string,
  content?: unknown,
  reason?: string,
) {
  const p = await prepareOnboardingCard(c.deps, { card_id: cardId, principal: pr(principal) });
  if (!p.ok) return p;
  const e = await recordOnboardingEvidence(c.deps, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!e.ok) return e;
  // Card 5 carries the M4 gate, which needs a step-up proof bound to the PRR's record_hash.
  const stepUp = p.value.step_up?.required
    ? {
        proof: (s.config.stepUp as FakeStepUp).issue(p.value.step_up.bound_hash, principal),
      }
    : undefined;
  return decideOnboardingCard(c.deps, {
    card_id: cardId,
    principal: pr(principal),
    nonce: p.value.nonce,
    decision,
    ...(content === undefined ? {} : { content }),
    ...(reason === undefined ? {} : { reason }),
    ...(stepUp ? { step_up: stepUp } : {}),
  });
}

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify((r as never as { error: unknown }).error));
  return r as never;
};

/** The default content of card 1: the floor tier (T0 attested), every gap as its default. */
function c1Content(view: Json, over: Record<string, unknown> = {}) {
  return {
    owners: ['alice'],
    tier: view.tier.floor,
    t0_attestation: true,
    gaps: view.gaps.map((g: Json) => ({ gap_id: g.gap_id, disposition: g.default_disposition })),
    ...over,
  };
}

function c4Content(view: Json, over: Record<string, unknown> = {}) {
  return {
    controls_report_hash: view.controls_report.report_hash,
    attestations: {
      bypass_has_no_factory_app: true,
      app_scope_selected: true,
      github_token_readonly: true,
      actions_cannot_approve_prs: true,
      fork_pr_approval_required: true,
      secret_scanning: 'on',
      plan: 'free',
    },
    role_map: view.role_map.proposed,
    two_person_enabled: true,
    gating_profile: {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: true,
    },
    kill_delegations: [],
    ...over,
  };
}

/** Drives to card 1 and decides it with the defaults (alice). */
async function throughC1(c: Scn, over: Record<string, unknown> = {}) {
  expect(await c.drive()).toBe('card');
  await sync(c);
  const card = await actionable(c, 'C1');
  const d = await detail(c, card.card_id);
  const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c1Content(d.view, over)));
  return { card, d, r };
}
async function throughC4(c: Scn, over: Record<string, unknown> = {}) {
  await c.drive();
  await sync(c);
  const card = await actionable(c, 'C4');
  const d = await detail(c, card.card_id);
  const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c4Content(d.view, over)));
  return { card, d, r };
}

/** Decides at the decision kernel only, as a crash between the ledger and the record leaves it. */
async function kernelDecide(c: Scn, cardId: string, content: unknown) {
  const p = ok(await prepareOnboardingCard(c.deps, { card_id: cardId, principal: pr('alice') }));
  ok(
    await recordOnboardingEvidence(c.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    }),
  );
  const loaded = (await loadS0(s.record.pool, c.s0))!;
  const ctx = ok(await c1Context(c.deps, loaded));
  const payload = ok(planC1(ctx.value, content, s.clock.now()));
  return ok(
    await decideCard(c.deps.decisions, {
      card_id: cardId,
      votes: [],
      step_nonce: p.value.nonce,
      step_evidence_hash: p.value.evidence_hash as never,
      steps: [{ step: '0.1' as never, decision: 'approve' }],
      payload: payload.value,
    }),
  );
}

const events = async (c: Scn, type: string) =>
  (
    await s.record.pool.query<{ body: Json }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
      [s0Stream(c.s0), type],
    )
  ).rows.map((x) => x.body);
const stateOf = async (c: Scn) =>
  (await loadS0(s.record.pool, c.s0))?.s0 as NonNullable<Awaited<ReturnType<typeof loadS0>>>['s0'];

describe('opening the cards from s0.card_required', () => {
  it('opens card 1 once, for the admin slot, and it is in the admin inbox only; deciding nothing', async () => {
    const c = await scenario({ slots: { admin: ['alice'], sec: ['sam'], m4: ['alice'] } });
    expect(await c.drive()).toBe('card');
    const before = await s.record.pool.query(`SELECT count(*)::int AS n FROM ledger.ledger_entry`);
    const first = await sync(c);
    expect(first.opened).toHaveLength(1);
    expect((await sync(c)).opened).toHaveLength(0); // idempotent
    const [card] = await summaries(c);
    expect(card).toMatchObject({
      card: 'C1',
      step: '0.1',
      slot: 'admin',
      status: 'open',
      actionable: true,
    });
    // opening writes no ledger entry: nothing is decided without a person
    const after = await s.record.pool.query(`SELECT count(*)::int AS n FROM ledger.ledger_entry`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const inbox = await listInbox(c.deps.decisions, pr('alice'));
    expect(inbox.ok && inbox.value.map((i) => i.card.card_id)).toContain(card?.card_id);
    const other = await listInbox(c.deps.decisions, pr('sam'));
    expect(other.ok && other.value.map((i) => i.card.card_id)).not.toContain(card?.card_id);
    const st = await readCardState(s.record.pool, card?.card_id as string);
    expect(st?.open).toMatchObject({ label: 'C1', subject_kind: 's0_record', subject_id: c.s0 });
    expect(st?.open.targets).toEqual([{ target: 'step', step: '0.1', slot: 'admin' }]);
  });

  it('the card view shows the census summary: tier floor with evidence, posture, blockers, gaps, defaults', async () => {
    const c = await scenario({ census: { blocking: ['RS-TH-1'], tierFloor: 'T1' } });
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    expect(d.view).toMatchObject({
      card: 'C1',
      census: { census_hash: c.census.census_hash },
      tier: { floor: 'T1', raise_only: true },
      posture: { state: expect.any(String) },
      t0_attestation: { required: true },
      max_waiver_days: 90,
    });
    expect(d.view.blockers.map((b: Json) => b.id)).toContain('B1');
    const blocking = d.view.gaps.find((g: Json) => g.criterion === 'RS-TH-1');
    expect(blocking).toMatchObject({
      severity: 'blocking',
      default_disposition: 'file_issue',
      allowed_dispositions: ['file_issue', 'track_only'],
    });
    const tracked = d.view.gaps.find((g: Json) => g.severity === 'tracked');
    expect(tracked).toMatchObject({ default_disposition: 'track_only' });
    expect(tracked.allowed_dispositions).toContain('waive');
    // who decides: from the role map, the single operator is stamped sod_waiver
    expect(d.deciders).toMatchObject({
      slot: 'admin',
      holders: ['alice'],
      single_operator: true,
      sod_waiver: true,
    });
    // the payload schema is published with the card
    expect(d.decision_schema.properties.owners).toBeDefined();
    expect(d.decision_schema.properties.gaps).toBeDefined();
  });
});

describe('card 1 (0.1)', () => {
  it('happy path: owner, tier, every gap disposed; one ledger entry with the payload hash; the step is done', async () => {
    const c = await scenario({ census: { blocking: ['RS-TH-1'] } });
    const { card, r } = await throughC1(c);
    const entry = r.value.decision.entries[0];
    expect(r.value.decision.entries).toHaveLength(1);
    expect(entry).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      decision: 'approve',
      actor: 'alice',
      sod_waiver: true,
      subject_kind: 's0_record',
      subject_id: c.s0,
      body: { card_id: card.card_id, step: '0.1' },
    });
    expect(r.value.applied).toBe('applied');
    const st = await readCardState(s.record.pool, card.card_id);
    expect(st?.status).toBe('decided');
    const rows = (st?.payload?.payload ?? []) as CardPayloadItem[];
    expect(rows.map((x) => x.kind).slice(0, 2)).toEqual(['owner_confirmation', 'tier_decision']);
    expect(entry?.body).toMatchObject({ payload_hash: cardPayloadHash(rows) });
    expect(await verifyCardPayload(c.deps.decisions, card.card_id)).toMatchObject({ ok: true });
    const blocking = rows.find((x) => x.kind === 'gap_disposition' && x.criterion === 'RS-TH-1');
    expect(blocking).toMatchObject({ disposition: 'file_issue' });
    // the record: card_applied, step done, back to running
    const s0 = await stateOf(c);
    expect(s0.steps.get('0.1')?.state).toBe('done');
    expect(s0.record.status).toBe('running');
    expect(await events(c, S0_EVENT.card_applied)).toEqual([
      expect.objectContaining({
        card_id: card.card_id,
        card: 'C1',
        outcome: 'step_done',
        decision: 'approve',
      }),
    ]);
    // the next step is raised by the driver: card 4 (reduced, Census) waits
    await c.drive();
    const raised = await events(c, S0_EVENT.card_required);
    expect(raised.map((e) => `${e.step}:${e.card}:${e.reduced}`)).toEqual([
      '0.1:C1:false',
      '0.4:C4:true',
    ]);
  });

  it('a 50-gap disposition list hashes into the ledger entry; the full list is stored once on the card stream', async () => {
    const c = await scenario({ census: { extraGaps: 50 } });
    const { card, r } = await throughC1(c);
    const st = await readCardState(s.record.pool, card.card_id);
    const gapRows = (st?.payload?.payload ?? []).filter((x) => x.kind === 'gap_disposition');
    expect(gapRows.length).toBe(c.census.gaps.length);
    expect(gapRows.length).toBeGreaterThanOrEqual(61);
    expect(r.value.decision.entries).toHaveLength(1);
    const want = cardPayloadHash(st?.payload?.payload ?? []);
    expect(r.value.decision.payload_hash).toBe(want);
    expect(r.value.decision.entries[0]?.body).toMatchObject({ payload_hash: want });
    expect(await verifyCardPayload(c.deps.decisions, card.card_id)).toMatchObject({
      ok: true,
      rows: (st?.payload?.payload ?? []).length,
    });
    const stored = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1 AND type = $2`,
      [cardStream(card.card_id), CARD_EVENT.payload_recorded],
    );
    expect(stored.rows[0].n).toBe(1);
  });

  it('T0 without the positive attestation is refused; with it, signed; a higher tier needs none', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    const no = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { tier: 'T0', t0_attestation: undefined }),
    );
    expect(no).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(no)).toContain('positive attestation');
    const falsy = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { tier: 'T0', t0_attestation: false }),
    );
    expect(falsy.ok).toBe(false);
    // nothing was written
    const st = await readCardState(s.record.pool, card.card_id);
    expect(st?.status).toBe('open');
    const yes = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { tier: 'T1', t0_attestation: undefined }),
    );
    expect(yes.ok).toBe(true);
    const payload = (await readCardState(s.record.pool, card.card_id))?.payload?.payload;
    expect(payload?.find((x) => x.kind === 'tier_decision')).toMatchObject({
      tier: 'T1',
      t0_attested: false,
      floor: 'T0',
    });
  });

  it('DEC-4 behind config: with the setting off a T0 needs no attestation', async () => {
    const c = await scenario();
    const off = {
      ...c.deps,
      settings: () => ({ ...DEFAULT_S0_SETTINGS, t0AttestationRequired: false }),
    };
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail({ ...c, deps: off } as Scn, card.card_id);
    expect(d.view.t0_attestation.required).toBe(false);
    const r = await decideAs(
      { ...c, deps: off } as Scn,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { tier: 'T0', t0_attestation: undefined }),
    );
    expect(r.ok).toBe(true);
  });

  it('the tier is raise-only: below the floor is refused (the floor includes what the request attested)', async () => {
    const c = await scenario({ census: { tierFloor: 'T1' } });
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    const r = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { tier: 'T0' }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(r)).toContain('raise-only');
  });

  it('waiving a blocking gap is refused; a security gap is track_only only; a waiver lasts at most 90 days', async () => {
    const c = await scenario({ census: { golden: 'b', blocking: ['RS-TH-1'] }, findings: 1 });
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    const rowsWith = (gap: string, row: Record<string, unknown>) =>
      d.view.gaps.map((g: Json) =>
        g.gap_id.includes(gap)
          ? { gap_id: g.gap_id, ...row }
          : { gap_id: g.gap_id, disposition: g.default_disposition },
      );
    const expires = (days: number) =>
      new Date(s.clock.now().getTime() + days * 86400000).toISOString();
    const waiveBlocking = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, {
        gaps: rowsWith('RS-TH-1', {
          disposition: 'waive',
          waiver: { reason: 'later', expires_at: expires(30) },
        }),
      }),
    );
    expect(waiveBlocking).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(waiveBlocking)).toContain('cannot be waived');
    const secGap = d.view.gaps.find((g: Json) => g.visibility_class === 'private_only');
    expect(secGap).toMatchObject({
      default_disposition: 'track_only',
      allowed_dispositions: ['track_only'],
    });
    for (const disposition of ['file_issue', 'waive']) {
      const bad = await decideAs(
        c,
        card.card_id,
        'alice',
        'approve',
        c1Content(d.view, {
          gaps: rowsWith('RS-SEC', {
            disposition,
            waiver: { reason: 'x', expires_at: expires(5) },
          }),
        }),
      );
      expect(bad).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    const tracked = d.view.gaps.find((g: Json) => g.allowed_dispositions.includes('waive'))
      .gap_id as string;
    const tooLong = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, {
        gaps: rowsWith(tracked, {
          disposition: 'waive',
          waiver: { reason: 'later', expires_at: expires(91) },
        }),
      }),
    );
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(tooLong)).toContain('at most 90 days');
    const noReason = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { gaps: rowsWith(tracked, { disposition: 'waive' }) }),
    );
    expect(noReason.ok).toBe(false);
    const missing = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, {
        gaps: d.view.gaps
          .slice(1)
          .map((g: Json) => ({ gap_id: g.gap_id, disposition: g.default_disposition })),
      }),
    );
    expect(missing).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(missing)).toContain('every gap is disposed');
    const twice = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, { gaps: [...c1Content(d.view).gaps, c1Content(d.view).gaps[0]] }),
    );
    expect(twice.ok).toBe(false);
    const ok60 = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c1Content(d.view, {
        gaps: rowsWith(tracked, {
          disposition: 'waive',
          waiver: { reason: 'later', expires_at: expires(60) },
        }),
      }),
    );
    expect(ok60.ok).toBe(true);
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    expect(rows.find((x) => x.kind === 'gap_disposition' && x.gap_id === tracked)).toMatchObject({
      disposition: 'waive',
      waiver: { reason: 'later' },
    });
    // the security gap was tracked, never filed
    expect(
      rows.find((x) => x.kind === 'gap_disposition' && x.gap_id.includes('RS-SEC')),
    ).toMatchObject({ disposition: 'track_only' });
  });

  it('a dispute of the evidence is recorded in the payload', async () => {
    const c = await scenario();
    const { card } = await throughC1(c, {
      disputes: [{ ref: 'detector:ex.routing', note: 'this is a test router' }],
    });
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    expect(rows.find((x) => x.kind === 'evidence_dispute')).toMatchObject({
      ref: 'detector:ex.routing',
    });
  });

  it('who decides: a person who does not hold the admin slot is refused at prepare; nobody decides unprepared', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const r = await prepareOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('mallory'),
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const unprepared = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      nonce: 'made-up',
      decision: 'approve',
      content: c1Content((await detail(c, card.card_id)).view),
    });
    expect(unprepared.ok).toBe(false);
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('open');
  });

  it('a page that changed since it was shown is refused: the evidence is bound to the nonce', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const p = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    const wrong = await recordOnboardingEvidence(c.deps, {
      nonce: p.value.nonce,
      evidence_hash: 'f'.repeat(64),
    });
    expect(wrong.ok).toBe(false);
    const notViewed = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      nonce: p.value.nonce,
      decision: 'approve',
      content: c1Content((await detail(c, card.card_id)).view),
    });
    expect(notViewed).toMatchObject({ ok: false });
    expect(JSON.stringify(notViewed)).toContain('evidence_not_viewed');
  });
});

describe('card 4 (0.4): the controls report, the attestations, the role map, the gating profile', () => {
  it('the controls report is deterministic, read-only, and reduced at Census: protect-main is only recorded', async () => {
    const c = await scenario({ host: { rules: 'none' } });
    const a = await buildControlsReport(c.deps, c.repo, { reduced: true });
    const b = await buildControlsReport(c.deps, c.repo, { reduced: true });
    expect(a).toEqual(b);
    expect(a.report_hash).toBe(b.report_hash);
    expect(a.controls.find((x) => x.id === 'protect_main')).toMatchObject({
      status: 'recorded',
      blocking: false,
    });
    expect(a.blocking_open).toEqual([]);
    expect(a.sensitive_paths).toContain('AGENTS.md');
    expect(a.instructions).toEqual({ agents_md: 'present', claude_md: 'absent' });
    expect(a.codeowners).toMatchObject({
      read: 'ok',
      path: '.github/CODEOWNERS',
      github_errors: 0,
    });
    expect(a.b4.blocks_m4).toBe(false);
    // not reduced (Light and above): the same reads block
    const full = await buildControlsReport(c.deps, c.repo, { reduced: false });
    expect(full.blocking_open).toEqual(['protect_main']);
    expect(full.report_hash).not.toBe(a.report_hash);
    // the factory only reads
    expect((c.host as FakeGitHub).requests.every((r) => r.method === 'GET')).toBe(true);
    // with protect-main applied, the full report is met
    c.host.load(hostSeedOf(c.repo, { rules: 'good' }));
    expect((await buildControlsReport(c.deps, c.repo, { reduced: false })).blocking_open).toEqual(
      [],
    );
  });

  it('unknown is never met: an unreadable code host leaves the blocking controls open', async () => {
    const c = await scenario();
    c.host.breakAll(readUnknown('network', 'down'));
    const r = await buildControlsReport(c.deps, c.repo, { reduced: true });
    expect(r.blocking_open).toEqual(['B4a', 'B4b', 'app_scope']);
    expect(r.controls.find((x) => x.id === 'protect_main')).toMatchObject({ status: 'recorded' });
    expect(r.controls.filter((x) => x.blocking).every((x) => x.status === 'unknown')).toBe(true);
  });

  it('happy path: attestations, the proposed role map, two-person, gating profile; settings are PROPOSED as an M1-gated revision, not in force', async () => {
    const c = await scenario();
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    expect(d.view).toMatchObject({ card: 'C4', reduced: true, can_decide: true, tier: 'T0' });
    // the role map is proposed from CODEOWNERS and the collaborators, read-only
    expect(d.view.role_map.proposed.admin).toEqual({ kind: 'principals', principals: ['alice'] });
    expect(d.view.role_map.proposed.requesters).toEqual({
      kind: 'principals',
      principals: ['alice', 'bob'],
    });
    expect(d.view.role_map.proposed.g4).toEqual({ kind: 'codeowners' });
    expect(d.view.role_map.basis).toMatchObject({
      codeowners_logins: ['alice-gh'],
      unmapped_logins: ['ghost-gh'],
      fallback_admin_used: false,
    });
    // an edit: bob also holds the x slot, and gets a kill delegation
    const edited = {
      ...d.view.role_map.proposed,
      x: { kind: 'principals', principals: ['alice', 'bob'] },
    };
    const r = ok(
      await decideAs(
        c,
        card.card_id,
        'alice',
        'approve',
        c4Content(d.view, {
          role_map: edited,
          kill_delegations: [{ delegate: 'bob', scope: { kind: 'project', ref: c.project } }],
        }),
      ),
    );
    expect(r.value.applied).toBe('applied');
    expect(r.value.decision.entries[0]).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      sod_waiver: true,
    });
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    expect(rows.map((x) => x.kind)).toEqual([
      'controls_report',
      'controls_attestation',
      'settings_decision',
    ]);
    expect(rows[0]).toMatchObject({
      report_hash: d.view.controls_report.report_hash,
      reduced: true,
    });
    const applied = (await events(c, S0_EVENT.card_applied)).find((e) => e.card === 'C4');
    expect(applied).toMatchObject({
      outcome: 'step_done',
      refs: { controls_report_hash: d.view.controls_report.report_hash },
    });
    expect(applied.refs.config_rev_hash).toMatch(/^[0-9a-f]{64}$/);
    // the proposal is an M1 gate on the project's config lineage, still pending
    const gate = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${applied.refs.m1_gate_instance_id}`],
    );
    expect(gate.rows[0].body).toMatchObject({
      gate_id: 'M1',
      subject_kind: 'config',
      subject_hash: applied.refs.config_rev_hash,
    });
    const port = new DbProjectSettings({ pool: s.record.pool, registry: s.registry });
    expect(await port.get(pid(c.project))).toMatchObject({ ok: false });
    // publishing is the M1 decision and `config_publish`; the decided revision then is the settings in force
    const noDecision = await configPublish(s.config, { rev_hash: applied.refs.config_rev_hash });
    expect(noDecision.ok).toBe(false);
    ok(await decideGate(s, applied.refs.m1_gate_instance_id, 'alice', 'approve'));
    ok(await configPublish(s.config, { rev_hash: applied.refs.config_rev_hash }));
    const live = await loadProjectSettings(s.record.pool, s.registry, pid(c.project));
    expect(live.ok && live.value.settings.role_map.x).toEqual({
      kind: 'principals',
      principals: ['alice', 'bob'],
    });
    expect(live.ok && live.value.settings.kill_delegations[0]).toMatchObject({
      delegate: 'bob',
      granted_by: 'alice',
      revoked_at: null,
    });
    expect((await stateOf(c)).steps.get('0.4')?.state).toBe('done');
  });

  it('a missing blocking control: the card shows the instruction; "re-check" reads the host again; after the fix it passes', async () => {
    const c = await scenario({ host: { unpinnedStatuses: true } });
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    expect(d.view.can_decide).toBe(false);
    expect(d.view.controls_report.blocking_open).toContain('B4b');
    expect(d.view.instructions.map((i: Json) => i.control)).toContain('B4b');
    expect(d.view.instructions[0].text).toMatch(/GitHub/);
    // a person who saw this page decides: refused, and says what is open
    const refused = await decideAs(c, card.card_id, 'alice', 'approve', c4Content(d.view));
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(refused)).toContain('B4b');
    // a nonce prepared on the old page
    const old = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    ok(
      await recordOnboardingEvidence(c.deps, {
        nonce: old.value.nonce,
        evidence_hash: old.value.evidence_hash,
      }),
    );
    // re-check before any fix: still blocked, and the re-check is recorded
    const still = ok(
      await recheckControls(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    expect((still.value.view as Json).can_decide).toBe(false);
    // somebody else may not press it
    expect(
      await recheckControls(c.deps, { card_id: card.card_id, principal: pr('mallory') }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // the human fixes it on GitHub (the factory never does); the fake host is fixed
    c.host.load(hostSeedOf(c.repo, { rules: 'good' }));
    const fixed = ok(
      await recheckControls(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    const view = fixed.value.view as Json;
    expect(view.can_decide).toBe(true);
    expect(view.controls_report.report_hash).not.toBe(d.view.controls_report.report_hash);
    const checks = await events(c, S0_EVENT.controls_checked);
    expect(checks.map((x) => x.blocking_open)).toEqual([['B4b'], []]);
    // the old page cannot be used any more
    const stale = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      nonce: old.value.nonce,
      decision: 'approve',
      content: c4Content(view),
    });
    expect(stale).toMatchObject({ ok: false });
    expect(JSON.stringify(stale)).toContain('evidence_mismatch');
    // and the decision on the fixed page passes
    const done = await decideAs(c, card.card_id, 'alice', 'approve', c4Content(view));
    expect(done.ok && done.value.applied).toBe('applied');
    // the factory wrote no setting on the host: GETs only
    expect(c.host.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('the attestations are required: each claim is positive, operations.md only from Light up', async () => {
    const c = await scenario();
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    const bad = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        attestations: {
          bypass_has_no_factory_app: true,
          app_scope_selected: true,
          github_token_readonly: false,
          actions_cannot_approve_prs: true,
          fork_pr_approval_required: true,
          secret_scanning: 'on',
          plan: 'free',
        },
      }),
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const extra = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        attestations: { ...c4Content(d.view).attestations, operations_md: true },
      }),
    );
    expect(extra.ok).toBe(false);
    const noPlan = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        attestations: { ...c4Content(d.view).attestations, secret_scanning: 'plan_unavailable' },
      }),
    );
    expect(noPlan.ok).toBe(true);
  });

  it('T2: single-person is refused, and the gating floor is enforced', async () => {
    const c = await scenario();
    await throughC1(c, { tier: 'T2' });
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    expect(d.view).toMatchObject({ tier: 'T2', two_person: { locked_on: true } });
    const single = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, { two_person_enabled: false }),
    );
    expect(single).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(single)).toContain('locks two-person on');
    const off = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        gating_profile: {
          ...c4Content(d.view).gating_profile,
          gates: { g0g1: 'on', g2: 'off', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
        },
      }),
    );
    expect(off).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(JSON.stringify(off)).toContain('T2 cannot turn off g2');
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('open');
    const fine = await decideAs(c, card.card_id, 'alice', 'approve', c4Content(d.view));
    expect(fine.ok).toBe(true);
    const settings = (await readCardState(s.record.pool, card.card_id))?.payload?.payload.find(
      (x) => x.kind === 'settings_decision',
    );
    expect(settings).toMatchObject({ tier: 'T2', two_person: { enabled: true, locked_on: true } });
  });

  it('T2 never waives: a sole holder of the deciding slot cannot decide at all', async () => {
    const c = await scenario({ tier: 'T2' });
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    expect(d.deciders).toMatchObject({
      single_operator: true,
      sod_waiver: false,
      t2: true,
      can_decide: false,
    });
    const r = await decideAs(c, card.card_id, 'alice', 'approve', c1Content(d.view));
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain('quorum_infeasible');
    // two holders: they decide, with no waiver stamped
    setSlots(s, c.project, { admin: ['alice', 'amy'], sec: ['alice'], m4: ['alice'] }, 'T2');
    const ok2 = await decideAs(c, card.card_id, 'alice', 'approve', c1Content(d.view));
    expect(ok2.ok && ok2.value.decision.entries[0]?.sod_waiver).toBe(false);
  });

  it('the role map needs an admin and an m4 holder; a delegation covers this project only', async () => {
    const c = await scenario();
    await throughC1(c);
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    const noAdmin = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        role_map: { ...d.view.role_map.proposed, admin: { kind: 'principals', principals: [] } },
      }),
    );
    expect(noAdmin).toMatchObject({ ok: false, error: { code: 'refused' } });
    const other = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        kill_delegations: [{ delegate: 'bob', scope: { kind: 'project', ref: 'someone-else' } }],
      }),
    );
    expect(other).toMatchObject({ ok: false, error: { code: 'refused' } });
    const fleet = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c4Content(d.view, {
        kill_delegations: [{ delegate: 'bob', scope: { kind: 'fleet', ref: '*' } }],
      }),
    );
    expect(fleet.ok).toBe(false);
  });
});

import { hostSeed as hostSeedOf } from './cards-fixtures.js';

describe('card 5 (0.5): the sign-off and M4 on one card (PLAN M7.5)', () => {
  it('assembles the package and the PRR, carries the 0.5 sign-off and the M4 gate as two ledgered entries, and activates the record', async () => {
    const c = await scenario({ census: { extraGaps: 3 } });
    const c1 = await throughC1(c);
    const c4 = await throughC4(c);
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C5');
    const d = await detail(c, card.card_id);
    expect(d.summary).toMatchObject({ card: 'C5', step: '0.5', slot: 'admin' });
    // The card carries a step AND the M4 gate, opened on the S0 record's UUID and bound to the PRR.
    const st = (await readCardState(s.record.pool, card.card_id))!;
    expect(st.open.targets).toEqual([
      expect.objectContaining({ target: 'gate', gate_id: 'M4' }),
      { target: 'step', step: '0.5', slot: 'admin' },
    ]);
    const gate = st.gates[0]!.state.open.payload;
    expect(gate).toMatchObject({
      gate_id: 'M4',
      subject_kind: 's0_record',
      subject_id: c.s0,
      step_up: { required: true },
    });
    // the package: census hash, the gap ledger as card 1 disposed it, the controls report of card 4, the PRR
    const c1rows = (await readCardState(s.record.pool, c1.card.card_id))?.payload?.payload ?? [];
    const gapRows = c1rows.filter((x) => x.kind === 'gap_disposition');
    expect(d.view.m4_package).toEqual({
      census_hash: c.census.census_hash,
      gap_ledger_hash: gapLedgerHash(c.census.gaps as Gap[], gapRows),
      controls_report_hash: c4.d.view.controls_report.report_hash,
      prr_record_hash: gate.subject_hash,
    });
    expect(d.view).toMatchObject({ owners: ['alice'], tier: { value: 'T0' } });
    expect(gate.step_up.bound_hash).toBe(gate.subject_hash);
    const before = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE subject_id = $1`,
      [c.s0],
    );
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
    // two ledgered entries on the one card, the sign-off first, then M4 bound to the PRR's hash
    expect(r.value.decision.entries).toHaveLength(2);
    expect(r.value.decision.entries[0]).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      decision: 'approve',
      sod_waiver: true,
      body: { step: '0.5', card_id: card.card_id },
    });
    expect(r.value.decision.entries[1]).toMatchObject({
      entry_type: 'decision',
      gate_id: 'M4',
      decision: 'approve',
      subject_kind: 's0_record',
      subject_id: c.s0,
      subject_hash: gate.subject_hash,
      sod_waiver: true,
    });
    expect(r.value.decision.entries[0]!.ledger_seq).toBeLessThan(
      r.value.decision.entries[1]!.ledger_seq,
    );
    const after = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE subject_id = $1`,
      [c.s0],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 2);
    expect(r.value.applied).toBe('applied');
    // the hand-off point and what M4 did
    const ready = await events(c, S0_EVENT.signoff_ready);
    expect(ready).toEqual([
      expect.objectContaining({
        card_id: card.card_id,
        signoff_entry_id: r.value.decision.entries[0]?.entry_id,
        package: d.view.m4_package,
        payload_hash: r.value.decision.payload_hash,
        by: 'alice',
      }),
    ]);
    const s0 = await stateOf(c);
    expect(s0.record.status).toBe('done');
    expect(s0.steps.get('0.5')?.state).toBe('done');
    expect(s0.record.readiness_version).toBe(1);
    // a second sync neither re-opens nor re-applies it
    const again = await sync(c);
    expect([again.opened, again.applied]).toEqual([[], []]);
    expect(await events(c, S0_EVENT.signoff_ready)).toHaveLength(1);
  });

  it('send-back at card 5 re-raises it; a second send-back rejects the record at 0.5 (DEC-9)', async () => {
    const c = await scenario();
    await throughC1(c);
    await throughC4(c);
    await c.drive();
    await sync(c);
    const first = await actionable(c, 'C5');
    const sb = ok(
      await decideAs(c, first.card_id, 'alice', 'request_changes', undefined, 'recompute'),
    );
    expect(sb.value.applied).toBe('applied');
    expect((await events(c, S0_EVENT.card_applied)).at(-1)).toMatchObject({
      card: 'C5',
      outcome: 'sent_back',
    });
    expect((await stateOf(c)).record.status).toBe('running');
    expect((await readCardState(s.record.pool, first.card_id))?.status).toBe('sent_back');
    await c.drive();
    await sync(c);
    const second = await actionable(c, 'C5');
    expect(second.card_id).not.toBe(first.card_id);
    const rej = ok(await decideAs(c, second.card_id, 'alice', 'request_changes'));
    expect(rej.value.applied).toBe('applied');
    const s0 = await stateOf(c);
    expect(s0.record).toMatchObject({ status: 'rejected', rejected_at: '0.5' });
    expect((await events(c, S0_EVENT.card_applied)).at(-1)).toMatchObject({ outcome: 'rejected' });
  });

  it('a rejection of card 1 rejects at once; cards 4 and 5 cannot be decided before their steps', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const r = ok(await decideAs(c, card.card_id, 'alice', 'reject', undefined, 'not our repo'));
    expect(r.value.decision.status).toBe('rejected');
    expect((await stateOf(c)).record).toMatchObject({ status: 'rejected', rejected_at: '0.1' });
    // nothing else opens for a rejected record
    expect((await sync(c)).opened).toEqual([]);
  });
});

describe('the security card (OB §5.3 item 11)', () => {
  it('B1 open: one card per finding, counts only, decided by the sec slot, each decision ledgered AND applied to knowledge; the signable level is released after the last', async () => {
    const c = await scenario({
      level: 'light',
      census: { golden: 'b' },
      findings: 2,
      slots: { admin: ['alice'], sec: ['sam'], m4: ['alice'] },
    });
    expect(await c.drive()).toBe('card');
    // the open secret dropped Light to Census, with its cause; 0.2 is not asked for
    expect((await stateOf(c)).record).toMatchObject({
      requested_level: 'light',
      signable_level: 'census',
    });
    expect((await stateOf(c)).steps.get('0.2')?.state).toBe('skip');
    expect((await events(c, S0_EVENT.card_required)).map((e) => e.card)).toEqual(['C1', 'SECR']);
    const opened = await sync(c);
    expect(opened.opened).toHaveLength(3); // card 1 and two findings
    const secr = (await summaries(c)).filter((x) => x.card === 'SECR');
    expect(secr).toHaveLength(2);
    expect(secr.every((x) => x.slot === 'sec' && x.step === '0.1' && x.actionable)).toBe(true);

    // what the card shows: counts only, never a value, a fingerprint or a path
    const first = secr[0]!;
    const d = await detail(c, first.card_id);
    expect(d.view).toMatchObject({ card: 'SECR', of: 2, counts: { open: 2, rotated: 0 } });
    const text = JSON.stringify(d);
    for (const word of ['fingerprint', 'finding_id', 'locations', 'paths', 'first_commit']) {
      expect(text).not.toContain(word);
    }
    expect(d.deciders).toMatchObject({ slot: 'sec', holders: ['sam'] });

    // the admin cannot decide it: only the sec slot
    const wrong = await decideAs(c, first.card_id, 'alice', 'approve', {
      state: 'rotated',
      reason: 'done',
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // a finding is not "rejected" or sent back: it is rotated, a false positive or an accepted fixture
    const sb = await decideAs(c, first.card_id, 'sam', 'request_changes');
    expect(sb.ok).toBe(false);
    const badState = await decideAs(c, first.card_id, 'sam', 'approve', {
      state: 'open',
      reason: 'x',
    });
    expect(badState.ok).toBe(false);
    expect([...c.knowledge.findings.values()].every((f) => f.state === 'open')).toBe(true);

    // finding 1: rotated, by the sec holder
    const one = ok(
      await decideAs(c, first.card_id, 'sam', 'approve', {
        state: 'rotated',
        reason: 'key rotated in the vault',
      }),
    );
    expect(one.value.applied).toBe('applied');
    expect(one.value.decision.entries[0]).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      decision: 'approve',
      actor: 'sam',
      sod_waiver: true,
      body: { card_id: first.card_id, step: '0.1' },
    });
    const rows = (await readCardState(s.record.pool, first.card_id))?.payload?.payload ?? [];
    expect(rows).toEqual([
      { kind: 'finding_state', finding_id: expect.any(String), state: 'rotated' },
    ]);
    expect(one.value.decision.entries[0]?.body).toMatchObject({
      payload_hash: cardPayloadHash(rows),
    });
    // reflected in knowledge, with the person's reason and who
    const states = [...c.knowledge.findings.values()].map((f) => `${f.state}:${f.by}:${f.reason}`);
    expect(states).toContain('rotated:sam:key rotated in the vault');
    expect(c.knowledge.stateCalls).toHaveLength(1);
    // until every finding is resolved the signable level stays census
    expect((await stateOf(c)).record.signable_level).toBe('census');
    expect(await events(c, S0_EVENT.signable_level_set)).toHaveLength(1);

    // finding 2: a false positive. Now the level is released and 0.2 is asked for again
    const second = (await summaries(c)).find(
      (x) => x.card === 'SECR' && x.card_id !== first.card_id,
    )!;
    const two = ok(
      await decideAs(c, second.card_id, 'sam', 'approve', {
        state: 'false_positive',
        reason: 'test token',
      }),
    );
    expect(two.value.applied).toBe('applied');
    expect([...c.knowledge.findings.values()].map((f) => f.state).sort()).toEqual([
      'false_positive',
      'rotated',
    ]);
    const s0 = await stateOf(c);
    expect(s0.record.signable_level).toBe('light');
    expect(s0.steps.get('0.2')?.state).toBe('todo');
    expect((await events(c, S0_EVENT.signable_level_set)).at(-1)).toMatchObject({
      signable_level: 'light',
      reason: 'security.resolved',
    });
    expect(
      (await events(c, S0_EVENT.card_applied))
        .filter((e) => e.card === 'SECR')
        .map((e) => e.outcome),
    ).toEqual(['finding_resolved', 'finding_resolved']);
    // both are ledgered card decisions, each with its own payload hash
    const ledger = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE entry_type = $1 AND actor = 'sam'`,
      [CARD_STEP_ENTRY_TYPE],
    );
    expect(ledger.rows[0].n).toBe(2);
    // card 1 is separate: still open, decided by the admin
    expect((await actionable(c, 'C1')).card).toBe('C1');
  });

  it('knowledge refusing leaves the decision on the ledger and retries the effect on the next sync (no reason is lost to the ledger)', async () => {
    const c = await scenario({
      level: 'light',
      census: { golden: 'b' },
      findings: 1,
      slots: { admin: ['alice'], sec: ['sam'], m4: ['alice'] },
    });
    await c.drive();
    await sync(c);
    const card = (await summaries(c)).find((x) => x.card === 'SECR')!;
    c.knowledge.failStateChanges = true;
    const r = ok(
      await decideAs(c, card.card_id, 'sam', 'approve', {
        state: 'accepted_test_fixture',
        reason: 'fixture',
      }),
    );
    expect(r.value.applied).toBe('pending');
    expect(r.value.apply_error).toMatch(/knowledge/);
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('decided');
    expect([...c.knowledge.findings.values()][0]?.state).toBe('open');
    expect((await stateOf(c)).record.signable_level).toBe('census');
    c.knowledge.failStateChanges = false;
    const again = await sync(c);
    expect(again.applied).toEqual([card.card_id]);
    expect([...c.knowledge.findings.values()][0]).toMatchObject({
      state: 'accepted_test_fixture',
      by: 'sam',
    });
    expect((await stateOf(c)).record.signable_level).toBe('light');
    expect((await sync(c)).applied).toEqual([]);
  });

  it('the level is not released while the scan is incomplete (B2 not met), even with every finding decided', async () => {
    const c = await scenario({
      level: 'light',
      census: { golden: 'b', b2Unknown: true },
      findings: 1,
      slots: { admin: ['alice'], sec: ['sam'], m4: ['alice'] },
    });
    await c.drive();
    await sync(c);
    const card = (await summaries(c)).find((x) => x.card === 'SECR')!;
    const r = ok(
      await decideAs(c, card.card_id, 'sam', 'approve', { state: 'rotated', reason: 'rotated' }),
    );
    expect(r.value.applied).toBe('applied');
    expect([...c.knowledge.findings.values()][0]?.state).toBe('rotated');
    expect((await stateOf(c)).record.signable_level).toBe('census');
    expect(await events(c, S0_EVENT.signable_level_set)).toHaveLength(1);
  });
});

describe('the S0 record moves on', () => {
  it('a parked record withdraws its card: it cannot be decided, and a restore raises a new card', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    // five business days of silence: the driver parks the record
    s.clock.set(new Date(s.clock.now().getTime() + 8 * 24 * 3600 * 1000));
    await driveS0(driverDeps(s, c.host, c.knowledge), c.s0);
    expect((await stateOf(c)).record.status).toBe('parked');
    const w = await sync(c);
    expect(w.withdrawn).toEqual([card.card_id]);
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('withdrawn');
    const late = await prepareOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
    });
    expect(late).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const inbox = await listInbox(c.deps.decisions, pr('alice'));
    expect(inbox.ok && inbox.value.map((i) => i.card.card_id)).not.toContain(card.card_id);
    // restored: the driver asks again, and a new card is opened
    const { resumeS0 } = await import('../src/index.js');
    ok(await resumeS0(s.deps, c.s0, { actor: 'alice' }));
    await c.drive();
    const re = await sync(c);
    expect(re.opened).toHaveLength(1);
    const next = await actionable(c, 'C1');
    expect(next.card_id).not.toBe(card.card_id);
    expect((await events(c, S0_EVENT.card_required)).map((e) => e.occasion)).toEqual([
      'first',
      'again',
    ]);
  });

  it('a decision on the ledger for a record that moved on is recorded stale: nothing moves, nothing is proposed', async () => {
    const c = await scenario();
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    await kernelDecide(c, card.card_id, c1Content(d.view));
    // the owner withdraws the onboarding before the effect is applied
    const { withdrawS0 } = await import('../src/index.js');
    ok(await withdrawS0(s.deps, c.s0, { actor: 'alice' }));
    expect(ok(await applyCard(c.deps, card.card_id, {})).value).toBe('applied');
    expect(await events(c, S0_EVENT.card_applied)).toEqual([
      expect.objectContaining({ card: 'C1', outcome: 'stale', decision: 'approve' }),
    ]);
    const s0 = await stateOf(c);
    expect(s0.record.status).toBe('withdrawn');
    expect(s0.steps.get('0.1')?.state).toBe('card');
    // applied once
    expect(ok(await applyCard(c.deps, card.card_id, {})).value).toBe('noop');
  });
});

describe('the cards loop and the lifecycle of a card', () => {
  it('the loop opens cards and applies decided ones for the records it is given', async () => {
    const c = await scenario();
    await c.drive();
    const spec = cardsLoop(c.deps);
    const run = async () => {
      let failed = 0;
      await spec.tick({
        name: 'onboarding_cards',
        log: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
        async eachItem(items, _label, fn) {
          for (const it of items.filter((x) => x === c.s0)) {
            try {
              await fn(it);
            } catch {
              failed += 1;
            }
          }
        },
      });
      return failed;
    };
    expect(await run()).toBe(0);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    // a crash between the ledger and the record: decided at the kernel level only
    await kernelDecide(c, card.card_id, c1Content(d.view));
    expect((await stateOf(c)).steps.get('0.1')?.state).toBe('card');
    expect(await run()).toBe(0);
    expect((await stateOf(c)).steps.get('0.1')?.state).toBe('done');
    expect(await events(c, S0_EVENT.card_applied)).toHaveLength(1);
  });

  it('cards of the S0 record rebuild: the card streams and the record are the source, the list is a read', async () => {
    const c = await scenario();
    await throughC1(c);
    const cards = await s0Cards(s.record.pool, c.s0);
    expect(cards.map((x) => `${x.kind}:${x.occurrence}:${x.state.status}`)).toEqual([
      'C1:1:decided',
    ]);
  });
});
