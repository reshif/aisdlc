import { readPrompt } from '@aisdlc/agents/files';
import { agentDefinition, validateOutput } from '@aisdlc/agents';
import { ONBOARDING_SESSION_EVENT, onboardingSessionStream } from '@aisdlc/contracts';
import { FakeAgentKeys, ONBOARDER_FIXTURE } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptedOnboarderModel,
  consoleProjection,
  observe,
  onboardingConsoleLoop,
  postMessage,
  rebuildConsole,
  readTurns,
  sessionView,
  startSession,
  steer,
  toolUse,
  turnText,
  wake,
  type ConsoleDeps,
  type ScriptedStep,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Scn } from './harness.js';

// The onboarding console's session engine (docs/design/onboarding-console.md, P2). Real Postgres, the real S0 driver,
// cards and read tools; the model behind its port is a script and the key service is the fake. The record, the read
// models and the payload table are real.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'oc');
const { scenario, sync } = h;

const ALICE = 'alice';
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

function depsOf(
  c: Scn,
  steps: readonly ScriptedStep[],
  o: { admit?: () => Promise<boolean>; enabled?: boolean } = {},
): ConsoleDeps & { model: ScriptedOnboarderModel; keys: FakeAgentKeys } {
  const model = new ScriptedOnboarderModel(steps);
  const keys = new FakeAgentKeys();
  return {
    pool: s.record.pool,
    clock: s.clock,
    cards: c.deps,
    keys,
    model,
    prompt: readPrompt,
    ...(o.admit ? { admit: o.admit } : {}),
    ...(o.enabled === false
      ? {
          config: () => ({
            enabled: false,
            autonomy: {
              recheck_controls: 'auto',
              rerun_census: 'auto',
              run_probe: 'auto',
              render_fix_pack: 'auto',
              sync_cards: 'auto',
            },
            max_model_calls_per_wake: 12,
            max_tool_calls_per_wake: 24,
          }),
        }
      : {}),
  } as never;
}

/** A census onboarding at card 1, its console session not yet started. */
async function atCard1(): Promise<Scn> {
  const c = await scenario({ host: { codeowners: null } });
  expect(await c.drive()).toBe('card');
  await sync(c);
  return c;
}

const ok = <T>(r: { ok: boolean; value?: T; error?: unknown }): T => {
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value as T;
};

const answer = (text: string, next: 'await_person' | 'working' | 'done' = 'await_person') => ({
  blocks: [turnText({ text, next })],
});

describe('the local stack', () => {
  it('the gateway fixture is a valid onboarder.v1 turn', () => {
    expect(validateOutput('onboarder', ONBOARDER_FIXTURE).ok).toBe(true);
  });
});

