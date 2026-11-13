import { readCardState, type FakeStepUp } from '@aisdlc/decisions';
import { validateOutput } from '@aisdlc/agents';
import { ONBOARDING_FIXTURE } from '@aisdlc/ports';
import type { OnboardingSummaryView } from '@aisdlc/contracts';
import { ONBOARDING_AGENT_EVENT, onboardingAgentStream } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeOnboardingAgent,
  acceptedFixFiles,
  definesTestTarget,
  latestProposal,
  onboardingBlockers,
  onboardingSummary,
  rebuildOnboardingProposals,
  runOnboardingAgent,
  signOff,
  type OnboardingAgentDeps,
} from '../src/index.js';
import { decideGate, pr, setSlots, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Json, type Scn } from './harness.js';

// Portal v2 agent-led onboarding (intent §4; screen-map §2.10): the onboarding agent proposes, a person signs off
// once, and the cards underneath are decided as that person, each a ledger entry. Real Postgres, the real driver,
// cards, decision kernel and ledger; the code host, knowledge and the Push Broker are fakes behind their ports.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'ob2');
const { scenario, sync, ok, events } = h;

interface Broker {
  calls: Array<{ op: string; draft?: unknown; branch?: string }>;
  apply_patch: (r: Json) => Promise<Json>;
}
const broker = (): Broker => {
  const b: Broker = {
    calls: [],
    async apply_patch(r: Json) {
      b.calls.push({ op: 'apply_patch', branch: r.branch });
      return {
        state: 'ok',
        value: { commit_sha: 'd'.repeat(40), pr: { number: 7, draft: true } },
      };
    },
  };
  return b;
};

function agentDeps(c: Scn, b?: Broker): OnboardingAgentDeps & { agent: FakeOnboardingAgent } {
  return {
    cards: c.deps,
    agent: new FakeOnboardingAgent(),
    pack: {
      cards: c.deps,
      push: { pool: s.record.pool, clock: s.clock, ledger: s.deps.ledger as never },
      ...(b ? { broker: b as never } : {}),
    },
  };
}

/** A census onboarding at card 1 with the agent's proposal recorded. */
async function proposed(o: { host?: Json; x?: string } = {}) {
  const c = await scenario({ host: { codeowners: null, ...(o.host ?? {}) } });
  if (o.x) s.elig.setHolders(c.project as never, 'x', [o.x as never]);
  expect(await c.drive()).toBe('card');
  await sync(c);
  const b = broker();
  const d = agentDeps(c, b);
  const r = ok(await runOnboardingAgent(d, c.s0));
  return { c, d, b, r };
}

const summary = async (c: Scn, who: string | null = 'alice') =>
  ok(await onboardingSummary({ cards: c.deps, config: s.config }, c.s0, who)).value;

const body = (v: OnboardingSummaryView) => ({
  on_behalf_of: pr('alice'),
  summary_hash: v.summary_hash,
  c1: {
    owners: [pr('alice')],
    tier: v.census?.tier_floor ?? 'T0',
    t0_attestation: true,
    gaps: (v.census?.gaps ?? []).map((g) => ({ gap_id: g.gap_id, disposition: g.suggested })),
  } as never,
  c4: {
    controls_report_hash: v.controls?.report_hash,
    attestations: {
      bypass_has_no_factory_app: true,
      app_scope_selected: true,
      github_token_readonly: true,
      actions_cannot_approve_prs: true,
      fork_pr_approval_required: true,
      secret_scanning: 'on',
      plan: 'free',
    },
    role_map: v.role_map?.proposed,
    two_person_enabled: false,
    gating_profile: {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: true,
    },
    kill_delegations: [],
  } as never,
});

