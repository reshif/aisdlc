import {
  REONBOARD_EVENT,
  REONBOARD_LEDGER_ENTRY,
  reonboardStream,
  type KnowledgeDefect,
} from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  coreInbox,
  decideReonboarding,
  laneEligibility,
  listReonboardProposals,
  projectDriftView,
  readGoverning,
  rebuildKnowledgeDefects,
  recordKnowledgeDefects,
  type DriftActionDeps,
} from '../src/index.js';
import { pid, pr, setSlots, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Scn } from './harness.js';

// Accepting a re-onboarding proposal (PLAN M17 part 2; OB §8: "Accept -> S0 from 0.1 -> new version -> M4") on real
// Postgres with the real decision kernel, ledger and Notary. Knowledge defects in an area propose re-onboarding; the
// project's admin slot decides it: the decision is recorded first with its ledger entry, an accept starts a new S0
// record at the signed level (0.1 again, then cards 1, 4 and 5), and the signed version governs until that M4.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'ro');
const { decideAs, ok } = h;

const defect = (path: string): KnowledgeDefect =>
  ({
    kind: 'directive_in_repo_text',
    level: 7,
    path,
    rules: ['L-GATE'],
    detail: 'kept as data',
  }) as KnowledgeDefect;

/** A Census repo signed at M4 (version 1). */
async function signedCensus(): Promise<Scn> {
  const c = await h.scenario();
  await h.throughC1(c);
  await h.throughC4(c);
  const { card } = await h.toC5(c);
  ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));
  return c;
}

const driftDeps = (c: Scn): DriftActionDeps => ({
  ...s.deps,
  ledger: s.config.ledger,
  source: c.host,
  eligibility: s.config.eligibility,
  stepUp: s.config.stepUp,
  bypass: () => ({}),
});

/** One defect proposes re-onboarding (the threshold as config: 1 in 30 days). */
async function propose(c: Scn, path = 'README.md') {
  const r = await recordKnowledgeDefects(
    {
      pool: s.record.pool,
      clock: s.clock,
      reonboardTriggers: () => ({ knowledge_defects: { count: 1, window_days: 30 } }),
    },
    { repo: c.repo, defects: [defect(path)], source: { kind: 'other', ref: `t:${path}` } },
  );
  if (!r.ok) throw new Error(r.error.message);
  const p = r.value.proposals[0];
  if (!p) throw new Error('no proposal');
  return p;
}

const governing = async (c: Scn) => (await readGoverning(s.record.pool, c.repo))?.governing;

