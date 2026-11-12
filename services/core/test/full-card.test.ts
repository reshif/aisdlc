import { CARD_STEP_ENTRY_TYPE, S0_EVENT, type Fact } from '@aisdlc/contracts';
import { readCardState } from '@aisdlc/decisions';
import { buildCodeGraph } from '@aisdlc/knowledge';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncCards } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { BASELINE_A } from './cards-fixtures.js';
import { makeHarness, type Json, type Scn } from './harness.js';
import { passProbe } from './probe-fixtures.js';

// Card 3, Full 0.3 (PLAN M17; OB §6.2 row 0.3; FF1; DEC-15(a)) on real Postgres with the real decision kernel,
// ledger and Notary; knowledge (its code graph) and the code host are fakes behind their ports. The baseline is
// recorded first; card 3 is decided by the `intent` slot (G2's), never by the bootstrap grant; the exam is
// measured and never gates; the decided card goes into the PRR as `affirmed.full` and closes RS-KN-7.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'fc');
const { sync, actionable, detail, decideAs, ok, events, stateOf } = h;

const B = (c: string) => c.repeat(40);
const FACTS: Fact[] = [
  {
    kind: 'stack',
    detector: 'stack',
    evidence: [{ path: 'package.json', blob: B('a'), line: 1 }],
    category: 'language',
    name: 'TypeScript',
  },
  {
    kind: 'task_command',
    detector: 'task_contract',
    evidence: [{ path: 'package.json', blob: B('a'), line: 4 }],
    name: 'test',
    state: 'found',
    runner: 'npm',
    invocation: 'npm test',
    source: 'package.json#scripts',
  },
];

const AGENTS_MD = '# app\n\n## Commands\n\n- test: `npm test`\n';

/** The code graph knowledge would serve at the golden census head: two areas, one edge between them, tests. */
const graphAt = (sha: string, repo: string) =>
  buildCodeGraph({
    repo,
    commit_sha: sha,
    skipped_index: 0,
    files: [
      { path: 'package.json', blob: B('1'), content: '{"name":"app"}' },
      { path: 'packages/money/package.json', blob: B('2'), content: '{"name":"@acme/money"}' },
      {
        path: 'packages/money/src/index.ts',
        blob: B('3'),
        content: 'export class Ledger {}\nexport function balance() {}\n',
      },
      {
        path: 'packages/money/test/ledger.test.ts',
        blob: B('4'),
        content: "import { Ledger } from '../src/index.js';\n",
      },
      {
        path: 'src/server.ts',
        blob: B('5'),
        content: "import { balance } from '@acme/money';\nexport function start() {}\n",
      },
      {
        path: 'test/server.test.ts',
        blob: B('6'),
        content: "import { start } from '../src/server.js';\n",
      },
    ],
  });

/** What a person sends to approve card 2 as shown. */
function c2Content(view: Json) {
  return {
    proposal_hash: view.proposal.proposal_hash,
    claims: view.claims.map((x: Json) => ({ claim_id: x.claim_id, verdict: 'affirm' })),
    intent_answers: view.intent_questions.map((q: Json) => ({
      question_id: q.question_id,
      answer: 'payments',
    })),
    practices: {
      attested: true,
      answers: view.practice_questions.map((q: Json) => ({
        question_id: q.question_id,
        answer: 'PR review',
      })),
    },
    instructions: view.instructions
      .filter((f: Json) => f.affirmable)
      .map((f: Json) => ({ path: f.path, text_sha256: f.proposed.text_sha256 })),
  };
}

/** What a person sends to approve card 3 as shown. */
function c3Content(view: Json, over: Record<string, unknown> = {}) {
  return {
    baseline_hash: view.baseline.baseline_hash,
    intent_answers: view.intent_questions.map((q: Json) => ({
      question_id: q.question_id,
      answer: 'it pays people',
    })),
    exam: view.exam.map((q: Json) => ({ question_id: q.question_id, grade: 'incorrect' })),
    seeds: view.seeds.map((x: Json, i: number) =>
      i === 0
        ? { seed_id: x.seed_id, verdict: 'keep_observed' }
        : { seed_id: x.seed_id, verdict: 'affirm' },
    ),
    golden: view.golden_candidates.map((g: Json) => ({
      candidate_id: g.candidate_id,
      verdict: 'accept',
    })),
    ...over,
  };
}