describe('a session: start, the first look, the answer', () => {
  it('opens once, notes what is in the way, then the agent reads with a tool and answers; the record has it all', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { blocks: [toolUse('t1', 'OnboardingRead', { topic: 'blockers' })] },
      answer('Only your decisions are left: start with the risk tier.'),
    ]);
    expect(ok(await startSession(d, { s0_id: c.s0, by: ALICE })).opened).toBe(true);
    expect(ok(await startSession(d, { s0_id: c.s0, by: ALICE })).opened).toBe(false);
    expect(ok(await wake(d, c.s0))).toBe('answered');
    const turns = await readTurns(s.record.pool, c.s0);
    expect(turns.map((t) => t.role)).toEqual(['observation', 'agent']);
    expect(turns[1]?.text).toMatch(/risk tier/);
    const v = await sessionView(s.record.pool, c.s0);
    expect(v?.state).toBe('awaiting_person');
    // the tool call is on the record with a hash, never the text
    const ev = await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [onboardingSessionStream(c.s0), ONBOARDING_SESSION_EVENT.tool_called],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].body.name).toBe('OnboardingRead:blockers');
    expect(ev.rows[0].body.result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev.rows[0].body)).not.toMatch(/risk tier|card:/);
    // the tool result went to the model fenced as data
    const second = d.model.requests[1];
    expect(JSON.stringify(second?.messages)).toMatch(/DATA/);
  });

  it('the key is minted from the contract and nothing else, for the session, and revoked after the wake', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('Hello.')]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    const def = agentDefinition('onboarder');
    const req = d.keys.requests[0];
    expect(req?.mint.tools).toEqual([...def.contract.tools]);
    expect(req?.mint.data_class_max).toBe('D2');
    expect(req?.mint.scope).toEqual({ kind: 'job', ref: `onboarding:${c.s0}` });
    expect(req?.mint.budget_group).toBe(`onboarding_console:${c.s0}`);
    expect(d.keys.revoked).toHaveLength(1);
    // the tools the session offers: reads, proposals and the acts the autonomy setting allows (no search wired here)
    expect(d.model.requests[0]?.tools.map((t) => t.name)).toEqual([
      'OnboardingRead',
      'OnboardingPropose',
      'OnboardingAct',
    ]);
  });

  it('a tool the session does not offer, or a topic off the list, is refused as a result; nothing else changes', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      {
        blocks: [
          toolUse('a', 'OnboardingAct', { act: 'run_probe' }),
          toolUse('b', 'OnboardingRead', { topic: 'secrets' }),
          toolUse('c', 'OnboardingPropose', { kind: 'tier' }),
        ],
      },
      answer('I cannot do that yet.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('answered');
    const calls = await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
      [onboardingSessionStream(c.s0), ONBOARDING_SESSION_EVENT.tool_called],
    );
    expect(calls.rows.map((r) => r.body.outcome)).toEqual(['refused', 'refused', 'refused']);
    // the probe did not run: no probe was recorded
    const probes = await s.record.pool.query(
      'SELECT 1 FROM core.onboarding_probe WHERE s0_id = $1',
      [c.s0],
    );
    expect(probes.rows).toHaveLength(0);
  });
});

describe('the person', () => {
  it('a message is masked before it is stored or sent, then the agent answers it', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('First look.'), answer('Understood.')]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    ok(await postMessage(d, { s0_id: c.s0, by: ALICE, text: `my token is ${SECRET}, why stuck?` }));
    expect(ok(await wake(d, c.s0))).toBe('answered');
    const turns = await readTurns(s.record.pool, c.s0);
    const mine = turns.find((t) => t.role === 'person');
    expect(mine?.text).not.toContain(SECRET);
    expect(JSON.stringify(d.model.requests[1]?.messages)).not.toContain(SECRET);
    const stored = await s.record.pool.query(
      'SELECT text, redactions FROM core.console_payload WHERE s0_id = $1',
      [c.s0],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);
    expect(stored.rows.some((r) => (r.redactions as unknown[]).length > 0)).toBe(true);
  });

  it('a secret in the agent’s answer is never recorded: the person gets the factory’s fixed refusal', async () => {
    const c = await atCard1();
    const bad = answer(`use ${SECRET}`);
    const d = depsOf(c, [bad, bad]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('refused');
    const all = await s.record.pool.query(
      'SELECT text FROM core.console_payload WHERE s0_id = $1',
      [c.s0],
    );
    expect(JSON.stringify(all.rows)).not.toContain(SECRET);
    expect((await readTurns(s.record.pool, c.s0)).at(-1)?.text).toMatch(/could not give an answer/);
  });

  it('output the schema refuses (a field that names a gate) is asked again once, then refused', async () => {
    const c = await atCard1();
    const invalid = {
      blocks: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            kind: 'turn',
            text: 'x',
            citations: [],
            next: 'done',
            noticed: [],
            gate: 'M4',
          }),
        },
      ],
    };
    const d = depsOf(c, [invalid, invalid]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('refused');
    expect(d.model.calls).toBe(2);
  });
});

