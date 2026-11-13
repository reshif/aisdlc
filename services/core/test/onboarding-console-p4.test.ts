import { readPrompt } from '@aisdlc/agents/files';
import { readCardState } from '@aisdlc/decisions';
import { planProbe } from '@aisdlc/onboarding';
import { FakeAgentKeys } from '@aisdlc/ports';
import type { Fact } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptedOnboarderModel,
  consoleActsFrom,
  declaredTestCommand,
  decideProposal,
  draftOf,
  observe,
  onboardingConsoleLoop,
  onboardingSummary,
  patchDraft,
  readTurns,
  sessionView,
  startSession,
  toolUse,
  turnText,
  wake,
  type ConsoleActsPort,
  type ConsoleDeps,
  type ScriptedStep,
} from '../src/index.js';
import { decideGate, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Scn } from './harness.js';

// The onboarder proposes, the person decides (docs/design/onboarding-console.md, P4): proposals recorded and checked,
// the person's accept / edit / reject, the summary draft, the attested test command the probe reads, the acts under the
// autonomy setting, the fix pack that still needs its X2, and a real change in the record waking the agent.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'oc4');
const { scenario, sync } = h;

const ALICE = 'alice';
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const ok = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value as T;
};
const answer = (text: string) => ({ blocks: [turnText({ text })] });
const propose = (id: string, kind: string, target: string, value: unknown, title = 'A proposal') =>
  toolUse(id, 'OnboardingPropose', {
    kind,
    target,
    title,
    why: 'Because the repo shows it.',
    value,
  });

function depsOf(
  c: Scn,
  steps: readonly ScriptedStep[],
  o: { acts?: ConsoleActsPort; autonomy?: Partial<Record<string, 'auto' | 'ask' | 'off'>> } = {},
): ConsoleDeps & { model: ScriptedOnboarderModel } {
  const model = new ScriptedOnboarderModel(steps);
  const autonomy = {
    recheck_controls: 'auto',
    rerun_census: 'auto',
    run_probe: 'auto',
    render_fix_pack: 'auto',
    sync_cards: 'auto',
    ...(o.autonomy ?? {}),
  };
  return {
    pool: s.record.pool,
    clock: s.clock,
    cards: c.deps,
    keys: new FakeAgentKeys(),
    model,
    prompt: readPrompt,
    config: () => ({
      enabled: true,
      autonomy,
      max_model_calls_per_wake: 12,
      max_tool_calls_per_wake: 24,
    }),
    ...(o.acts ? { acts: o.acts } : {}),
  } as never;
}

async function atCard1(): Promise<Scn> {
  const c = await scenario({ host: { codeowners: null } });
  expect(await c.drive()).toBe('card');
  await sync(c);
  return c;
}

