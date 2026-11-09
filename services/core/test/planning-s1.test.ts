import { catalogueFor, currentCatalogueRef } from '@aisdlc/catalogue';
import type { PrrGatingProfile } from '@aisdlc/contracts';
import { PLANNING_EVENT, planningStream } from '@aisdlc/contracts';
import type { TestGateway } from '@aisdlc/gateway/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptedIntentOf,
  answerQuestion,
  laneForClassification,
  latestArtefact,
  listArtefacts,
  readItem,
  storeArtefact,
} from '../src/index.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  OUTPUTS,
  classificationOf,
  planningRig,
  reply,
  sharedProvider,
  startPlanningGateway,
} from './planning.js';
import { GATING_ON, loadReports, runItem } from './work-fixtures.js';

// Gap A (S1 with real agents): 1.3 classify, propose lane and 1.5 clarify questions plus the intent block.
// The classifier says what the work is and the FACTORY derives the lane from the catalogue; B1 allows two
// rounds of questions and PARKs the third; the intent block is level-2 context only once a person approved it
// at G0 or G1. The provider is scripted; no real model call.

let s: CoreStack;
let gw: TestGateway;
const provider = sharedProvider();
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startPlanningGateway(s);
});
afterAll(async () => {
  await gw.stop();
  await s.stop();
});
beforeEach(() => provider.reset());

const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const g0Pending = (st: { gates: Array<{ gate: string; status: string }> }) =>
  st.gates.some((g) => g.gate === 'G0' && g.status === 'pending');
const atS2 = (st: { underlying: string }) => st.underlying === 'S2';
const asked = (step: string) => provider.seen.filter((c) => c.step === step);
const userText = (c: { req: { messages: Array<{ content: unknown }> } }): string => {
  const first = c.req.messages[0]?.content;
  return typeof first === 'string' ? first : JSON.stringify(first);
};
const GOAL = 'Let admins export the audit log.';

describe("the lane is the factory's: derived from the classification by the catalogue", () => {
  const cat = catalogueFor(currentCatalogueRef());
  const profile = GATING_ON as unknown as PrrGatingProfile;

  it('labelled work goes to the lane the catalogue labels so; ordinary change by size and risk over the planning depth', () => {
    const lane = (work_type: string, size = 'standard', risk = 'standard') =>
      cat.ok
        ? laneForClassification(cat.value, profile, 'T1', { work_type, size, risk } as never)
        : null;
    expect(cat.ok).toBe(true);
    expect(lane('hotfix')).toBe('L0');
    expect(lane('remediation')).toBe('L2');
    expect(lane('initiative')).toBe('L6');
    expect(lane('spike')).toBe('L7');
    // L1 is the hotfix's follow-up lane and L8 is human-led: a classification never lands there
    expect(lane('change', 'small', 'standard')).toBe('L3');
    expect(lane('change', 'small', 'elevated')).toBe('L4');
    expect(lane('change', 'standard', 'standard')).toBe('L4');
    expect(lane('change', 'standard', 'elevated')).toBe('L5');
    for (const wt of ['change', 'hotfix', 'remediation', 'initiative', 'spike']) {
      for (const size of ['small', 'standard']) {
        for (const risk of ['standard', 'elevated']) {
          expect(lane(wt, size, risk), `${wt} ${size} ${risk}`).not.toBe('L8');
          if (wt === 'change') expect(lane(wt, size, risk)).not.toBe('L1');
        }
      }
    }
  });
});