describe('accepting a re-onboarding proposal (M17, OB §8)', () => {
  it('a card for the admin slot; accept is ledgered, starts a new S0 from 0.1, and the signed version governs until the new M4', async () => {
    const c = await signedCensus();
    const v1 = await governing(c);
    expect(v1).toMatchObject({ version: 1, status: 'active' });
    const p = await propose(c);

    // the inbox: one card for the admin slot, decided on the project's drift page
    const inbox = await coreInbox({ cards: c.deps, clock: s.clock });
    const card = inbox.find((i) => i.kind === 'reonboard' && i.id === c.repo);
    expect(card).toMatchObject({ slot: 'admin', holders: ['alice'], feasibility: 'feasible' });
    const view = await projectDriftView(s.record.pool, pid(c.project), {
      clock: s.clock,
      bypass: () => ({}),
    });
    expect(view.repos[0]?.reonboarding).toEqual([
      expect.objectContaining({ proposal_id: p.proposal_id, status: 'proposed', decision: null }),
    ]);

    const d = driftDeps(c);
    const r = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: p.proposal_id,
      decision: 'accept',
      reason: 'the docs drifted from the code',
      on_behalf_of: pr('alice'),
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({ decision: 'accept', status: 'accepted', duplicate: false });
    const newS0 = r.value.new_s0_id as string;
    expect(newS0).not.toBe(c.s0);

    // recorded first, with its ledger entry on the governing S0 record
    const rec = await s.record.pool.query<{ type: string }>(
      'SELECT type FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [reonboardStream(c.repo)],
    );
    expect(rec.rows.map((x) => x.type)).toEqual([
      REONBOARD_EVENT.proposed,
      REONBOARD_EVENT.decided,
    ]);
    const le = await s.record.pool.query<{ entry_type: string; subject_id: string; actor: string }>(
      'SELECT entry_type, subject_id::text, actor FROM ledger.ledger_entry WHERE entry_id = $1',
      [r.value.ledger_entry_id],
    );
    expect(le.rows[0]).toEqual({
      entry_type: REONBOARD_LEDGER_ENTRY,
      subject_id: c.s0,
      actor: 'alice',
    });

    // the new S0 record asks for the signed level and starts at 0.1
    const asked = await s.record.pool.query<{ body: { requested_level: string } }>(
      "SELECT body FROM record.record_event WHERE stream = $1 AND type = 's0.requested'",
      [`s0:${newS0}`],
    );
    expect(asked.rows[0]?.body.requested_level).toBe('census');

    // a retry is the same decision and the same S0 record; the other decision is refused
    const again = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: p.proposal_id,
      decision: 'accept',
      reason: 'again',
      on_behalf_of: pr('alice'),
    });
    expect(again.ok && again.value).toMatchObject({ duplicate: true, new_s0_id: newS0 });
    const other = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: p.proposal_id,
      decision: 'decline',
      reason: 'no',
      on_behalf_of: pr('alice'),
    });
    expect(other.ok ? null : other.error.code).toBe('conflict');
    expect(
      (await coreInbox({ cards: c.deps, clock: s.clock })).some(
        (i) => i.kind === 'reonboard' && i.id === c.repo,
      ),
    ).toBe(false);

    // until the new M4 the signed version governs: same version, same hash, still active
    const n = h.next(c, newS0);
    await h.throughC1(n);
    await h.throughC4(n);
    const { card: c5 } = await h.toC5(n);
    expect(await governing(c)).toMatchObject({
      version: 1,
      status: 'active',
      prr: { record_hash: v1?.prr.record_hash },
    });
    expect(await laneEligibility(s.record.pool, c.repo, 'L8', s.clock)).toMatchObject({
      prr: { version: 1 },
    });
    // the new M4: version 2 governs, version 1 is superseded
    ok(await decideAs(n, c5.card_id, 'alice', 'approve', {}));
    const v2 = await governing(c);
    expect(v2).toMatchObject({ version: 2, status: 'active' });
    expect(v2?.prr.supersedes).toBe(v1?.prr.record_hash);

    // rebuilt from the events alone: the decision is on the proposal
    await s.record.pool.query('DELETE FROM core.reonboard_proposal WHERE repo = $1', [
      c.repo.toLowerCase(),
    ]);
    await rebuildKnowledgeDefects({ pool: s.record.pool, clock: s.clock }, c.repo);
    expect(await listReonboardProposals(s.record.pool, c.repo)).toEqual([
      expect.objectContaining({
        status: 'accepted',
        decision: expect.objectContaining({ by: 'alice', new_s0_id: newS0, level: 'census' }),
      }),
    ]);
  });

  it('decline closes it and changes nothing; only a holder of the admin slot decides; an unknown proposal is not found', async () => {
    const c = await signedCensus();
    const p = await propose(c);
    const d = driftDeps(c);
    setSlots(s, c.project, { admin: ['bob'], sec: ['alice'], m4: ['alice'], intent: ['alice'] });
    const refused = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: p.proposal_id,
      decision: 'decline',
      reason: 'not now',
      on_behalf_of: pr('alice'),
    });
    expect(refused.ok ? null : refused.error.code).toBe('refused');
    const missing = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: 'f'.repeat(64),
      decision: 'accept',
      reason: 'x',
      on_behalf_of: pr('bob'),
    });
    expect(missing.ok ? null : missing.error.code).toBe('not_found');
    const r = await decideReonboarding(d, pid(c.project), {
      repo: c.repo as never,
      proposal_id: p.proposal_id,
      decision: 'decline',
      reason: 'the defects were in vendored docs',
      on_behalf_of: pr('bob'),
    });
    expect(r.ok && r.value).toMatchObject({ status: 'declined', new_s0_id: null });
    const s0s = await s.record.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM record.record_event WHERE type = 's0.requested' AND lower(body ->> 'repo') = $1",
      [c.repo.toLowerCase()],
    );
    expect(s0s.rows[0]?.n).toBe(1);
    expect(await governing(c)).toMatchObject({ version: 1, status: 'active' });
    // closed, so the next trip in the area may propose again
    const p2 = await propose(c, 'docs/a.md');
    expect(p2.proposal_id).not.toBe(p.proposal_id);
  });
});