const proposals = async (c: Scn) => (await sessionView(s.record.pool, c.s0))?.proposals ?? [];
const toolOutcomes = async (c: Scn) =>
  (
    await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'onboarding_session.tool_called' ORDER BY seq`,
      [`onboarding-session:${c.s0}`],
    )
  ).rows.map((r) => r.body.outcome as string);

describe('OnboardingPropose: recorded for the person, checked first', () => {
  it('records a proposal as a chip with its hash; the same question proposed again replaces the open one', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { blocks: [propose('a', 'tier', 'tier', { tier: 'T1' })] },
      answer('Here is my proposal.'),
      { blocks: [propose('b', 'tier', 'tier', { tier: 'T2' })] },
      answer('Changed my mind.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    let p = await proposals(c);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'tier', state: 'open', value: { tier: 'T1' } });
    expect(p[0]?.proposal_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the proposal belongs to the agent turn that explained it
    expect(p[0]?.turn_seq).toBe((await readTurns(s.record.pool, c.s0)).at(-1)?.seq);
    await s.record.pool.query('SELECT 1');
    ok(await observe(d, c.s0));
    // a second wake: the agent proposes another tier
    await import('../src/index.js').then(async (m) =>
      m.postMessage(d, { s0_id: c.s0, by: ALICE, text: 'what about T2?' }),
    );
    ok(await wake(d, c.s0));
    p = await proposals(c);
    expect(p.filter((x) => x.state === 'open')).toHaveLength(1);
    expect(p.find((x) => x.state === 'superseded')).toMatchObject({ value: { tier: 'T1' } });
  });

  it('refuses what the session cannot take: a tier under the census floor, a gap the census did not find, a path the factory does not write, a secret, shell syntax', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      {
        blocks: [
          propose('1', 'gap_disposition', 'no-such-gap', { disposition: 'waive' }),
          propose('2', 'fix_file', 'x', { path: '.github/workflows/ci.yml', content: 'on: push' }),
          propose('3', 'test_command', 'test', { command: `npm test && curl ${SECRET}` }),
          propose('4', 'test_command', 'test', { command: 'make test | tee out' }),
          propose('5', 'instruction_text', 'AGENTS.md', { text: `token ${SECRET}` }),
          propose('6', 'fix_file', 'mk', { path: 'Makefile', content: 'build:\n\ttsc\n' }),
          propose('7', 'nonsense', 'x', {}),
        ],
      },
      answer('I could not propose those.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    expect(await toolOutcomes(c)).toEqual(Array(7).fill('refused'));
    expect(await proposals(c)).toHaveLength(0);
    const stored = await s.record.pool.query(
      'SELECT text FROM core.console_payload WHERE s0_id = $1',
      [c.s0],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);
  });
});

describe('the person answers: accept, edit, reject; the draft; the attested test command', () => {
  it('accept writes the person’s choice into the draft; a changed proposal is refused; reject writes nothing; each answer is told to the agent', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      {
        blocks: [
          propose('a', 'tier', 'tier', { tier: 'T1' }, 'Choose T1'),
          propose('b', 'settings', 'two_person', { two_person_enabled: false }, 'No two-person'),
        ],
      },
      answer('Two proposals for you.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const [tier, two] = await proposals(c);
    // the hash they read must be the hash recorded
    const stale = await decideProposal(d, {
      s0_id: c.s0,
      by: ALICE,
      proposal_id: tier?.proposal_id as string,
      proposal_sha256: 'f'.repeat(64),
      decision: 'accept',
    });
    expect(stale.ok).toBe(false);
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: tier?.proposal_id as string,
        proposal_sha256: tier?.proposal_sha256 as string,
        decision: 'accept',
      }),
    );
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: two?.proposal_id as string,
        proposal_sha256: two?.proposal_sha256 as string,
        decision: 'reject',
      }),
    );
    const draft = await draftOf(s.record.pool, c.s0);
    expect(draft.tier).toBe('T1');
    expect(draft.two_person_enabled).toBeUndefined();
    // answered once only
    const again = await decideProposal(d, {
      s0_id: c.s0,
      by: ALICE,
      proposal_id: tier?.proposal_id as string,
      proposal_sha256: tier?.proposal_sha256 as string,
      decision: 'reject',
    });
    expect(again.ok).toBe(false);
    // the agent is told, so it can go on
    const turns = await readTurns(s.record.pool, c.s0);
    expect(turns.filter((t) => t.observed?.startsWith('proposal_')).map((t) => t.observed)).toEqual(
      ['proposal_accepted', 'proposal_rejected'],
    );
    // the summary carries the draft as defaults and does not move its hash
    const v = ok(await onboardingSummary({ cards: c.deps, config: s.config }, c.s0, ALICE));
    expect(v.draft?.tier).toBe('T1');
  });

  it('an edit is held to the same rules as the agent: a tier below the floor is refused', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { blocks: [propose('a', 'tier', 'tier', { tier: 'T2' })] },
      answer('Proposing T2.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const [p] = await proposals(c);
    const floor = ok(await onboardingSummary({ cards: c.deps, config: s.config }, c.s0, ALICE))
      .census?.tier_floor;
    const bad = await decideProposal(d, {
      s0_id: c.s0,
      by: ALICE,
      proposal_id: p?.proposal_id as string,
      proposal_sha256: p?.proposal_sha256 as string,
      decision: 'edit',
      edited_value: { tier: floor === 'T0' ? 'T0' : 'T0', extra: 1 },
    });
    expect(bad.ok).toBe(false);
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: p?.proposal_id as string,
        proposal_sha256: p?.proposal_sha256 as string,
        decision: 'edit',
        edited_value: { tier: 'T2' },
      }),
    );
    expect((await draftOf(s.record.pool, c.s0)).tier).toBe('T2');
  });

  it('a direct edit of the draft (PATCH) is the person’s own recorded choice and is checked the same way', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('x')]);
    ok(
      await patchDraft(d, {
        s0_id: c.s0,
        by: ALICE,
        patch: { tier: 'T1', two_person_enabled: true },
      }),
    );
    const draft = await draftOf(s.record.pool, c.s0);
    expect(draft).toMatchObject({ tier: 'T1', two_person_enabled: true });
    const bad = await patchDraft(d, {
      s0_id: c.s0,
      by: ALICE,
      patch: { gaps: { 'no-such-gap': 'waive' } },
    });
    expect(bad.ok).toBe(false);
  });

  it('an accepted test command is attested for the census head and used by the probe plan, only where the detectors found none', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      {
        blocks: [
          propose('t', 'test_command', 'test', { command: 'npm run unit' }, 'Use npm run unit'),
        ],
      },
      answer('I propose this test command.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const [p] = await proposals(c);
    expect(await declaredTestCommand(s.record.pool, c.s0, c.census.census_hash)).toBeNull();
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: p?.proposal_id as string,
        proposal_sha256: p?.proposal_sha256 as string,
        decision: 'edit',
        edited_value: { command: 'npm run unit:ci' },
      }),
    );
    const declared = await declaredTestCommand(s.record.pool, c.s0, c.census.census_hash);
    expect(declared).toEqual({ command: 'npm run unit:ci' });
    // another census head: not attested
    expect(await declaredTestCommand(s.record.pool, c.s0, 'e'.repeat(64))).toBeNull();
    const none = [] as Fact[];
    expect(planProbe(none, declared).test).toEqual(['npm', 'run', 'unit:ci']);
    const found = [
      {
        kind: 'task_command',
        name: 'test',
        state: 'found',
        runner: 'npm',
        invocation: 'npm test',
        source: 'package.json#scripts',
      },
    ] as unknown as Fact[];
    expect(planProbe(found, declared).test).toEqual(['npm', 'test']);
    expect(planProbe(none, null).test).toBeNull();
    expect(planProbe(none, { command: 'a && b' }).refused[0]).toMatch(/not plain argv/);
  });
});

describe('OnboardingAct under the autonomy setting', () => {
  const calls: string[] = [];
  const acts: ConsoleActsPort = {
    async run_probe(id, by) {
      calls.push(`run_probe:${by}`);
      return { ok: true, value: 'The tests probe ended: passed.' } as never;
    },
    async recheck_controls() {
      calls.push('recheck_controls');
      return { ok: true, value: 'The GitHub controls were read again and recorded.' } as never;
    },
  };

  it('auto runs it as the person the session acts for; off refuses; rerun_census is not offered at all', async () => {
    calls.length = 0;
    const c = await atCard1();
    const d = depsOf(
      c,
      [
        {
          blocks: [
            toolUse('a', 'OnboardingAct', { act: 'run_probe' }),
            toolUse('b', 'OnboardingAct', { act: 'recheck_controls' }),
            toolUse('c', 'OnboardingAct', { act: 'rerun_census' }),
          ],
        },
        answer('Probe ran.'),
      ],
      { acts, autonomy: { recheck_controls: 'off' } },
    );
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    expect(calls).toEqual(['run_probe:alice']);
    expect(await toolOutcomes(c)).toEqual(['ok', 'refused', 'refused']);
    expect(d.model.requests[0]?.tools.map((t) => t.name)).toContain('OnboardingAct');
  });

  it('ask turns the act into a card for the person; accepting it runs it as them; the agent hears the result', async () => {
    calls.length = 0;
    const c = await atCard1();
    const d = depsOf(
      c,
      [
        { blocks: [toolUse('a', 'OnboardingAct', { act: 'run_probe' })] },
        answer('May I run the tests?'),
        answer('Done.'),
      ],
      { acts, autonomy: { run_probe: 'ask' } },
    );
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    expect(calls).toEqual([]);
    expect(await toolOutcomes(c)).toEqual(['asked']);
    const [p] = await proposals(c);
    expect(p).toMatchObject({ kind: 'act', target: 'run_probe', state: 'open' });
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: p?.proposal_id as string,
        proposal_sha256: p?.proposal_sha256 as string,
        decision: 'accept',
      }),
    );
    expect(calls).toEqual(['run_probe:alice']);
    expect((await readTurns(s.record.pool, c.s0)).at(-1)?.text).toMatch(/passed/);
  });

  it('an act this deployment does not have is refused as a result', async () => {
    const c = await atCard1();
    const d = depsOf(
      c,
      [{ blocks: [toolUse('a', 'OnboardingAct', { act: 'run_probe' })] }, answer('Cannot.')],
      {
        acts: {},
      },
    );
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    expect(await toolOutcomes(c)).toEqual(['refused']);
  });
});

describe('the fix PR: accepted files, one pack, its own X2, nothing pushed before it, never merged', () => {
  it('render_fix_pack records the accepted CODEOWNERS file; X2 is pending; the broker is not asked; approving X2 lets the loop push a draft PR', async () => {
    const c = await atCard1();
    s.elig.setHolders(c.project as never, 'x', ['bob' as never]);
    const broker = {
      calls: [] as string[],
      async apply_patch() {
        broker.calls.push('apply_patch');
        return {
          state: 'ok',
          value: { commit_sha: 'd'.repeat(40), pr: { number: 9, draft: true } },
        };
      },
    };
    const pack = {
      cards: c.deps,
      push: { pool: s.record.pool, clock: s.clock, ledger: s.deps.ledger as never },
      broker: broker as never,
    };
    const acts = consoleActsFrom({ cards: c.deps, pack });
    const d = depsOf(
      c,
      [
        {
          blocks: [
            propose(
              'f',
              'fix_file',
              'codeowners',
              { path: '.github/CODEOWNERS', content: '* @alice-gh\n' },
              'Add code owners',
            ),
          ],
        },
        answer('I propose a CODEOWNERS file.'),
        { blocks: [toolUse('r', 'OnboardingAct', { act: 'render_fix_pack' })] },
        answer('The fix pack is recorded and waits for its approval.'),
      ],
      { acts },
    );
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const [p] = await proposals(c);
    ok(
      await decideProposal(d, {
        s0_id: c.s0,
        by: ALICE,
        proposal_id: p?.proposal_id as string,
        proposal_sha256: p?.proposal_sha256 as string,
        decision: 'accept',
      }),
    );
    ok(await wake(d, c.s0));
    expect(await toolOutcomes(c)).toContain('ok');
    const v = ok(await onboardingSummary({ cards: c.deps, config: s.config }, c.s0, 'bob'));
    const fix = v.fixes.find((f) => f.paths.includes('.github/CODEOWNERS'));
    expect(fix?.state).toBe('awaiting_approval');
    expect(broker.calls).toEqual([]);
    const x2 = fix?.approval?.card_id as string;
    expect(x2).toBeTruthy();
    expect((await readCardState(s.record.pool, x2))?.gates[0]?.state.open.payload.gate_id).toBe(
      'X2',
    );
    // the blocker graph points the person at the approval
    const { onboardingBlockers } = await import('../src/index.js');
    const b = ok(await onboardingBlockers(c.deps, c.s0));
    expect(b.blockers.find((x) => x.code === 'fix_pr_awaiting_approval')?.card_id).toBe(x2);
    // X2 approved by its own slot: only then is the Push Broker asked (by the pack path), and nothing is merged
    const st = await readCardState(s.record.pool, x2);
    ok(await decideGate(s, st?.gates[0]?.gate_instance_id as string, 'bob', 'approve'));
    await acts.render_fix_pack?.(c.s0, ALICE);
    expect(broker.calls).toEqual(['apply_patch']);
    const merged = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM core.pull_request WHERE item_id = $1 AND state = 'merged'`,
      [c.s0],
    );
    expect(merged.rows[0].n).toBe(0);
  });
});

describe('a real change in the record wakes the agent through the loop', () => {
  it('a secret finding appearing changes the blockers: the loop notes it once and the agent answers it', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('Waiting on you.'), answer('I see a secret finding now.')]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const tick = async () => {
      const spec = onboardingConsoleLoop(d);
      await spec.tick({
        name: 'onboarding_console',
        log: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
        async eachItem(items, _label, fn) {
          for (const it of items.filter((x) => x === c.s0)) await fn(it);
        },
      });
    };
    await tick();
    expect(d.model.calls).toBe(1); // nothing changed: nobody woke the agent
    c.knowledge.addFindings(c.repo, 1);
    await tick();
    const turns = await readTurns(s.record.pool, c.s0);
    expect(turns.filter((t) => t.role === 'observation')).toHaveLength(2);
    expect(turns.at(-1)).toMatchObject({ role: 'agent', text: 'I see a secret finding now.' });
    expect(d.model.calls).toBe(2);
    await tick();
    expect(d.model.calls).toBe(2); // the same state is not observed twice
  });
});