interface FullOpts {
  slots?: Record<string, string[]>;
  bootstrap?: boolean;
  graph?: boolean;
}

/** A Full onboarding through cards 1 and 2 to step 0.3 (card 3 raised, not yet opened). */
async function toFull(o: FullOpts = {}): Promise<Scn> {
  const c = await h.scenario({
    level: 'full',
    host: { atBaseline: [{ path: 'AGENTS.md', content: AGENTS_MD }] },
    census: { trackedGaps: ['RS-KN-7'] },
    ...(o.bootstrap
      ? { slots: 'none' as const, bootstrap: true }
      : o.slots
        ? { slots: o.slots }
        : {}),
  });
  c.knowledge.defaultFacts = FACTS;
  if (o.graph !== false) c.knowledge.setCodeGraph(c.repo, graphAt(BASELINE_A, c.repo));
  await h.throughC1(c);
  expect(await c.drive()).toBe('card');
  await passProbe(c);
  await sync(c);
  const c2 = await actionable(c, 'C2');
  const d2 = await detail(c, c2.card_id);
  ok(await decideAs(c, c2.card_id, 'alice', 'approve', c2Content(d2.view)));
  expect(await c.drive()).toBe('card');
  expect((await stateOf(c)).steps.get('0.3')?.state).toBe('card');
  return c;
}

const allRecordText = async (): Promise<string> =>
  (
    await s.record.pool.query<{ t: string }>(
      `SELECT coalesce(string_agg(body::text, ' '), '') AS t FROM record.record_event`,
    )
  ).rows[0]?.t ?? '';