describe('1.3: the classifier says what the work is, and the factory proposes the lane', () => {
  it('a request that came in as L4 and is an initiative is proposed as L6; G0 binds what the classifier said and the intent block', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('1.3', reply({ ...classificationOf('L6') }));
    const held = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G0' || g === 'G1' ? 'hold' : 'approve'),
      stop: g0Pending,
      passes: 60,
    });
    expect(held?.state.proposed_lane).toBe('L6');
    expect(held?.state.lane).toBeNull(); // nothing is bound until G0 (FIX 7)
    const types = (await listArtefacts(s.record.pool, rig.itemId)).map((a) => a.type).sort();
    expect(types).toEqual(['classification', 'intent_block']);
    const [g0] = await rows(
      `SELECT body FROM record.record_event WHERE type = 'gate.opened' AND body ->> 'subject_id' = $1 AND body ->> 'gate_id' = 'G0'`,
      [rig.itemId],
    );
    const refs = g0?.body.facts.artefacts as Array<{ type: string; step: string }>;
    expect(refs.map((r) => r.type)).toEqual(['classification', 'intent_block']);
    expect(g0?.body.facts.proposed_lane).toBe('L6');
    // 1.3 saw the request as data and was given no lane to change
    expect(asked('1.3')).toHaveLength(1);
    expect(userText(asked('1.3')[0] as never)).not.toContain('proposed_lane');
  });

  it("an output that names a lane is refused field by field and asked again (B3), with no hash of it kept but the answer's", async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '1.3',
      reply({ ...classificationOf('L4'), lane: 'L0' }),
      reply({ ...classificationOf('L4'), candidate: 'L0' }),
    );
    const item = await runItem(s, rig.d, rig.itemId, { stop: g0Pending, passes: 60 });
    expect(item?.state.proposed_lane).toBe('L4');
    expect(asked('1.3')).toHaveLength(3);
    const p = await rows(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
      [planningStream(rig.itemId), PLANNING_EVENT.proposal_recorded],
    );
    const forStep = p.filter((x) => x.body.step === '1.3');
    expect(forStep.map((x) => x.body.status)).toEqual(['rejected', 'rejected', 'accepted']);
    expect(forStep[0]?.body.reasons.map((r: { path: string }) => r.path)).toContain('lane');
    expect(forStep[1]?.body.reasons.map((r: { path: string }) => r.path)).toContain('candidate');
  });

  it('a downshift a person approved at E1 stands: 1.3 runs again, says "a standard change" again, and the lane stays the one E1 chose', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('2.3', reply({ ...(OUTPUTS['2.3'] as object), sizing: 'smaller' }));
    const item = await runItem(s, rig.d, rig.itemId, { passes: 200 });
    expect(item?.state.relanes).toMatchObject([{ edge: 'R2', from_lane: 'L4', to_lane: 'L3' }]);
    expect(item?.state.lane).toBe('L3');
    // two classifications: before E1 and after it. Both said L4 (standard change); the second was not obeyed
    expect(asked('1.3')).toHaveLength(2);
  });
});

