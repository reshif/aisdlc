import {
  CARD_STEP_ENTRY_TYPE,
  ORACLE_LOCK_PATH,
  PACK_EVENT,
  S0_EVENT,
  KDEFECT_EVENT,
  REONBOARD_EVENT,
  kdefectStream,
  packStream,
  reonboardStream,
  type Fact,
  type KnowledgeDefect,
} from '@aisdlc/contracts';
import { startTestCodeHost } from '@aisdlc/codehost/testing';
import { readCardState } from '@aisdlc/decisions';
import { buildCodeGraph } from '@aisdlc/knowledge';
import { emptySeed } from '@aisdlc/ports';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CorePushGuards,
  coreInbox,
  laneEligibility,
  listReonboardProposals,
  rebuildKnowledgeDefects,
  recordKnowledgeDefects,
  listPushReceipts,
  projectFullPack,
  projectKnowledge,
  projectPack,
  rebuildPacks,
  syncCards,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { BASELINE_A } from './cards-fixtures.js';
import { makeHarness, type Json, type Scn } from './harness.js';
import { passProbe } from './probe-fixtures.js';
import { decideGate } from './work-fixtures.js';

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
    // DEC-25: the levels per area of the system map, the table M4 binds to (in the record, so its hash)
    expect(prr.level.by_area).toEqual({ '.': 'full', 'packages/money': 'full' });
    expect(prr.level.areas.map((a: Json) => [a.area, a.floors.map((f: Json) => f.state)])).toEqual([
      ['.', ['met', 'met']],
      ['packages/money', ['met', 'met']],
    ]);
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

