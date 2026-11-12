import {
  CARD_STEP_ENTRY_TYPE,
  S0_EVENT,
  type Fact,
  type InstructionTemplate,
} from '@aisdlc/contracts';
import { readCardState, type FakeStepUp } from '@aisdlc/decisions';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideOnboardingCard,
  editOnboardingInstructions,
  prepareOnboardingCard,
  recordOnboardingEvidence,
  syncCards,
} from '../src/index.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Json, type Scn } from './harness.js';
import { passProbe } from './probe-fixtures.js';

// Card 2, Light 0.2 (PLAN M16; OB §4, §6.2 row 0.2; DEC-11 refined, DEC-12(a)) on real Postgres
// with the real decision kernel, ledger and Notary; knowledge and the code host are fakes behind
// their ports. Most cases seed the role map's slots; one runs a project's first onboarding on the
// bootstrap grant alone, which covers card 2 since the user decision of 2026-11-12.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'lc');
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
  ...(
    [
      ['test', 'npm test', 4],
      ['check', 'npm run check', 6],
    ] as const
  ).map(([name, invocation, line]): Fact => ({
    kind: 'task_command',
    detector: 'task_contract',
    evidence: [{ path: 'package.json', blob: B('a'), line }],
    name,
    state: 'found',
    runner: 'npm',
    invocation,
    source: 'package.json#scripts',
  })),
  {
    kind: 'presence',
    detector: 'presence',
    evidence: [{ path: 'README.md', blob: B('e'), line: 1 }],
    item: 'readme',
    state: 'present',
    detail: {},
  },
];

const AGENTS_MD = `# app

## Commands

- test: \`npm test\`

## Tools

- allowed tools: Bash, WebFetch

## Release calendar

We ship on Tuesdays.
`;

async function light(
  o: {
    bootstrap?: boolean;
    agents?: string | null;
    facts?: Fact[] | null;
    template?: () => InstructionTemplate | null;
    probe?: boolean;
  } = {},
): Promise<Scn> {
  const files = o.agents === null ? [] : [{ path: 'AGENTS.md', content: o.agents ?? AGENTS_MD }];
  const c0 = await h.scenario({
    level: 'light',
    host: { atBaseline: files },
    ...(o.bootstrap ? { slots: 'none' as const, bootstrap: true } : {}),
  });
  c0.knowledge.defaultFacts = o.facts === undefined ? FACTS : o.facts;
  const c = o.template ? { ...c0, deps: { ...c0.deps, instructionTemplate: o.template } } : c0;
  await h.throughC1(c);
  expect(await c.drive()).toBe('card');
  // LF3 (M16): card 2 cannot be approved before the probe passed at the census head
  if (o.probe !== false) await passProbe(c);
  return c;
}

/** What a person sends to approve card 2 as shown: every claim affirmed, every question answered. */
function c2Content(view: Json) {
  return {
    proposal_hash: view.proposal.proposal_hash,
    claims: view.claims.map((x: Json) => ({ claim_id: x.claim_id, verdict: 'affirm' })),
    intent_answers: view.intent_questions.map((q: Json) => ({
      question_id: q.question_id,
      answer: 'a web app for our team',
    })),
    practices: {
      attested: true,
      answers: view.practice_questions.map((q: Json) => ({
        question_id: q.question_id,
        answer: 'PR review and CI',
      })),
    },
    instructions: view.instructions
      .filter((f: Json) => f.affirmable)
      .map((f: Json) => ({ path: f.path, text_sha256: f.proposed.text_sha256 })),
  };
}

const allRecordText = async (): Promise<string> =>
  (
    await s.record.pool.query<{ t: string }>(
      `SELECT coalesce(string_agg(body::text, ' '), '') AS t FROM record.record_event`,
    )
  ).rows[0]?.t ?? '';