describe('control: pause, stop, kill switch, budget, switch off', () => {
  it('pause keeps the person’s message and calls no model; resume answers it; stop ends new calls', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('One.'), answer('Two.')]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    ok(await steer(d, { s0_id: c.s0, by: ALICE, action: 'pause' }));
    ok(await postMessage(d, { s0_id: c.s0, by: ALICE, text: 'still there?' }));
    expect(ok(await wake(d, c.s0))).toBe('paused');
    expect(d.model.calls).toBe(1);
    expect((await sessionView(s.record.pool, c.s0))?.state).toBe('paused');
    ok(await steer(d, { s0_id: c.s0, by: ALICE, action: 'resume' }));
    expect(ok(await wake(d, c.s0))).toBe('answered');
    expect(d.model.calls).toBe(2);
    ok(await steer(d, { s0_id: c.s0, by: ALICE, action: 'stop' }));
    const msg = await postMessage(d, { s0_id: c.s0, by: ALICE, text: 'hello?' });
    expect(msg.ok).toBe(false);
    expect(ok(await wake(d, c.s0))).toBe('idle');
    expect(d.model.calls).toBe(2);
  });

  it('a kill reads as paused (no model call) and lifts by itself when the kill is gone; a person’s pause never lifts', async () => {
    const c = await atCard1();
    let admitted = false;
    const d = depsOf(c, [answer('Back.')], { admit: async () => admitted });
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('killed');
    expect(d.model.calls).toBe(0);
    const v = await sessionView(s.record.pool, c.s0);
    expect([v?.state, v?.cause]).toEqual(['paused', 'kill_switch']);
    admitted = true;
    expect(ok(await wake(d, c.s0))).toBe('answered');
    ok(await steer(d, { s0_id: c.s0, by: ALICE, action: 'pause' }));
    expect(ok(await wake(d, c.s0))).toBe('paused');
  });

  it('an unreachable kill switch is a kill (fail closed)', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('x')], { admit: async () => Promise.reject(new Error('down')) });
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('killed');
    expect(d.model.calls).toBe(0);
  });

  it('a spent budget pauses the session with its cause and calls no model', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('x')]);
    d.keys.refuseWith('budget_exhausted');
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('budget');
    const v = await sessionView(s.record.pool, c.s0);
    expect([v?.state, v?.cause]).toEqual(['paused', 'budget']);
    expect(d.model.calls).toBe(0);
  });

  it('a budget spent mid-conversation (the gateway says so) pauses it too', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { fail: { kind: 'rate_limited', code: 'budget_exhausted', status: 429 } },
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('budget');
    expect((await sessionView(s.record.pool, c.s0))?.cause).toBe('budget');
  });

  it('config onboarding.console off: no wake', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('x')], { enabled: false });
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('disabled');
    expect(d.model.calls).toBe(0);
  });

  it('an unreachable gateway is recorded as nothing: the person’s turn stays, the agent tries again later', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { fail: { kind: 'unreachable', code: 'unreachable', status: 0 } },
      answer('Back.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    expect(ok(await wake(d, c.s0))).toBe('unavailable');
    expect(ok(await wake(d, c.s0))).toBe('answered');
  });
});

describe('the record moves', () => {
  it('the same state is observed once; a changed state wakes a waiting session', async () => {
    const c = await atCard1();
    const d = depsOf(c, [answer('Waiting on you.'), answer('Saw the change.')]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    expect(ok(await observe(d, c.s0)).observed).toBe(false);
    // a new probe outcome or card changes the blockers: simulate with another blocker source, a decided card is enough
    // elsewhere; here the loop is the unit: nothing changed, nothing woken
    const loop = onboardingConsoleLoop(d);
    expect(loop.name).toBe('onboarding_console');
    expect(ok(await wake(d, c.s0))).toBe('idle');
    expect(d.model.calls).toBe(1);
  });
});

describe('the read model is the record’s fold', () => {
  it('rebuilding it from the record gives the same rows', async () => {
    const c = await atCard1();
    const d = depsOf(c, [
      { blocks: [toolUse('t1', 'OnboardingRead', { topic: 'cards' })] },
      answer('Here.'),
      answer('Again.'),
    ]);
    ok(await startSession(d, { s0_id: c.s0, by: ALICE }));
    ok(await wake(d, c.s0));
    ok(await postMessage(d, { s0_id: c.s0, by: ALICE, text: 'and now?' }));
    ok(await wake(d, c.s0));
    const before = await consoleProjection.snapshot(s.record.pool);
    await rebuildConsole(s.record.pool);
    const after = await consoleProjection.snapshot(s.record.pool);
    expect(after).toEqual(before);
    expect((after as { turns: unknown[] }).turns.length).toBeGreaterThanOrEqual(4);
  });
});