describe('the oracle lock through X2 (M17)', () => {
  const CORRECTED = '# packages/money\n\nThe ledger keeps every balance in integer cents.\n';

  async function approveC3(c: Scn) {
    await sync(c);
    const card = await actionable(c, 'C3');
    const d = await detail(c, card.card_id);
    const seeds = d.view.seeds.map((x: Json) =>
      x.area === 'packages/money'
        ? { seed_id: x.seed_id, verdict: 'correct', correction: CORRECTED }
        : { seed_id: x.seed_id, verdict: 'keep_observed' },
    );
    ok(await decideAs(c, card.card_id, 'alice', 'approve', c3Content(d.view, { seeds })));
    return d.view;
  }

  it('renders the lock and the intended seeds from the record, records first, X2 on the S0 record bound to the patch, then a draft PR', async () => {
    const c = await toFull();
    s.elig.setHolders(c.project as never, 'x', ['bob' as never]);
    const host = await startTestCodeHost({
      seed: emptySeed({
        installation: {
          installation_id: 4244,
          account_login: 'acme',
          repository_selection: 'selected',
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended: false,
        },
        repos: [{ full_name: c.repo, default_branch: 'main', private: true, archived: false }],
        heads: [{ repo: c.repo, branch: 'main', sha: BASELINE_A }],
        files: [{ repo: c.repo, sha: BASELINE_A, path: 'AGENTS.md', content: AGENTS_MD }],
      }),
      mode: 'push',
      guards: new CorePushGuards(s.record.pool),
    });
    try {
      const deps = {
        cards: c.deps,
        push: { pool: s.record.pool, clock: s.clock, ledger: s.deps.ledger as never },
        broker: host.rest,
      };
      // card 3 not decided yet: nothing to render, nothing recorded
      expect(await projectFullPack(deps, c.s0)).toMatchObject({
        ok: true,
        value: { kind: 'full', state: 'waiting_for_c2' },
      });
      // the Knowledge screen before card 3 is decided: the baseline is recorded, nothing is decided
      await sync(c);
      const before = await projectKnowledge(s.record.pool, c.project);
      const mine = (v: typeof before) => v?.repos.find((r) => r.repo === c.repo);
      expect(mine(before)?.baseline?.decided).toBe(false);
      expect(mine(before)?.seeds.map((x) => [x.status, x.verdict])).toEqual([
        ['observed', null],
        ['observed', null],
      ]);
      const view = await approveC3(c);
      // after it: the corrected seed is intended with the person's text, the golden tasks carry their verdicts,
      // the repo index and the map come from the recorded baseline (D2: core answers in full; the bff cuts it)
      const k = mine(await projectKnowledge(s.record.pool, c.project));
      expect(k?.baseline).toMatchObject({ decided: true, baseline_sha: BASELINE_A });
      expect(k?.areas.map((a) => a.area)).toEqual(['.', 'packages/money']);
      expect(k?.code_graph?.area_edges).toEqual([{ from: '.', to: 'packages/money', imports: 1 }]);
      const corrected = k?.seeds.find((x) => x.area === 'packages/money');
      expect(corrected).toMatchObject({
        status: 'intended',
        verdict: 'correct',
        text: CORRECTED.trim(),
      });
      expect(k?.golden.map((g) => g.verdict)).toEqual(['accept', 'accept']);
      expect(k?.index?.files).toBe(6);

      const v = await projectFullPack(deps, c.s0);
      if (!v.ok) throw new Error(v.error.message);
      expect(v.value).toMatchObject({ kind: 'full', state: 'x2_pending' });
      const money = view.seeds.find((x: Json) => x.area === 'packages/money');
      expect(v.value.files.map((f) => [f.path, f.source])).toEqual([
        ['.factory/knowledge/full-pack.json', 'manifest'],
        [ORACLE_LOCK_PATH, 'oracle_lock'],
        [money.path, 'seed'],
      ]);
      // the seed kept `observed` is not written
      const kept = view.seeds.find((x: Json) => x.area === '.');
      expect(v.value.files.some((f) => f.path === kept.path)).toBe(false);

      // record first: rendered, then X2; nothing reached the host
      const ev = await s.record.pool.query<{ type: string; body: Json }>(
        'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
        [packStream(c.s0)],
      );
      // card 2's pack (light) is a projection of its own; the Full one is rendered, then its X2 opened
      expect(
        ev.rows
          .filter((r) => r.body.kind === 'full' || r.body.patch_hash === v.value.patch_hash)
          .map((r) => r.type),
      ).toEqual([PACK_EVENT.rendered, PACK_EVENT.x2_opened]);
      const full = ev.rows.filter((r) => r.type === PACK_EVENT.rendered && r.body.kind === 'full');
      expect(full).toHaveLength(1);
      expect(full[0]?.body).toMatchObject({ patch_hash: v.value.patch_hash, base_sha: BASELINE_A });
      expect(host.server.apiRequests.filter((r) => r.method !== 'GET')).toEqual([]);

      // X2 on the S0 record, its subject hash the patch hash, the pack a 0.3 artefact
      const x2 = await readCardState(s.record.pool, v.value.x2_card_id as string);
      expect(x2?.open).toMatchObject({ subject_kind: 's0_record', subject_id: c.s0, label: 'X2' });
      const gate = x2?.gates[0]?.state.open.payload;
      expect(gate).toMatchObject({
        gate_id: 'X2',
        subject_hash: v.value.patch_hash,
        facts: {
          kind: 'onboarding_full_pack',
          branch: `agent/${c.s0}/onboarding-full-pack`,
          artefacts: [{ step: '0.3', sha256: v.value.patch_hash }],
        },
      });
      // idempotent
      const again = await projectFullPack(deps, c.s0);
      expect(again.ok && again.value.x2_card_id).toBe(v.value.x2_card_id);
      // the Full pack's X2 card is in the inbox too (M16 lists every S0 pack's X2), for the X slot
      const inbox = await coreInbox({ cards: deps.cards, clock: s.clock });
      expect(inbox.filter((i) => i.id === v.value.x2_card_id)).toEqual([
        expect.objectContaining({ kind: 'onboarding_card', label: 'X2', s0_id: c.s0, slot: 'x' }),
      ]);

      // the guards: the Full pack has its own lease; the X2 binds only its own patch
      const guards = new CorePushGuards(s.record.pool);
      expect(await guards.lease(c.s0, 'onboarding-full-pack')).toEqual({
        state: 'ok',
        value: { held: true, epoch: 1, lane: 'S0' },
      });
      expect(await guards.x2Bound(c.s0, v.value.patch_hash as string)).toEqual({
        state: 'ok',
        value: false,
      });
      const dec = await decideGate(s, x2?.gates[0]?.gate_instance_id as string, 'bob', 'approve');
      expect(dec.ok, JSON.stringify(dec)).toBe(true);
      expect(await guards.x2Bound(c.s0, v.value.patch_hash as string)).toEqual({
        state: 'ok',
        value: true,
      });

      const pushed = await projectFullPack(deps, c.s0);
      if (!pushed.ok) throw new Error(pushed.error.message);
      expect(pushed.value).toMatchObject({ kind: 'full', state: 'pushed' });
      const pull = host.server.pulls.find(
        (p) => p.head.ref === `agent/${c.s0}/onboarding-full-pack`,
      );
      expect(pull).toMatchObject({ draft: true });
      const at = (path: string) =>
        host.server.objects.fileAt(c.repo, pull?.head.sha ?? '', path)?.toString() ?? '';
      const lock = JSON.parse(at(ORACLE_LOCK_PATH));
      expect(lock).toMatchObject({
        schema: 'oracle-lock/1',
        s0_record: c.s0,
        base_sha: BASELINE_A,
        lock_hash: view.oracle_lock.lock_hash,
      });
      expect(lock.tests.map((t: Json) => t.path)).toEqual(
        view.oracle_lock.tests.map((t: Json) => t.path).sort(),
      );
      const seed = at(money.path);
      expect(seed).toContain('status: intended');
      expect(seed).toContain('integer cents');
      // the factory never merges
      expect(
        host.server.apiRequests.some((r) => r.method !== 'GET' && r.path.includes('merge')),
      ).toBe(false);
      const receipts = (await listPushReceipts(s.record.pool, c.s0)).filter(
        (r) => r.unit_key === 'onboarding-full-pack',
      );
      expect(receipts.map((r) => r.status)).toEqual(['applied']);

      // the Light pack is a separate projection: its own row, its own X2 and branch
      const light = await projectPack({ ...deps, broker: undefined } as never, c.s0);
      expect(light.ok && light.value.kind).toBeUndefined();
      expect(light.ok && light.value.x2_card_id).not.toBe(v.value.x2_card_id);

      // rebuilt from the events alone
      await s.record.pool.query('DELETE FROM core.onboarding_pack WHERE s0_id = $1', [c.s0]);
      await rebuildPacks({ pool: s.record.pool }, c.s0);
      const back = await projectFullPack(deps, c.s0);
      expect(back.ok && back.value).toMatchObject({
        state: 'pushed',
        x2_card_id: v.value.x2_card_id,
      });
    } finally {
      await host.stop();
    }
  });
});