describe('the onboarding agent proposes', () => {
  it("the local gateway's canned onboarding answer is a valid onboarding.v1 output", () => {
    expect(validateOutput('onboarding', ONBOARDING_FIXTURE).ok).toBe(true);
  });

  it('records a valid proposal first, once per census, and the read model rebuilds equal', async () => {
    const { c, d, r } = await proposed();
    expect(r.value.state).toBe('proposed');
    const row = await latestProposal(s.record.pool, c.s0);
    expect(row).not.toBeNull();
    expect(validateOutput('onboarding', row?.output).ok).toBe(true);
    // the agent was given what the factory read, no more
    expect(d.agent.calls[0]?.census.census_hash).toBe(c.census.census_hash);
    // a second tick changes nothing
    expect(ok(await runOnboardingAgent(d, c.s0)).value.state).toBe('unchanged');
    const ev = await s.record.pool.query(
      'SELECT actor FROM record.record_event WHERE stream = $1 AND type = $2',
      [onboardingAgentStream(c.s0), ONBOARDING_AGENT_EVENT.proposed],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].actor).toBe('agent.onboarding');
    await rebuildOnboardingProposals(c.deps, c.s0);
    expect((await latestProposal(s.record.pool, c.s0))?.output_hash).toBe(row?.output_hash);
  });

  it('the fixes become ONE pack bound to its own X2; a draft PR opens only once X2 is approved, and nothing is merged', async () => {
    // before anyone may approve exceptions (a first onboarding, no role map yet) the pack is recorded, X2 waits
    const early = await proposed();
    expect((early.r.value as { fixes?: string }).fixes).toMatch(/nobody holds the slot/);
    expect((await summary(early.c)).fixes.find((f) => f.fix_kind === 'codeowners')).toMatchObject({
      state: 'awaiting_approval',
      approval: null,
    });
    const { c, d, b, r: run } = await proposed({ x: 'bob' });
    expect((run.value as { fixes?: string }).fixes).toBe('x2_pending');
    const v = await summary(c);
    const files = v.fixes.flatMap((f) => f.paths);
    expect(files).toContain('.github/CODEOWNERS');
    expect(v.fixes.find((f) => f.fix_kind === 'codeowners')?.state).toBe('awaiting_approval');
    expect(b.calls).toHaveLength(0); // nothing is pushed before the approval
    const x2 = v.fixes.find((f) => f.approval)?.approval?.card_id as string;
    const st = await readCardState(s.record.pool, x2);
    expect(st?.gates[0]?.state.open.payload.gate_id).toBe('X2');
    // the x slot approves opening it
    ok(await decideGate(s, st?.gates[0]?.gate_instance_id as string, 'bob', 'approve'));
    ok(await runOnboardingAgent(d, c.s0));
    const after = await summary(c);
    const fix = after.fixes.find((f) => f.fix_kind === 'codeowners');
    expect(fix?.state).toBe('pr_open');
    expect(fix?.pr).toMatchObject({ number: 7, branch: `agent/${c.s0}/onboarding-fixes` });
    // the factory asked for a draft PR and for nothing else: no merge, ever
    expect(b.calls.map((x) => x.op)).toEqual(['apply_patch']);
    expect(Object.keys(b)).not.toContain('merge');
    const merged = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM core.pull_request WHERE item_id = $1 AND state = 'merged'`,
      [c.s0],
    );
    expect(merged.rows[0].n).toBe(0);
  });

  it('drops a fix file outside its kind, and refuses an output that sets anything the schema has no place for', async () => {
    const c = await scenario({ host: { codeowners: null } });
    await c.drive();
    await sync(c);
    const bad = {
      async propose() {
        return {
          ok: true as const,
          value: {
            output: {
              kind: 'onboarding',
              summary: 'x',
              learned: [],
              claims: [],
              fixes: [
                {
                  fix_id: 'evil',
                  fix_kind: 'agents_md',
                  title: 't',
                  why: 'w',
                  files: [{ path: '.github/workflows/x.yml', content: 'on: push\n' }],
                  manual_steps: [],
                },
              ],
              questions: [],
              gap_suggestions: [],
            },
            model: 'm',
            prompt_sha256: 'a'.repeat(64),
          },
        };
      },
    };
    ok(await runOnboardingAgent({ cards: c.deps, agent: bad }, c.s0));
    const row = await latestProposal(s.record.pool, c.s0);
    expect(row?.dropped[0]?.ref).toBe('evil:.github/workflows/x.yml');
    const lane = {
      async propose() {
        return {
          ok: true as const,
          value: {
            output: { kind: 'onboarding', lane: 'L0' },
            model: 'm',
            prompt_sha256: 'a'.repeat(64),
          },
        };
      },
    };
    const refused = await runOnboardingAgent({ cards: c.deps, agent: lane }, c.s0, { force: true });
    expect(refused.ok).toBe(false);
  });
});

describe('why it is stuck (blockers)', () => {
  it('a census onboarding at card 1 is ready: only the cards a person decides are left, and none is hidden', async () => {
    const { c } = await proposed();
    const r = ok(await onboardingBlockers(c.deps, c.s0)).value;
    expect(r.s0_id).toBe(c.s0);
    expect(r.ready).toBe(true);
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(r.blockers.every((b) => b.kind === 'card')).toBe(true);
    expect(r.blockers.map((b) => b.id)).toContain('card:C1');
  });

  it('before the agent has proposed, the agent’s own move is listed and the record is not ready', async () => {
    const c = await scenario({ host: { codeowners: null } });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const r = ok(await onboardingBlockers(c.deps, c.s0)).value;
    expect(r.blockers.find((b) => b.id === 'agent_proposal')?.owner).toBe('agent');
    expect(r.ready).toBe(false);
  });
});

describe('the test_command fix writes a file the detector reads', () => {
  const out = (path: string, content: string) =>
    ({
      fixes: [
        {
          fix_id: 't',
          fix_kind: 'test_command',
          title: 't',
          why: 'w',
          files: [{ path, content }],
          manual_steps: [],
        },
      ],
    }) as never;
  const mk = 'test:\n\tnpm test\n';

  it('a Makefile with a test target is kept; the old .factory/test-command path is dropped', () => {
    expect(acceptedFixFiles(out('Makefile', mk), null, new Set()).files).toHaveLength(1);
    const old = acceptedFixFiles(out('.factory/test-command', 'npm test\n'), null, new Set());
    expect(old.files).toHaveLength(0);
    expect(old.dropped[0]?.why).toMatch(/not a path/);
  });

  it('never replaces a task file the census saw, and fails closed when it could not tell', () => {
    expect(acceptedFixFiles(out('Makefile', mk), null, new Set(['Makefile'])).files).toHaveLength(
      0,
    );
    expect(acceptedFixFiles(out('Makefile', mk), null, null).files).toHaveLength(0);
  });

  it('a file with no test target is dropped', () => {
    const r = acceptedFixFiles(out('Makefile', 'build:\n\ttsc\n'), null, new Set());
    expect(r.dropped[0]?.why).toMatch(/no `test` target/);
    expect(definesTestTarget('justfile', 'test:\n  npm test\n')).toBe(true);
    expect(definesTestTarget('Makefile', 'tests:\n\tx\n')).toBe(false);
  });
});

describe('the one sign-off', () => {
  it('the agent that proposed cannot sign off; neither can a system actor', async () => {
    const { c } = await proposed();
    const v = await summary(c);
    for (const who of ['agent.onboarding', 'system.cards']) {
      const r = await signOff({ cards: c.deps, config: s.config }, c.s0, {
        ...body(v),
        on_behalf_of: who as never,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('forbidden');
    }
    expect(await events(c, 'card.decided')).toHaveLength(0);
  });

  it('a summary that changed since it was read is refused; nothing is decided', async () => {
    const { c } = await proposed();
    const v = await summary(c);
    const r = await signOff({ cards: c.deps, config: s.config }, c.s0, {
      ...body(v),
      summary_hash: 'f'.repeat(64) as never,
    });
    expect(!r.ok && r.error.message).toMatch(/summary_changed/);
    expect((await summary(c)).sign_off.state).toBe('ready');
  });

  it('signs once: cards 1, 4 (and its settings) and 5 decided as the person, each on the ledger; step-up for the scorecard', async () => {
    const { c } = await proposed();
    const v = await summary(c);
    expect(v.sign_off).toMatchObject({ state: 'ready', may_sign: true });
    const deps = { cards: c.deps, config: s.config };
    const first = ok(await signOff(deps, c.s0, body(v)));
    expect(first.value.decided.map((x) => x.card)).toEqual(['C1']);
    // the driver opens the next step in its own time; the page continues with no content (it was recorded)
    let last = first.value;
    for (let i = 0; i < 6 && last.state !== 'needs_step_up' && last.state !== 'done'; i++) {
      await c.drive();
      last = ok(await signOff(deps, c.s0, { on_behalf_of: pr('alice') })).value;
    }
    expect(last.state).toBe('needs_step_up');
    expect(last.step_up?.card).toBe('C5');
    const proof = (s.config.stepUp as FakeStepUp).issue(
      last.step_up?.bound_hash as string,
      'alice',
    );
    const done = ok(
      await signOff(deps, c.s0, {
        on_behalf_of: pr('alice'),
        step_up: { proof, bound_hash: last.step_up?.bound_hash as never },
      }),
    ).value;
    expect(done.decided.map((x) => x.card)).toEqual(['C5']);
    expect(done.decided[0]?.ledger_seqs).toHaveLength(2); // the 0.5 sign-off and M4
    const end = await summary(c);
    expect(end.status).toBe('done');
    expect(end.sign_off.state).toBe('done');
    // every card decision on the ledger is alice's, bound to its payload hash
    const entries = await s.record.pool.query<{ principal: string }>(
      `SELECT actor AS principal FROM ledger.ledger_entry WHERE subject_id = $1 AND entry_type <> 'bootstrap_grant'
        AND actor IS NOT NULL`,
      [c.s0],
    );
    expect(entries.rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(entries.rows.map((r) => r.principal))).toEqual(new Set(['alice']));
    // the sign-off itself is on the record, by the person, with the summary hash they read
    const started = await s.record.pool.query<{ actor: string; body: Json }>(
      'SELECT actor, body FROM record.record_event WHERE stream = $1 AND type = $2',
      [onboardingAgentStream(c.s0), ONBOARDING_AGENT_EVENT.sign_off_started],
    );
    expect(started.rows[0]?.actor).toBe('alice');
    expect(started.rows[0]?.body.summary_hash).toBe(v.summary_hash);
  });

  it('when the next step is another person’s, the sign-off waits for them; they sign the scorecard themselves', async () => {
    const { c } = await proposed();
    const deps = { cards: c.deps, config: s.config };
    const v = await summary(c);
    ok(await signOff(deps, c.s0, body(v)));
    let last = ok(await signOff(deps, c.s0, { on_behalf_of: pr('alice') })).value;
    for (let i = 0; i < 6 && last.state !== 'needs_step_up'; i++) {
      await c.drive();
      last = ok(await signOff(deps, c.s0, { on_behalf_of: pr('alice') })).value;
    }
    expect(last.state).toBe('needs_step_up');
    // the role map now in force names bob as the one who signs: alice's sign-off waits for him
    setSlots(s, c.project, { admin: ['bob'], m4: ['bob'], sec: ['alice'], intent: ['alice'] });
    expect(ok(await signOff(deps, c.s0, { on_behalf_of: pr('alice') })).value.state).toBe(
      'waiting',
    );
    expect((await summary(c, 'alice')).sign_off.state).toBe('waiting');
    // bob reads the summary, signs once, confirms it's him
    const vb = await summary(c, 'bob');
    expect(vb.sign_off.state).toBe('ready');
    const first = ok(await signOff(deps, c.s0, { ...body(vb), on_behalf_of: pr('bob') })).value;
    expect(first.state).toBe('needs_step_up');
    const proof = (s.config.stepUp as FakeStepUp).issue(first.step_up?.bound_hash as string, 'bob');
    const done = ok(
      await signOff(deps, c.s0, {
        on_behalf_of: pr('bob'),
        step_up: { proof, bound_hash: first.step_up?.bound_hash as never },
      }),
    ).value;
    expect(done.decided.map((x) => x.card)).toEqual(['C5']);
    expect((await summary(c, 'bob')).status).toBe('done');
  });

  it('a person who does not hold the slot cannot sign: the kernel refuses card 1', async () => {
    const { c } = await proposed();
    const v = await summary(c, 'bob');
    expect(v.sign_off.may_sign).toBe(false);
    const r = await signOff({ cards: c.deps, config: s.config }, c.s0, {
      ...body(v),
      on_behalf_of: pr('bob'),
    });
    expect(r.ok).toBe(false);
  });
});
