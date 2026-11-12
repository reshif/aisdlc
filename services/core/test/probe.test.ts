import { PROBE_EVENT, probeStream, type Fact } from '@aisdlc/contracts';
import { readCardState } from '@aisdlc/decisions';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  latestProbe,
  lightFloorsOf,
  rebuildProbes,
  runOnboardingProbe,
  type RecordedProbe,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Json, type Scn } from './harness.js';
import { PROBE_IMAGE, junit, passing, probeRig, runnerReport } from './probe-fixtures.js';

// The onboarding probe (PLAN M16; OB §3.2 LF3; ADR-0003 §7 K-exec; DEC-17 refined, DEC-18) on real Postgres, with the
// real cards, decision kernel and ledger; the sandbox is a FakeSandbox behind the port (the controller's own checks
// are tested in services/sandbox-controller, the image's in services/sandbox-driver). What is checked here: what
// runs, what is refused before anything runs (and that the refusal is recorded), the grant recorded before the
// session, the result recorded first and folded into a rebuildable read model, and card 2's exit on LF3.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});
const h = makeHarness(() => s, 'pb');
const { sync, actionable, detail, decideAs } = h;

const B = (c: string) => c.repeat(40);
const FACTS: Fact[] = [
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
    kind: 'lockfile',
    detector: 'lockfiles',
    evidence: [{ path: 'package-lock.json', blob: B('b'), line: 1 }],
    manifest: 'package.json',
    ecosystem: 'npm',
    state: 'present',
    lockfile: 'package-lock.json',
    inherited: false,
    frozen_install: 'feasible',
    reason: 'lockfile present',
  },
];

async function atCard2(o: { facts?: Fact[]; findings?: number } = {}): Promise<Scn> {
  const c = await h.scenario({
    level: 'light',
    host: {
      atBaseline: [{ path: 'AGENTS.md', content: '# app\n\n## Commands\n\n- `npm test`\n' }],
    },
    ...(o.findings ? { findings: o.findings } : {}),
  });
  c.knowledge.defaultFacts = o.facts ?? FACTS;
  await h.throughC1(c);
  expect(await c.drive()).toBe('card');
  await sync(c);
  return c;
}

const probeEvents = async (c: Scn) =>
  (
    await s.record.pool.query<{ type: string; body: Json }>(
      'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [probeStream(c.s0)],
    )
  ).rows;