describe('knowledge defects as a re-onboarding trigger (M17, OB §8)', () => {
  const ATTEST = {
    bypass_has_no_factory_app: true,
    app_scope_selected: true,
    github_token_readonly: true,
    actions_cannot_approve_prs: true,
    fork_pr_approval_required: true,
    secret_scanning: 'on',
    plan: 'free',
    operations_md: true,
  };
  const defect = (path: string | null, rules: string[] = ['L-GATE']): KnowledgeDefect =>
    ({
      kind: 'directive_in_repo_text',
      level: 7,
      path,
      rules,
      detail: 'kept as data',
    }) as KnowledgeDefect;

  async function signedFull(over: Record<string, unknown> = {}): Promise<Scn> {
    const c = await toFull();
    await sync(c);
    const card = await actionable(c, 'C3');
    const d = await detail(c, card.card_id);
    ok(await decideAs(c, card.card_id, 'alice', 'approve', c3Content(d.view, over)));
    await h.throughC4(c, { attestations: ATTEST });
    const { card: c5 } = await h.toC5(c);
    ok(await decideAs(c, c5.card_id, 'alice', 'approve', {}));
    return c;
  }

  it('FF2 with ServiceEnv: L5 opens only for a Full record whose card 3 attested staging separation', async () => {
    const prrOf = async (c: Scn) =>
      (
        await s.record.pool.query<{ body: Json }>(
          `SELECT body FROM record.record_event WHERE type = 'prr.proposed' AND body ->> 's0_id' = $1`,
          [c.s0],
        )
      ).rows[0]?.body.prr;
    const yes = await signedFull({
      service_envs: {
        services: [{ service: 'api', environments: ['staging', 'production'] }],
        staging_separation: 'yes',
      },
    });
    const p = await prrOf(yes);
    expect(p.autonomy.lanes_eligible).toContain('L5');
    expect(p.affirmed.full.service_envs).toMatchObject({
      ff2: 'met',
      staging_separation: 'yes',
      envs: [
        { service_env_id: `senv:${yes.project}:api:production`, environment: 'production' },
        { service_env_id: `senv:${yes.project}:api:staging`, environment: 'staging' },
      ],
    });
    const lane = await laneEligibility(s.record.pool, yes.repo, 'L5', s.clock);
    expect(lane).toMatchObject({ eligible: true, route: 'normal' });

    // attested no: FF2 unmet, L5 goes to L8 for the reason that says so
    const no = await signedFull({
      service_envs: {
        services: [{ service: 'api', environments: ['staging', 'production'] }],
        staging_separation: 'no',
      },
    });
    expect((await prrOf(no)).autonomy.lanes_eligible).not.toContain('L5');
    expect(await laneEligibility(s.record.pool, no.repo, 'L5', s.clock)).toMatchObject({
      eligible: false,
      route: 'l8',
      reason: 'staging_separation_not_attested',
    });
  });

  it('the threshold is config, not a constant: one defect in 30 days trips it when the value says so', async () => {
    const c = await signedFull();
    const r = await recordKnowledgeDefects(
      {
        pool: s.record.pool,
        clock: s.clock,
        reonboardTriggers: () => ({ knowledge_defects: { count: 1, window_days: 30 } }),
      },
      { repo: c.repo, defects: [defect('AGENTS.md')], source: { kind: 'other', ref: 'x' } },
    );
    expect(r.ok && r.value.proposals.map((p) => [p.area, p.threshold])).toEqual([['.', 1]]);
  });

  it('records repo defects in their area; three in an area within 30 days propose re-onboarding once, recorded first', async () => {
    const c = await signedFull();
    const deps = { pool: s.record.pool, clock: s.clock };
    const src = (n: number) => ({ kind: 'item_step' as const, ref: `item-${n}:3.1` });

    // context paths (the request, an earlier artefact) are not repo text: nothing is recorded
    const none = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('artefact:request@abc'), defect(null)],
      source: src(0),
    });
    expect(none).toMatchObject({ ok: true, value: { recorded: 0, proposals: [] } });

    // two in packages/money and one in the root area: below the threshold in each
    const first = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('packages/money/README.md'), defect('README.md')],
      source: src(1),
    });
    expect(first).toMatchObject({ ok: true, value: { recorded: 2, proposals: [] } });
    // the same defect from the same source is recorded once
    const repeat = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('packages/money/README.md')],
      source: src(1),
    });
    expect(repeat).toMatchObject({ ok: true, value: { recorded: 0 } });
    const second = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('packages/money/src/index.ts', ['L-LANE'])],
      source: src(2),
    });
    expect(second.ok && second.value.proposals).toEqual([]);
    const ev = await s.record.pool.query<{ body: Json }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
      [kdefectStream(c.repo), KDEFECT_EVENT.recorded],
    );
    expect(ev.rows.map((r) => r.body.area)).toEqual(['packages/money', '.', 'packages/money']);
    expect(JSON.stringify(ev.rows)).not.toContain('kept as data'); // logged, never quoted

    // the third in packages/money trips it: a proposal for that area, recorded
    const third = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('packages/money/test/ledger.test.ts')],
      source: src(3),
    });
    if (!third.ok) throw new Error(third.error.message);
    expect(third.value.proposals).toHaveLength(1);
    expect(third.value.proposals[0]).toMatchObject({
      area: 'packages/money',
      trigger: 'knowledge_defects',
      count: 3,
      threshold: 3,
      window_days: 30,
      prr_version: 1,
    });
    const rec = await s.record.pool.query<{ type: string }>(
      'SELECT type FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [reonboardStream(c.repo)],
    );
    expect(rec.rows.map((r) => r.type)).toEqual([REONBOARD_EVENT.proposed]);
    // while it is open, more defects in the area propose nothing new
    const fourth = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('packages/money/package.json')],
      source: src(4),
    });
    expect(fourth.ok && fourth.value.proposals).toEqual([]);
    // the proposal never changes a level: one record, as signed
    const prr = await s.record.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM record.record_event WHERE type = 'prr.proposed' AND body ->> 's0_id' = $1`,
      [c.s0],
    );
    expect(prr.rows[0]?.n).toBe('1');

    // the read models are rebuilt from the events alone
    await s.record.pool.query('DELETE FROM core.reonboard_proposal WHERE repo = $1', [
      c.repo.toLowerCase(),
    ]);
    expect(await rebuildKnowledgeDefects(deps, c.repo)).toBe(6);
    expect((await listReonboardProposals(s.record.pool, c.repo)).map((p) => p.area)).toEqual([
      'packages/money',
    ]);

    // outside the window: the old root-area defect does not count with two new ones
    s.clock.advance(31 * 86_400_000);
    const late = await recordKnowledgeDefects(deps, {
      repo: c.repo,
      defects: [defect('src/server.ts'), defect('test/server.test.ts')],
      source: src(5),
    });
    expect(late.ok && late.value).toMatchObject({ recorded: 2, proposals: [] });
  });
});