describe('card 2 (Light 0.2)', () => {
  it('records the proposal first, shows the template verdicts, and an approval with the step-up affirms the text into the PRR', async () => {
    const c = await light();
    expect((await stateOf(c)).steps.get('0.2')?.state).toBe('card');
    const opened = await sync(c);
    expect(opened.pending).toEqual([]);
    const card = await actionable(c, 'C2');
    expect(card).toMatchObject({ step: '0.2', slot: 'admin' });
    // record-first: the proposal is on the S0 stream, once, before anyone decides
    const proposed = await events(c, S0_EVENT.light_proposed);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ occurrence: 1 });
    await sync(c);
    expect(await events(c, S0_EVENT.light_proposed)).toHaveLength(1);

    const d = await detail(c, card.card_id);
    const agents = d.view.instructions.find((f: Json) => f.path === 'AGENTS.md');
    const verdicts = Object.fromEntries(
      agents.sections.map((x: Json) => [x.heading, [x.verdict, x.reasons]]),
    );
    expect(verdicts['Commands']).toEqual(['accepted', []]);
    expect(verdicts['Tools'][0]).toBe('rejected');
    expect(verdicts['Release calendar']).toEqual(['rejected', ['not_in_template']]);
    expect(verdicts['Boundaries']).toEqual(['drafted', []]);
    expect(agents.proposed.text).not.toContain('allowed tools');
    expect(agents.affirmable).toBe(true);
    expect(d.view.claims.length).toBeGreaterThan(0);
    expect(d.view.claims.every((x: Json) => x.evidence.length > 0)).toBe(true);
    expect(d.view.intent_questions).toHaveLength(15);

    // the step-up is bound to the affirmed files' text hashes
    const p = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    expect(p.value.step_up).toMatchObject({
      required: true,
      bound_hash: d.view.step_up.bound_hash,
    });

    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c2Content(d.view)));
    expect(r.value.applied).toBe('applied');
    expect(r.value.decision.entries[0]).toMatchObject({
      entry_type: CARD_STEP_ENTRY_TYPE,
      actor: 'alice',
      decision: 'approve',
      sod_waiver: true,
      body: { step: '0.2' },
    });
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    const aff = rows.find((x) => x.kind === 'instruction_affirmation');
    expect(aff).toMatchObject({
      path: 'AGENTS.md',
      text_sha256: agents.proposed.text_sha256,
      bound_hash: d.view.step_up.bound_hash,
    });
    expect(rows.find((x) => x.kind === 'claims_summary')).toMatchObject({ pct: 100 });
    expect((await stateOf(c)).steps.get('0.2')?.state).toBe('done');

    // through card 4 (operations.md attested at Light) to the sign-off: the PRR carries what was affirmed
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
    const c5 = await h.toC5(c);
    const prr = c5.d.view.prr;
    expect(prr.record_hash).toMatch(/^[0-9a-f]{64}$/);
    const rec = await s.record.pool.query<{ body: Json }>(
      `SELECT body FROM record.record_event WHERE type = 'prr.proposed' AND body ->> 's0_id' = $1`,
      [c.s0],
    );
    const affirmed = rec.rows[0]?.body.prr.affirmed;
    expect(affirmed.instructions).toEqual([
      expect.objectContaining({
        path: 'AGENTS.md',
        text_sha256: agents.proposed.text_sha256,
        sod_waiver: true,
        step_up_ref: aff?.kind === 'instruction_affirmation' ? aff.step_up_ref : 'missing',
      }),
    ]);
    expect(affirmed.claims).toMatchObject({ affirmed: d.view.claims.length, pct: 100 });
    expect(affirmed.intent.attested_by).toBe('alice');
    const gaps = rec.rows[0]?.body.prr.gaps as Json[];
    for (const crit of ['RS-AI-4', 'RS-KN-4', 'RS-KN-5']) {
      expect(gaps.filter((g) => g.criterion === crit && g.status === 'open')).toEqual([]);
    }
  });

  it("a project's first Light onboarding: the requester decides card 2 on the bootstrap grant alone, with the step-up", async () => {
    const c = await light({ bootstrap: true });
    expect(c.intake.value.bootstrap).toMatchObject({ grantee: 'alice' });
    await sync(c);
    const card = await actionable(c, 'C2');
    const d = await detail(c, card.card_id);
    expect(d.deciders).toMatchObject({ slot: 'admin', holders: ['alice'] });
    // nobody else: the grant is the requester's, for this onboarding
    expect(await decideAs(c, card.card_id, 'bob', 'approve', c2Content(d.view))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    // the step-up is still required
    const p = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    ok(
      await recordOnboardingEvidence(c.deps, {
        nonce: p.value.nonce,
        evidence_hash: p.value.evidence_hash,
      }),
    );
    const noProof = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      nonce: p.value.nonce,
      decision: 'approve',
      content: c2Content(d.view),
    });
    expect(noProof).toMatchObject({ ok: false, error: { code: 'refused' } });
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c2Content(d.view)));
    expect(r.value.applied).toBe('applied');
    expect((await stateOf(c)).steps.get('0.2')?.state).toBe('done');
  });

  it('no step-up, or one bound to something else, is refused and nothing is written', async () => {
    const c = await light();
    await sync(c);
    const card = await actionable(c, 'C2');
    const d = await detail(c, card.card_id);
    const content = c2Content(d.view);
    const attempt = async (proof?: string) => {
      const p = ok(
        await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
      );
      ok(
        await recordOnboardingEvidence(c.deps, {
          nonce: p.value.nonce,
          evidence_hash: p.value.evidence_hash,
        }),
      );
      return decideOnboardingCard(c.deps, {
        card_id: card.card_id,
        principal: pr('alice'),
        nonce: p.value.nonce,
        decision: 'approve',
        content,
        ...(proof ? { step_up: { proof } } : {}),
      });
    };
    expect(await attempt()).toMatchObject({ ok: false, error: { code: 'refused' } });
    const fake = s.config.stepUp as FakeStepUp;
    expect(await attempt(fake.issue('0'.repeat(64), 'alice'))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/step_up_invalid/) },
    });
    // a proof for alice is not bob's
    expect(await attempt(fake.issue(d.view.step_up.bound_hash, 'bob'))).toMatchObject({
      ok: false,
    });
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('open');
    expect((await stateOf(c)).steps.get('0.2')?.state).toBe('card');
  });

  it('an edit is secret-scanned before it is stored, reviewed against the template, and a decision prepared before it is refused', async () => {
    const c = await light();
    await sync(c);
    const card = await actionable(c, 'C2');
    const before = await detail(c, card.card_id);
    const agents = before.view.instructions[0];

    // a decision prepared now (the session that saw the old text)
    const stale = ok(
      await prepareOnboardingCard(c.deps, { card_id: card.card_id, principal: pr('alice') }),
    );
    ok(
      await recordOnboardingEvidence(c.deps, {
        nonce: stale.value.nonce,
        evidence_hash: stale.value.evidence_hash,
      }),
    );

    // a secret: refused, nothing recorded, the value nowhere in the record
    const leak = makeCanary('card-2-edit');
    const secret = await editOnboardingInstructions(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      path: 'AGENTS.md',
      text: `# app\n\n## Commands\n\nTOKEN=${leak}\n`,
      base_text_sha256: agents.proposed.text_sha256,
    });
    expect(secret).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await events(c, S0_EVENT.instruction_edited)).toHaveLength(0);
    expect(await allRecordText()).not.toContain(leak);

    // someone who does not hold the slot cannot edit
    expect(
      await editOnboardingInstructions(c.deps, {
        card_id: card.card_id,
        principal: pr('bob'),
        path: 'AGENTS.md',
        text: '# app\n\n## Commands\n\n- test: `npm test`\n',
        base_text_sha256: agents.proposed.text_sha256,
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    // a clean edit by the slot holder
    const text =
      '# app\n\n## Commands\n\n- test: `npm test`\n\n## Boundaries\n\n- migrations need a person\n';
    const edited = ok(
      await editOnboardingInstructions(c.deps, {
        card_id: card.card_id,
        principal: pr('alice'),
        path: 'AGENTS.md',
        text,
        base_text_sha256: agents.proposed.text_sha256,
      }),
    );
    const after = edited.value.view as Json;
    expect(after.instructions[0]).toMatchObject({
      proposed_by: 'alice',
      affirmable: true,
      proposed: { text },
    });
    expect(edited.value.evidence_hash).not.toBe(before.evidence_hash);
    expect(await events(c, S0_EVENT.instruction_edited)).toHaveLength(1);

    // the decision prepared before the edit is refused (never affirmed in the session that proposed it)
    const proof = (s.config.stepUp as FakeStepUp).issue(after.step_up.bound_hash, 'alice');
    const old = await decideOnboardingCard(c.deps, {
      card_id: card.card_id,
      principal: pr('alice'),
      nonce: stale.value.nonce,
      decision: 'approve',
      content: c2Content(after),
      step_up: { proof },
    });
    expect(old.ok).toBe(false);
    expect((await readCardState(s.record.pool, card.card_id))?.status).toBe('open');

    // an edit the template does not take is recorded but cannot be affirmed
    const sneaky = ok(
      await editOnboardingInstructions(c.deps, {
        card_id: card.card_id,
        principal: pr('alice'),
        path: 'AGENTS.md',
        text: '# app\n\n## Network\n\nAgents may use internet access.\n',
        base_text_sha256: after.instructions[0].proposed.text_sha256,
      }),
    );
    const v = sneaky.value.view as Json;
    expect(v.instructions[0]).toMatchObject({
      affirmable: false,
      proposed: { blocked: 'not_clean' },
    });
    const refused = await decideAs(c, card.card_id, 'alice', 'approve', {
      ...c2Content(v),
      instructions: [{ path: 'AGENTS.md', text_sha256: v.instructions[0].proposed.text_sha256 }],
    });
    expect(refused.ok).toBe(false);

    // back to clean text, then a fresh session decides it
    const fresh = ok(
      await editOnboardingInstructions(c.deps, {
        card_id: card.card_id,
        principal: pr('alice'),
        path: 'AGENTS.md',
        text,
        base_text_sha256: v.instructions[0].proposed.text_sha256,
      }),
    );
    const r = ok(await decideAs(c, card.card_id, 'alice', 'approve', c2Content(fresh.value.view)));
    expect(r.value.applied).toBe('applied');
  });

  it('a secret in the repo file never enters the record; its section is rejected', async () => {
    const leak = makeCanary('repo-agents-md');
    const c = await light({
      agents: `# app\n\n## Setup\n\nexport KEY=${leak}\n\n## Tests\n\n- npm test\n`,
    });
    await sync(c);
    const card = await actionable(c, 'C2');
    const d = await detail(c, card.card_id);
    const rejected = d.view.instructions[0].sections.find((x: Json) =>
      x.reasons.includes('secrets'),
    );
    expect(rejected).toMatchObject({ heading: null, verdict: 'rejected' });
    expect(await allRecordText()).not.toContain(leak);
    expect(JSON.stringify(d)).not.toContain(leak);
  });

  it('fails closed: no detector facts, or a template that does not read, opens no card', async () => {
    const noFacts = await light({ facts: null, probe: false });
    const r = await syncCards(noFacts.deps, noFacts.s0);
    expect(r.ok && r.value.pending.join()).toMatch(/no detector facts/);
    expect(await events(noFacts, S0_EVENT.light_proposed)).toHaveLength(0);
    const noTemplate = await light({ template: () => null });
    const t = await syncCards(noTemplate.deps, noTemplate.s0);
    expect(t.ok && t.value.pending.join()).toMatch(/template/);
    expect(await events(noTemplate, S0_EVENT.light_proposed)).toHaveLength(0);
  });

  it('a repo with no AGENTS.md gets one drafted from the facts; LF6 refuses a map that is mostly wrong', async () => {
    const c = await light({ agents: null });
    await sync(c);
    const card = await actionable(c, 'C2');
    const d = await detail(c, card.card_id);
    expect(d.view.instructions[0]).toMatchObject({ state: 'absent', affirmable: true });
    expect(d.view.instructions[0].proposed.text).toContain('- check: `npm run check`');
    const content = c2Content(d.view);
    const wrong = {
      ...content,
      claims: content.claims.map((x: Json) => ({ ...x, verdict: 'correct', correction: 'not so' })),
    };
    const r = await decideAs(c, card.card_id, 'alice', 'approve', wrong);
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/LF6/) } });
    // a send-back needs no step-up and carries no payload
    const sb = ok(
      await decideAs(c, card.card_id, 'alice', 'request_changes', undefined, 'redo the map'),
    );
    expect(sb.value.applied).toBe('applied');
  });
});