function content(view: Json) {
  return {
    proposal_hash: view.proposal.proposal_hash,
    claims: view.claims.map((x: Json) => ({ claim_id: x.claim_id, verdict: 'affirm' })),
    intent_answers: view.intent_questions.map((q: Json) => ({
      question_id: q.question_id,
      answer: 'a web app',
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

const run = async (rig: ReturnType<typeof probeRig>, c: Scn, retry = false) => {
  const r = await runOnboardingProbe(rig.deps, c.s0, { retry });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('the onboarding probe (K-exec)', () => {
  it('runs the census test command in K-exec with the approved image, the grant recorded before the session, the result recorded and rebuildable', async () => {
    const c = await atCard2();
    const seen: Json[] = [];
    const rig = probeRig(c, {
      script: async (spec) => {
        // the grant is in the record, and readable through the controller's view, before the session starts
        const g = await s.record.pool.query(
          'SELECT probe_id, s0_id::text AS s0_id, status FROM core.probe_grant WHERE probe_id = $1',
          [spec.grant?.grant_id],
        );
        seen.push(g.rows[0]);
        return passing(5)(spec, undefined as never);
      },
    });
    const p = await run(rig, c);
    expect(p.result).toMatchObject({
      outcome: 'passed',
      image: PROBE_IMAGE.image,
      tests: { total: 5, source: 'junit' },
      session: { status: 'exited', peers: ['mirror'] },
      egress: {
        declared: [{ ecosystem: 'npm', manifest: 'package.json', lockfile: 'package-lock.json' }],
        unserved: [],
      },
    });
    const spec = rig.sandbox.runs[0];
    expect(spec).toMatchObject({
      class: 'K-exec',
      image: PROBE_IMAGE.image,
      repo_full_name: c.repo,
      command: ['aisdlc-probe', '0', 'npm', 'test'],
      grant: {
        grant_id: p.result.probe_id,
        item_id: c.s0,
        unit_id: 'onboarding-probe',
        lease_epoch: 1,
      },
    });
    expect(spec?.gateway_key).toBeUndefined();
    expect(seen).toEqual([{ probe_id: p.result.probe_id, s0_id: c.s0, status: 'granted' }]);
    // record-first: granted, then recorded; the grant is no longer active once the result is in
    expect((await probeEvents(c)).map((e) => e.type)).toEqual([
      PROBE_EVENT.granted,
      PROBE_EVENT.recorded,
    ]);
    const after = await s.record.pool.query(
      'SELECT status FROM core.probe_grant WHERE probe_id = $1',
      [p.result.probe_id],
    );
    expect(after.rows[0]).toEqual({ status: 'recorded' });
    // one run: a second call returns the same result and starts nothing
    expect((await run(rig, c)).result_hash).toBe(p.result_hash);
    expect(rig.sandbox.runs).toHaveLength(1);
    // the read model is rebuilt from the events alone
    const before = await latestProbe(s.record.pool, c.s0);
    await s.record.pool.query('DELETE FROM core.onboarding_probe WHERE s0_id = $1', [c.s0]);
    expect(await latestProbe(s.record.pool, c.s0)).toBeNull();
    expect(await rebuildProbes(s.deps, c.s0)).toBe(1);
    expect(await latestProbe(s.record.pool, c.s0)).toEqual(before);
  });

  it('DEC-18: a repo off the owner allow-list runs nothing, and that is recorded; once allowed, a retry runs', async () => {
    const c = await atCard2();
    const rig = probeRig(c, { allow: false });
    const p = await run(rig, c);
    expect(p.result).toMatchObject({ outcome: 'not_allowed', session: null });
    expect(rig.sandbox.runs).toHaveLength(0);
    expect((await probeEvents(c)).map((e) => e.type)).toEqual([PROBE_EVENT.recorded]);
    // not retried at once without asking; retried on request once the list names the repo
    expect((await run(rig, c)).result_hash).toBe(p.result_hash);
    rig.allow = [c.repo];
    expect((await run(rig, c, true)).result.outcome).toBe('passed');
    expect(rig.sandbox.runs).toHaveLength(1);
  });

  it('fails closed before anything runs: no image approved, an open secret finding (B1), no test command, no repo copy', async () => {
    const noImage = await atCard2();
    const r1 = probeRig(noImage, { image: false });
    expect((await run(r1, noImage)).result.outcome).toBe('no_image');
    const b1 = await atCard2({ findings: 1 });
    const r2 = probeRig(b1);
    expect((await run(r2, b1)).result.outcome).toBe('b1_blocked');
    const noTest = await atCard2({
      facts: FACTS.filter((f) => !(f.kind === 'task_command' && f.name === 'test')),
    });
    const r3 = probeRig(noTest);
    expect((await run(r3, noTest)).result.outcome).toBe('no_test_command');
    const noFiles = await atCard2();
    const r4 = probeRig(noFiles, { filesFail: true });
    expect((await run(r4, noFiles)).result.outcome).toBe('unavailable');
    for (const r of [r1, r2, r3, r4]) expect(r.sandbox.runs).toHaveLength(0);
  });

  it('what came out is scanned: a canary voids the run, a secret never enters the record', async () => {
    const c = await atCard2();
    const canary = makeCanary('probe-core');
    const rig = probeRig(c, {
      script: () => ({
        exit_code: 0,
        stdout: canary,
        out: {
          'aisdlc-probe/result.json': runnerReport(null, 0),
          'aisdlc-probe/junit.xml': junit(3),
        },
      }),
    });
    const p = await run(rig, c);
    expect(p.result).toMatchObject({ outcome: 'void', out_scan: { canary: true } });
    const leaky = await atCard2();
    const r2 = probeRig(leaky, {
      script: passing(3, { 'aisdlc-probe/test.log': `token ${makeCanary('probe-log')}\n` }),
    });
    const q = await run(r2, leaky);
    expect(q.result.test.log_tail).toBeNull();
    const text = (await probeEvents(leaky)).map((e) => JSON.stringify(e.body)).join(' ');
    expect(text).not.toContain('probe-log');
    expect(text).not.toMatch(/AISDLC_CANARY/);
  });
});

describe('card 2 exits only on LF3 (no waiver)', () => {
  it('no probe yet: the card shows LF3 unknown and an approval is refused; a failed probe: refused', async () => {
    const c = await atCard2();
    const card = await actionable(c, 'C2');
    const d = await detail(c, card.card_id);
    expect(d.view.probe.lf3).toEqual({ state: 'unknown', reasons: ['probe_not_run'] });
    const refused = await decideAs(c, card.card_id, 'alice', 'approve', content(d.view));
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(refused.ok ? '' : refused.error.message).toMatch(/^LF3:/);

    await run(
      probeRig(c, {
        script: () => ({
          exit_code: 1,
          out: {
            'aisdlc-probe/result.json': runnerReport(null, 1),
            'aisdlc-probe/junit.xml': junit(3, 1),
          },
        }),
      }),
      c,
    );
    const d2 = await detail(c, card.card_id);
    expect(d2.view.probe.lf3).toEqual({ state: 'unmet', reasons: ['probe_failed'] });
    expect(d2.view.probe.result).toMatchObject({ outcome: 'failed' });
    const again = await decideAs(c, card.card_id, 'alice', 'approve', content(d2.view));
    expect(again.ok ? '' : again.error.message).toMatch(/^LF3:/);
  });

  it('a passed probe: the approval binds it by hash; a probe recorded after the card was prepared changes its evidence', async () => {
    const c = await atCard2();
    const card = await actionable(c, 'C2');
    const before = await detail(c, card.card_id);
    const recorded: RecordedProbe = await run(probeRig(c), c);
    const d = await detail(c, card.card_id);
    expect(d.view.probe.lf3).toEqual({ state: 'met', reasons: [] });
    expect(d.view.probe.lf8).toEqual({ state: 'met', reasons: [] });
    expect(d.evidence_hash).not.toBe(before.evidence_hash);
    const r = await decideAs(c, card.card_id, 'alice', 'approve', content(d.view));
    expect(r.ok).toBe(true);
    const rows = (await readCardState(s.record.pool, card.card_id))?.payload?.payload ?? [];
    // LF1 to LF8 after card 2: LF3, LF5, LF6, LF8 met; card 4 not decided yet (LF2, LF7 unknown); LF4 waits for
    // the live isolation test (unknown): Light cannot be signed on the floors yet
    const floors = await lightFloorsOf({ pool: s.record.pool, knowledge: c.knowledge }, c.s0);
    if (!floors.ok) throw new Error(floors.error.message);
    const by = Object.fromEntries(floors.value.floors.map((f) => [f.floor, f.state]));
    expect(by).toMatchObject({
      LF3: 'met',
      LF5: 'met',
      LF6: 'met',
      LF8: 'met',
      LF2: 'unknown',
      LF7: 'unknown',
      LF4: 'unknown',
    });
    expect(floors.value.met).toBe(false);
    expect(rows.find((x) => x.kind === 'light_probe')).toEqual({
      kind: 'light_probe',
      probe_id: recorded.result.probe_id,
      result_hash: recorded.result_hash,
      baseline_sha: recorded.result.baseline_sha,
      outcome: 'passed',
    });
  });
});