describe('card 3 (Full 0.3)', () => {
  it('records the baseline first, is decided by the intent slot, and the decision reaches the PRR', async () => {
    const c = await toFull();
    const opened = await sync(c);
    expect(opened.pending).toEqual([]);
    const card = await actionable(c, 'C3');
    expect(card).toMatchObject({ step: '0.3', slot: 'intent' });
    // record-first, once
    const proposed = await events(c, S0_EVENT.full_proposed);
    expect(proposed).toHaveLength(1);
    await sync(c);
    expect(await events(c, S0_EVENT.full_proposed)).toHaveLength(1);

    const d = await detail(c, card.card_id);
    expect(d.view.baseline.baseline_hash).toBe(proposed[0].baseline.baseline_hash);
    expect(d.view.ff1).toEqual({ state: 'met', reasons: [] });
    expect(d.view.system_map.areas.map((a: Json) => a.area)).toEqual(['.', 'packages/money']);
    expect(d.view.system_map.edges).toEqual([{ from: '.', to: 'packages/money', imports: 1 }]);
    expect(d.view.seeds.map((x: Json) => x.status)).toEqual(['observed', 'observed']);
    expect(d.view.intent_questions).toHaveLength(25);
    expect(d.view.exam[0]).toMatchObject({
      answer: 'With `npm test` (from package.json#scripts).',
    });
    expect(d.view.golden_candidates.map((g: Json) => g.test.path)).toEqual([
      'test/server.test.ts',
      'packages/money/test/ledger.test.ts',
    ]);
    expect(d.deciders).toMatchObject({ slot: 'intent', holders: ['alice'] });

    // every exam answer graded incorrect: measured, never a gate
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c3Content(d.view)));
    expect(r.value.applied).toBe('applied');
    expect(r.value.decision.entries[0]).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      decision: 'approve',
      body: { step: '0.3' },
    });
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    expect(rows.find((x) => x.kind === 'exam_score')).toMatchObject({ correct: 0, score_pct: 0 });
    expect(rows.find((x) => x.kind === 'seeds_summary')).toMatchObject({
      total: 2,
      intended: 1,
      observed: 1,
    });
    expect((await stateOf(c)).steps.get('0.3')?.state).toBe('done');

    // through card 4 to the sign-off: the PRR carries the Full baseline and signs Full
    await h.throughC4(c, {
      attestations: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        actions_cannot_approve_prs: true,
        fork_pr_approval_required: true,
        secret_scanning: 'on',
        plan: 'free',
        operations_md: true,
      },
    });
    await h.toC5(c);
    const rec = await s.record.pool.query<{ body: Json }>(
      `SELECT body FROM record.record_event WHERE type = 'prr.proposed' AND body ->> 's0_id' = $1`,
      [c.s0],
    );
    const prr = rec.rows[0]?.body.prr;
    expect(prr.level).toMatchObject({
      requested: 'full',
      signed: 'full',
      steps: { '0.3': 'done' },
    });
    expect(prr.affirmed.full).toMatchObject({
      baseline_hash: d.view.baseline.baseline_hash,
      areas: ['.', 'packages/money'],
      seeds: { total: 2, intended: 1, observed: 1 },
      exam: { correct: 0, score_pct: 0 },
      golden: { accepted: 2 },
      intent: { attested_by: 'alice' },
    });
    expect(prr.autonomy.lanes_eligible).toEqual(expect.arrayContaining(['L4', 'L6']));
    const kn7 = (prr.gaps as Json[]).filter((g) => g.criterion === 'RS-KN-7');
    expect(kn7.map((g) => g.status)).toEqual(['closed_verified']);
  });

  it('only a holder of the intent slot decides it: the admin alone cannot, and the bootstrap grant never covers it', async () => {
    const c = await toFull({
      slots: { admin: ['alice'], sec: ['alice'], m4: ['alice'], intent: ['bob'] },
    });
    await sync(c);
    const card = await actionable(c, 'C3');
    const d = await detail(c, card.card_id);
    expect(d.deciders).toMatchObject({ slot: 'intent', holders: ['bob'] });
    expect(await decideAs(c, card.card_id, 'alice', 'approve', c3Content(d.view))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    ok(await decideAs(c, card.card_id, 'bob', 'approve', c3Content(d.view)));

    // a project's first onboarding: the grant decides cards 1 and 2, never card 3 (PLAN §7a)
    const first = await toFull({ bootstrap: true });
    await sync(first);
    const c3 = await actionable(first, 'C3');
    const d3 = await detail(first, c3.card_id);
    expect(d3.deciders.holders).toEqual([]);
    expect(await decideAs(first, c3.card_id, 'alice', 'approve', c3Content(d3.view))).toMatchObject(
      {
        ok: false,
      },
    );
    expect((await stateOf(first)).steps.get('0.3')?.state).toBe('card');
  });

  it('fails closed: no code graph opens no card; a decision on another baseline or with a secret is refused and stores nothing', async () => {
    const c = await toFull({ graph: false });
    const r = await syncCards(c.deps, c.s0);
    expect(r.ok && r.value.pending.join(' ')).toMatch(/no code graph/);
    expect(await events(c, S0_EVENT.full_proposed)).toHaveLength(0);
    // a graph at another commit is stale: still nothing
    c.knowledge.setCodeGraph(c.repo, graphAt(B('9'), c.repo));
    const stale = await syncCards(c.deps, c.s0);
    expect(stale.ok && stale.value.pending.join(' ')).toMatch(/stale_index/);
    c.knowledge.setCodeGraph(c.repo, graphAt(BASELINE_A, c.repo));
    await sync(c);
    const card = await actionable(c, 'C3');
    const d = await detail(c, card.card_id);

    expect(
      await decideAs(
        c,
        card.card_id,
        'alice',
        'approve',
        c3Content(d.view, { baseline_hash: 'f'.repeat(64) }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const canary = makeCanary('full-card');
    const leaked = await decideAs(
      c,
      card.card_id,
      'alice',
      'approve',
      c3Content(d.view, {
        intent_answers: d.view.intent_questions.map((q: Json) => ({
          question_id: q.question_id,
          answer: `key ${canary}`,
        })),
      }),
    );
    expect(leaked).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await allRecordText()).not.toContain(canary);
    // a send-back is still possible, and the card is still open
    expect((await stateOf(c)).steps.get('0.3')?.state).toBe('card');
  });
});