describe('1.5: questions (B1: two rounds, then PARK) and the intent block', () => {
  const ask = (text: string) =>
    reply({ kind: 'questions', questions: [{ text, material: 'blocking' }] });
  const answerAll = async (itemId: string, by = 'alice') => {
    const item = await readItem(s.record.pool, itemId);
    for (const q of item?.state.questions.filter((x) => x.state === 'open') ?? []) {
      const r = await answerQuestion({ pool: s.record.pool, clock: s.clock }, itemId, {
        question_id: q.question_id,
        text: `answer to ${q.text}`,
        by: pr(by),
      });
      if (!r.ok) throw new Error(r.error.message);
    }
  };

  it('two rounds of questions are asked and answered (the answers are given as data), then the intent block is written', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('1.5', ask('Which clients call the export?'), ask('Which format do they need?'));
    let item = await runItem(s, rig.d, rig.itemId, { passes: 40 });
    expect(item?.state.waiting?.kind).toBe('questions');
    expect(item?.state.underlying).toBe('Clarifying');
    expect(item?.state.rounds).toBe(1);
    await answerAll(rig.itemId);
    item = await runItem(s, rig.d, rig.itemId, { passes: 40 });
    expect(item?.state.rounds).toBe(2);
    expect(item?.state.waiting?.kind).toBe('questions');
    await answerAll(rig.itemId);
    item = await runItem(s, rig.d, rig.itemId, { stop: g0Pending, passes: 40 });
    expect(item?.state.rounds).toBe(2);
    expect(asked('1.5')).toHaveLength(3);
    // the second round's input carries the first answer, as data, and the third both
    expect(userText(asked('1.5')[1] as never)).toContain(
      'answer to Which clients call the export?',
    );
    expect(userText(asked('1.5')[2] as never)).toContain('answer to Which format do they need?');
    expect(
      (await latestArtefact(s.record.pool, rig.itemId, 'intent_block'))?.content,
    ).toMatchObject({
      kind: 'intent_block',
    });
    // a question proposal is accepted without an artefact
    const q = (
      await rows(
        `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 AND body ->> 'step' = '1.5' ORDER BY seq`,
        [planningStream(rig.itemId), PLANNING_EVENT.proposal_recorded],
      )
    ).map((x) => x.body);
    expect(q.map((x) => [x.status, x.artefact_sha256 === null])).toEqual([
      ['accepted', true],
      ['accepted', true],
      ['accepted', false],
    ]);
  });

  it("a third round is over B1's limit of two: the item is PARKED, and its answers bring it back to 1.5", async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('1.5', ask('one?'), ask('two?'), ask('three?'));
    await runItem(s, rig.d, rig.itemId, { passes: 40 });
    await answerAll(rig.itemId);
    await runItem(s, rig.d, rig.itemId, { passes: 40 });
    await answerAll(rig.itemId);
    let item = await runItem(s, rig.d, rig.itemId, { passes: 40 });
    expect(item?.state.rounds).toBe(3);
    expect(item?.state.waiting).toMatchObject({ kind: 'parked', cause: 'b1_round_limit' });
    expect(item?.state.underlying).toBe('Parked');
    expect(item?.state.questions).toHaveLength(3);
    await answerAll(rig.itemId);
    item = await runItem(s, rig.d, rig.itemId, { stop: g0Pending, passes: 40 });
    expect(item?.state.underlying).not.toBe('Parked');
    expect(asked('1.5')).toHaveLength(4);
  });

  it('a question that does not block is proceeded on (an assumption), with no clarifying wait', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '1.5',
      reply({
        kind: 'questions',
        questions: [{ text: 'Any date format preference?', material: 'non_blocking' }],
      }),
    );
    const item = await runItem(s, rig.d, rig.itemId, { stop: g0Pending, passes: 40 });
    expect(item?.state.questions).toHaveLength(1);
    expect(item?.state.assumptions.some((a) => a.origin === 'open_question')).toBe(true);
    expect(item?.state.waiting?.kind).toBe('gates');
  });
});

describe('the intent block is level-2 context only after a person approved THAT block at G0 or G1', () => {
  it("1.5 and 2.1 see it at level 2 only once G0 and G1 are approved; a block written afterwards is the agent's own words again", async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const item = await runItem(s, rig.d, rig.itemId, {
      stop: (st) => atS2(st) && false,
      passes: 60,
    });
    // the run went through S2: 1.5's own input never held its own output at level 2, 2.1's did
    expect(userText(asked('1.5')[0] as never)).not.toContain(GOAL);
    const first21 = userText(asked('2.1')[0] as never);
    expect(first21.indexOf(GOAL)).toBeGreaterThan(-1);
    expect(first21.indexOf(GOAL)).toBeLessThan(first21.indexOf('== DATA'));
    expect(await acceptedIntentOf(s.record.pool, rig.itemId, item!.state)).not.toBeNull();
    // a redraft after the approval is a different hash: no approved gate bound it
    const stored = await storeArtefact(
      { pool: s.record.pool, clock: s.clock },
      {
        item_id: rig.itemId,
        project_id: rig.project,
        type: 'intent_block',
        step: '1.5',
        command_key: 'redraft-1',
        run_id: null,
        content: {
          ...((await latestArtefact(s.record.pool, rig.itemId, 'intent_block'))!.content as object),
          goal: 'Something else entirely.',
        },
      },
    );
    expect(stored.ok).toBe(true);
    const again = await readItem(s.record.pool, rig.itemId);
    expect(await acceptedIntentOf(s.record.pool, rig.itemId, again!.state)).toBeNull();
  });

  it('with no approved G0 or G1 there is no level-2 intent at all (fail closed)', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: () => 'hold',
      stop: g0Pending,
      passes: 40,
    });
    expect(await acceptedIntentOf(s.record.pool, rig.itemId, item!.state)).toBeNull();
    expect(asked('2.1')).toHaveLength(0);
  });
});
