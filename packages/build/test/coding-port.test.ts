import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODING_TASK_FILE, type CodingSessionResult, type StageOutcome } from '@aisdlc/contracts';
import { readPrompt } from '@aisdlc/agents/files';
import { err, ok } from '@aisdlc/kernel';
import { makeCanary } from '@aisdlc/secrets-rules';
import {
  FakeSandbox,
  FakeStagePort,
  GuardedSandbox,
  RunKeyVault,
  sandboxError,
  type FakeSandboxOutcome,
  type SandboxSpec,
} from '@aisdlc/ports';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CodingLimits,
  AgentCodingPort,
  FakeBuildSource,
  ITEM,
  SYNTH_REPO,
  SessionStore,
  StoreWaitSnapshots,
  WORKER_IMAGE_UNVERIFIED,
  type HandoffPackRecord,
  sha256,
  stageRequest,
  synthRepo,
} from '../src/index.js';

// The S6 port against `FakeSandbox` (same preflight, cap and output scan as the real driver; a script in place of the
// container): the outcome of every stop and loop of 6.1 to 6.5 that a real sandbox run would be slow to reach. The real
// sandbox, driver, proxy and agent harness are in services/coding-runner/test/s6.test.ts.

const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;
const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';

interface World {
  store: SessionStore;
  source: FakeBuildSource;
  sandbox: FakeSandbox;
  vault: RunKeyVault;
  /** What `npm test` (all tests) answers, in order; then by the fix. */
  testRuns: Array<{ exit: number; failing?: string[] } | undefined>;
  /** What the next W session does. */
  agent: Array<(spec: SandboxSpec) => AgentRun>;
  now: number;
  port: AgentCodingPort;
  fallback: FakeStagePort<'coding'>;
  allowed: string[];
  open: boolean;
  checkExit: number;
  wSpecs: SandboxSpec[];
  /** The sandbox refuses W for its image (the controller's LF4 check). */
  imageRefused: boolean;
}

interface AgentRun {
  status?: CodingSessionResult['status'];
  final?: string;
  tripwire?: CodingSessionResult['tripwire'];
  changed?: Record<string, string>;
  deleted?: string[];
  key_on_disk?: boolean;
  sandbox?: Partial<FakeSandboxOutcome>;
  blobsWrong?: boolean;
}

const DONE =
  '{"kind":"implementation","status":"completed","summary":"ok","files_changed":[],"checks_run":[]}';
const fix = (): AgentRun => ({ final: DONE, changed: { 'src/calc.js': FIXED } });

let dir: string;
let w: World;

function build(
  o: { limits?: CodingLimits | (() => CodingLimits); modelOf?: () => string } = {},
): World {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-build-'));
  const store = new SessionStore(dir);
  const s = synthRepo();
  const source = new FakeBuildSource(s.files, s.plan, [s.oracle]);
  const world: World = {
    store,
    source,
    sandbox: undefined as never,
    vault: new RunKeyVault(),
    testRuns: [],
    agent: [],
    now: 1_000_000,
    port: undefined as never,
    fallback: new FakeStagePort('coding'),
    allowed: [SYNTH_REPO],
    open: false,
    checkExit: 0,
    wSpecs: [],
    imageRefused: false,
  };
  const calc = (spec: SandboxSpec): string => {
    const f = spec.repo.find((x) => x.path === 'src/calc.js');
    return f ? Buffer.from(f.content).toString() : '';
  };
  world.sandbox = new FakeSandbox((spec) => {
    if (spec.class === 'W') {
      world.wSpecs.push(spec);
      const run = (world.agent.shift() ?? fix)(spec);
      const changed = run.changed ?? {};
      const out: Record<string, string> = {};
      const list = Object.entries(changed).map(([path, content]) => {
        const h = sha256(content);
        out[`blobs/${h}`] = content;
        return {
          path,
          sha256: run.blobsWrong ? 'b'.repeat(64) : h,
          size: content.length,
          exec: false,
        };
      });
      const res: CodingSessionResult = {
        schema: 'coding-session/1',
        status: run.status ?? 'finished',
        tripwire: run.tripwire ?? null,
        final_text: run.final ?? DONE,
        turns: 3,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_events: [],
        ignored_harness: ['CLAUDE.md'],
        setting_sources: [],
        key_on_disk: run.key_on_disk ?? false,
        error: run.status === 'error' ? 'boom' : null,
        changed: list,
        deleted: run.deleted ?? [],
        changes_truncated: false,
      };
      out['session.json'] = JSON.stringify(res);
      return { exit_code: 0, out, ...(run.sandbox ?? {}) };
    }
    const cmd = spec.command.join(' ');
    const fixed = calc(spec).includes('a + b');
    if (cmd === 'npm test -- test/oracle-add.test.js') {
      return fixed ? { exit_code: 0 } : { exit_code: 1, stdout: 'not ok 1 - add adds\n' };
    }
    if (cmd.startsWith('npm test -- ')) return { exit_code: 1, stdout: 'not ok 1 - repro\n' };
    if (cmd === 'npm run check') return { exit_code: world.checkExit };
    if (cmd === 'npm test') {
      const scripted = world.testRuns.shift();
      if (scripted)
        return {
          exit_code: scripted.exit,
          stdout: (scripted.failing ?? []).map((n, i) => `not ok ${i + 1} - ${n}\n`).join(''),
        };
      const hasOracle = spec.repo.some((x) => x.path === 'test/oracle-add.test.js');
      return hasOracle && !fixed
        ? { exit_code: 1, stdout: 'not ok 1 - add adds\n' }
        : { exit_code: 0 };
    }
    return { exit_code: 0 };
  });
  const guard = {
    execAllowedRepos: () => world.allowed,
    hasOpenSecretFinding: async () => ok(world.open),
  };
  const lf4 = {
    run: (spec: SandboxSpec) =>
      world.imageRefused && spec.class === 'W'
        ? Promise.resolve(
            err(sandboxError('image_unverified', 'this host runs another W image than LF4')),
          )
        : world.sandbox.run(spec),
  };
  world.port = new AgentCodingPort({
    sandbox: new GuardedSandbox(lf4, guard),
    store,
    source,
    guard,
    keys: world.vault,
    fallback: world.fallback,
    model: 'claude-sonnet-5-5',
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.modelOf ? { modelOf: o.modelOf } : {}),
    prompt: readPrompt,
    now: () => world.now,
  });
  return world;
}

beforeEach(() => {
  w = build();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = async (
  step: Parameters<typeof stageRequest>[0],
  o: Parameters<typeof stageRequest>[1] = {},
): Promise<StageOutcome> => {
  const req = stageRequest(step, o);
  if (req.agent) w.vault.put(req.agent.run_id, 'fake-vkey-1', KEY);
  const r = await w.port.run(req);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const done = (o: StageOutcome) =>
  expect(o, JSON.stringify(o)).toMatchObject({ outcome: 'completed' });
const upTo63 = async () => {
  done(await run('6.1'));
  done(await run('6.2'));
  done(await run('6.3'));
};
const upTo64 = async () => {
  await upTo63();
  done(await run('6.4'));
};

describe('agents.config: the coder’s turns, times and model are read on every session', () => {
  const taskOf = (spec: SandboxSpec) => {
    const f = spec.repo.find((x) => x.path.endsWith(`/${CODING_TASK_FILE}`));
    return JSON.parse(f ? Buffer.from(f.content).toString() : '{}') as {
      max_turns: number;
      time_s: number;
      model: string;
    };
  };
  it('defaults are 40 turns and 1800 s; a changed value is used by the next session', async () => {
    await upTo64();
    const first = w.wSpecs.at(-1);
    if (!first) throw new Error('no W session');
    expect(taskOf(first)).toMatchObject({
      max_turns: 40,
      time_s: 1800,
      model: 'claude-sonnet-5-5',
    });

    const limits: CodingLimits = { max_turns: 12, run_time_s: 900, test_time_s: 120 };
    w = build({ limits: () => limits, modelOf: () => 'claude-opus-5-5' });
    await upTo64();
    const second = w.wSpecs.at(-1);
    if (!second) throw new Error('no W session');
    expect(taskOf(second)).toMatchObject({ max_turns: 12, time_s: 900, model: 'claude-opus-5-5' });
    const o = (w.sandbox as FakeSandbox).runs.filter((r) => r.class === 'O').at(-1);
    expect(o?.limits?.time_s).toBe(120);
  });
});

describe('the port is idempotent and only ours are steps 6.1 to 6.5', () => {
  it('asked twice with a command key it does the work once and answers the same', async () => {
    const a = await run('6.1');
    const runs = (w.sandbox as FakeSandbox).runs.length;
    const b = await run('6.1');
    expect(b).toEqual(a);
    expect((w.sandbox as FakeSandbox).runs.length).toBe(runs);
    done(await run('6.2'));
    const n = (w.sandbox as FakeSandbox).runs.length;
    expect(await run('6.2')).toEqual(await run('6.2'));
    expect((w.sandbox as FakeSandbox).runs.length).toBe(n);
  });
  it('6.0 and 6.6 go to the fallback port', async () => {
    done(await run('6.6'));
    expect(w.fallback.calls.map((c) => c.step)).toEqual(['6.6']);
  });
  it('an unreachable source is an error (delivered again), not an outcome, and nothing is remembered', async () => {
    w.source.breakIt();
    const r = await w.port.run(stageRequest('6.1'));
    expect(r.ok).toBe(false);
    w.source.breakIt(false);
    done(await run('6.1'));
  });
  it('6.2 without 6.1 is an error: there is no workspace', async () => {
    expect((await w.port.run(stageRequest('6.2'))).ok).toBe(false);
  });
});

describe('6.1: rehydrate and cold rebuild', () => {
  it('rehydrates the same session (workspace kept) and rebuilds cold only a tainted one', async () => {
    await upTo64();
    const tree = w.store.load(ITEM)?.tree_sha256;
    done(await run('6.1', { key: 'again/6.1' }));
    expect(w.store.load(ITEM)).toMatchObject({ generation: 1, tree_sha256: tree, stage: 'built' });
    const s = w.store.load(ITEM);
    if (s) {
      s.tainted = true;
      w.store.save(s);
    }
    done(await run('6.1', { key: 'cold/6.1' }));
    expect(w.store.load(ITEM)).toMatchObject({
      generation: 2,
      tainted: false,
      stage: 'provisioned',
    });
    expect(w.store.load(ITEM)?.tree_sha256).toBe(w.store.load(ITEM)?.base_tree_sha256);
  });
});

describe('6.4 outcomes', () => {
  beforeEach(async () => {
    await upTo63();
  });
  it('X3, X1 and E6 from the agent own words (blocked with a reason); ET8 for the rest; a pending gate is recorded', async () => {
    const blocked = (reason: string) => ({
      final: `{"kind":"implementation","status":"blocked","summary":"stuck","files_changed":[],"checks_run":[],"blocker":{"reason":"${reason}","detail":"d"}}`,
    });
    const table: Array<[string, StageOutcome]> = [
      ['new_dependency', { outcome: 'gate_needed', gate: 'X3', reason_code: 'agent_blocked' }],
      [
        'irreversible_operation',
        {
          outcome: 'gate_needed',
          gate: 'X1',
          reason_code: 'agent_blocked',
          // P1-8: what X1 decides goes to the record with it (the agent's note, masked: data)
          detail: {
            kind: 'irreversible_operation',
            source: 'agent_blocker',
            what: 'the agent says the task needs an irreversible operation',
            command: null,
            target: null,
            agent_note: 'd',
          },
        },
      ],
      [
        'locked_test_change',
        { outcome: 'gate_needed', gate: 'E6', reason_code: 'locked_test_change' },
      ],
    ];
    for (const [reason, want] of table) {
      w.agent.push(() => blocked(reason));
      expect(await run('6.4', { key: `b/${reason}` })).toEqual(want);
      expect(w.store.load(ITEM)?.pending_gate).toBe(
        want.outcome === 'gate_needed' ? want.gate : null,
      );
    }
    // P1-8: the runner stopped a command (X1): the factory's words, the command with its secrets masked
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    w.agent.push(() => ({
      status: 'tripwire',
      tripwire: {
        kind: 'irreversible_operation',
        class: 'gate_x1',
        detail: 'a force push',
        command: `git push --force https://x:${token}@github.com/acme/a main`,
      },
    }));
    const x1 = await run('6.4', { key: 'b/x1-tripwire' });
    expect(x1).toMatchObject({
      outcome: 'gate_needed',
      gate: 'X1',
      reason_code: 'irreversible_operation',
      detail: { kind: 'irreversible_operation', source: 'tripwire', what: 'a force push' },
    });
    const cmd = (x1 as { detail: { command: string } }).detail.command;
    expect(cmd).toContain('git push --force');
    expect(cmd).not.toContain(token);
    w.agent.push(() => blocked('other'));
    expect(await run('6.4', { key: 'b/other' })).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET8',
      reason_code: 'agent_blocked',
    });
  });
  it('gave_up is ET8 with a Handoff Pack that validates against A11 and names the diffs by hash', async () => {
    w.agent.push(() => ({
      changed: { 'src/other.js': 'x\n' },
      final:
        '{"kind":"implementation","status":"gave_up","summary":"no","files_changed":[],"checks_run":[]}',
    }));
    const o = await run('6.4');
    expect(o).toMatchObject({ outcome: 'trigger', trigger: 'ET8' });
    const pack = w.store.getRecord<HandoffPackRecord>(
      'handoff-pack',
      (o as { output_hash: string }).output_hash,
    );
    expect(pack?.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/other.js',
          change: 'added',
          after_sha256: sha256('x\n'),
        }),
      ]),
    );
    expect(pack?.pack).toMatchObject({ kind: 'handoff_pack' });
    expect(pack?.snapshot_ref ?? w.store.load(ITEM)?.snapshot_ref).toMatch(/^snap:/);
  });
  it('ET1 (the gateway refused for spend), ET2 (the runner or the container ran out of time)', async () => {
    w.agent.push(() => ({ status: 'budget' }));
    expect(await run('6.4', { key: 'e1' })).toMatchObject({
      trigger: 'ET1',
      reason_code: 'budget_exhausted',
    });
    w.agent.push(() => ({ status: 'timeout' }));
    expect(await run('6.4', { key: 'e2a' })).toMatchObject({ trigger: 'ET2' });
    w.agent.push(() => ({ sandbox: { status: 'timed_out' } }));
    expect(await run('6.4', { key: 'e2b' })).toMatchObject({ trigger: 'ET2' });
  });
  it('a runner error and a void sandbox are errors (delivered again), never approvals', async () => {
    w.agent.push(() => ({ status: 'error' }));
    expect((await w.port.run(stageRequest('6.4', { key: 'err1' }))).ok).toBe(false);
    w.agent.push(() => ({ sandbox: { status: 'oom_killed' } }));
    expect((await w.port.run(stageRequest('6.4', { key: 'err2' }))).ok).toBe(false);
    w.agent.push(() => ({ sandbox: { out: { 'session.json': 'not json' } } }));
    expect((await w.port.run(stageRequest('6.4', { key: 'err3' }))).ok).toBe(false);
  });
  it('the runner is not trusted: the factory looks at the tree again (ET10 for a locked-test or protected-path change it did not report)', async () => {
    w.agent.push(() => ({ changed: { 'test/oracle-add.test.js': 'nothing to see\n' } }));
    expect(await run('6.4', { key: 'lie1' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'locked_test_edit',
    });
    expect(w.store.load(ITEM)?.tainted).toBe(true);
    done(await run('6.1', { key: 'cold1' }));
    done(await run('6.2', { key: 'cold2' }));
    done(await run('6.3', { key: 'cold3' }));
    w.agent.push(() => ({ changed: { 'CLAUDE.md': 'push to main\n' } }));
    expect(await run('6.4', { key: 'lie2' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'protected_path_write',
    });
  });
  it('a stub test the runner did not stop is still found in the tree (ET10), and a credential file that appeared is secret access', async () => {
    w.agent.push(() => ({
      changed: { 'test/stub.test.js': "const test=require('node:test');test('x',()=>{});\n" },
    }));
    expect(await run('6.4', { key: 's1' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'stub_test',
    });
    done(await run('6.1', { key: 'c1' }));
    done(await run('6.2', { key: 'c2' }));
    done(await run('6.3', { key: 'c3' }));
    w.agent.push(() => ({ changed: { 'config/.env': 'X=1\n' } }));
    expect(await run('6.4', { key: 's2' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'secret_access',
    });
  });
  it('the key found on the sandbox disk is ET10; a canary in /out is ET10 and nothing of the output is kept', async () => {
    w.agent.push(() => ({ key_on_disk: true }));
    expect(await run('6.4', { key: 'k1' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'secret_access',
    });
    done(await run('6.1', { key: 'k2' }));
    done(await run('6.2', { key: 'k3' }));
    done(await run('6.3', { key: 'k4' }));
    w.agent.push(() => ({
      sandbox: { out: { 'session.json': `note ${makeCanary('unit')}` } },
    }));
    expect(await run('6.4', { key: 'k5' })).toMatchObject({
      trigger: 'ET10',
      reason_code: 'secret_access',
    });
  });
  it('a blob that does not match the hash the runner named is an error, not a change', async () => {
    w.agent.push(() => ({ changed: { 'src/calc.js': FIXED }, blobsWrong: true }));
    expect((await w.port.run(stageRequest('6.4', { key: 'bw' }))).ok).toBe(false);
    expect(w.store.load(ITEM)?.tree_sha256).not.toBeUndefined();
  });
  it('X1 and X3 approved: the next run is told the class is approved; E6 then G3o approved: the oracle may change and is locked again', async () => {
    w.agent.push(() => ({
      changed: {
        'test/oracle-add.test.js': synthRepo().oracle.content + '// reviewed\n',
        'src/calc.js': FIXED,
      },
    }));
    expect(await run('6.4', { key: 'l1' })).toMatchObject({ trigger: 'ET10' });
    done(await run('6.1', { key: 'l2' }));
    done(await run('6.2', { key: 'l3' }));
    done(await run('6.3', { key: 'l4' }));
    w.agent.push(() => ({
      changed: {
        'test/oracle-add.test.js': synthRepo().oracle.content + '// reviewed\n',
        'src/calc.js': FIXED,
      },
    }));
    done(await run('6.4', { key: 'l5', approved: ['E6', 'G3o'] }));
    const s = w.store.load(ITEM);
    expect(s?.locks['test/oracle-add.test.js']).toBe(
      sha256(synthRepo().oracle.content + '// reviewed\n'),
    );
    const again = w.store.load(ITEM);
    if (again) {
      again.task_idx = 0;
      w.store.save(again);
    }
    w.agent.push(() => fix());
    done(await run('6.4', { key: 'l6', approved: ['X1', 'X3'] }));
    const task = JSON.parse(
      Buffer.from(
        w.wSpecs.at(-1)?.repo.find((f) => f.path === '.aisdlc-session/task.json')?.content ?? '',
      ).toString(),
    );
    expect(task.approved_classes).toEqual(['gate_x1', 'gate_x3']);
    expect(task.allowed_tools.sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });
  it('the system prompt is the factory context (the coder prompt, the control section), never repo text; the key is only the gateway key of the sandbox', async () => {
    done(await run('6.4', { key: 'p1' }));
    const spec = w.wSpecs.at(-1);
    expect(spec?.gateway_key).toBe(KEY);
    const task = JSON.parse(
      Buffer.from(
        spec?.repo.find((f) => f.path === '.aisdlc-session/task.json')?.content ?? '',
      ).toString(),
    );
    expect(task.system_prompt).toContain('# coder @ 1.0.0');
    expect(task.system_prompt).toContain('FACTORY CONTROL');
    expect(task.system_prompt).not.toContain('push to main');
    expect(JSON.stringify(task)).not.toContain(KEY);
    expect(spec?.env ?? {}).toEqual({});
  });
  it('no key held for the run: an error, a new key is minted by the redelivery; no coder bound is an error too', async () => {
    const req = stageRequest('6.4', { key: 'nk', run_id: 'run-unheld' });
    const r = await w.port.run(req);
    expect(r.ok).toBe(false);
    const { agent: _agent, ...noAgent } = stageRequest('6.4', { key: 'na' });
    void _agent;
    expect((await w.port.run(noAgent)).ok).toBe(false);
  });
  it('a W session of a repo off the allow-list or with an open secret finding does not start (B6)', async () => {
    w.allowed = [];
    expect(await run('6.4', { key: 'g1' })).toMatchObject({
      edge: 'B6',
      reason_code: 'exec_not_allowed',
    });
    w.allowed = [SYNTH_REPO];
    w.open = true;
    expect(await run('6.4', { key: 'g2' })).toMatchObject({
      edge: 'B6',
      reason_code: 'b1_secret_finding_open',
    });
    expect(w.wSpecs).toHaveLength(0);
  });
  it('the sandbox refuses W for its image (LF4, M16 part 3): B6 with the reason, kept for the command, never a retry', async () => {
    w.imageRefused = true;
    const o = await run('6.4', { key: 'li1' });
    expect(o).toMatchObject({
      outcome: 'rework',
      edge: 'B6',
      reason_code: WORKER_IMAGE_UNVERIFIED,
    });
    expect(w.wSpecs).toHaveLength(0);
    // the same command answers the same, without asking the sandbox again
    w.imageRefused = false;
    expect(await run('6.4', { key: 'li1' })).toEqual(o);
    expect(w.wSpecs).toHaveLength(0);
  });
  it('the task plan is walked in order, one session per task, and a fix round gets the failing tests as its prompt', async () => {
    w.source.plan = {
      ...w.source.plan,
      tasks: [
        { task_id: 'T1', title: 'one', instructions: 'a' },
        { task_id: 'T2', title: 'two', instructions: 'b' },
      ],
    };
    done(await run('6.4', { key: 't1' }));
    expect(w.wSpecs).toHaveLength(2);
    const prompts = w.wSpecs.map(
      (s) =>
        JSON.parse(
          Buffer.from(
            s.repo.find((f) => f.path === '.aisdlc-session/task.json')?.content ?? '',
          ).toString(),
        ).prompt as string,
    );
    expect(prompts[0]).toContain('Task T1');
    expect(prompts[1]).toContain('Task T2');
    w.testRuns.push({ exit: 1, failing: ['x'] }, { exit: 1, failing: ['x'] });
    await run('6.5', { key: 't2' });
    done(await run('6.4', { attempt: 2, key: 't3' }));
    const last = JSON.parse(
      Buffer.from(
        w.wSpecs.at(-1)?.repo.find((f) => f.path === '.aisdlc-session/task.json')?.content ?? '',
      ).toString(),
    ).prompt as string;
    expect(last).toContain('Fix what the self-check found');
    expect(last).toContain('The self-check failed: x');
    expect(w.wSpecs).toHaveLength(3);
  });
});

describe('6.5: tripwires and the self-check', () => {
  beforeEach(async () => {
    await upTo64();
  });
  it('green: ready for push', async () => {
    done(await run('6.5'));
    expect(w.store.load(ITEM)?.stage).toBe('checked');
  });
  it('a failing round is B7 counted against ET2 CI rounds, then the same failure again against ET3; the engine owns the limits', async () => {
    w.testRuns.push({ exit: 1, failing: ['a'] }, { exit: 1, failing: ['a'] });
    expect(await run('6.5', { key: 'r1' })).toMatchObject({
      outcome: 'rework',
      edge: 'B7',
      loop: 'et2_ci_rounds',
    });
    w.testRuns.push({ exit: 1, failing: ['a'] }, { exit: 1, failing: ['a'] });
    expect(await run('6.5', { key: 'r2', attempt: 2 })).toMatchObject({
      edge: 'B7',
      loop: 'et3_rounds',
    });
    w.testRuns.push({ exit: 1, failing: ['b'] }, { exit: 1, failing: ['b'] });
    expect(await run('6.5', { key: 'r3', attempt: 3 })).toMatchObject({
      edge: 'B7',
      loop: 'et2_ci_rounds',
    });
  });
  it('ET11 oscillation: A, B, A', async () => {
    for (const set of [['a'], ['b']]) {
      w.testRuns.push({ exit: 1, failing: set }, { exit: 1, failing: set });
      expect(await run('6.5', { key: `o/${set[0]}` })).toMatchObject({ edge: 'B7' });
    }
    w.testRuns.push({ exit: 1, failing: ['a'] }, { exit: 1, failing: ['a'] });
    expect(await run('6.5', { key: 'o/a2' })).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET11',
    });
  });
  it('ET12 instability: the same tree answers differently', async () => {
    w.testRuns.push({ exit: 1, failing: ['flaky'] }, { exit: 0 });
    expect(await run('6.5', { key: 'f1' })).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET12',
      reason_code: 'unstable_tests',
    });
    w.testRuns.push({ exit: 1, failing: ['x'] }, { exit: 1, failing: ['y'] });
    expect(await run('6.5', { key: 'f2' })).toMatchObject({ trigger: 'ET12' });
  });
  it('ET2 time: a failing round after more than twice the estimate counts the time multiple', async () => {
    w.now += 8_000_000;
    w.testRuns.push({ exit: 1, failing: ['a'] }, { exit: 1, failing: ['a'] });
    const o = await run('6.5', { key: 'tm' });
    expect(o).toMatchObject({ edge: 'B7', loop: 'et2_time_multiple' });
    expect((o as { observed: number }).observed).toBeGreaterThanOrEqual(2);
  });
  it('B8: a change outside the Unit scope; and the agent declaring the scope exceeded', async () => {
    const s = w.store.load(ITEM);
    if (!s) throw new Error('no session');
    // a file outside src/, test/ and package.json
    const m = { ...w.store.getTree(s.tree_sha256) } as Record<
      string,
      { sha256: string; size: number; exec: boolean }
    >;
    m['docs/readme.md'] = { sha256: w.store.putBlob('# hi\n'), size: 5, exec: false };
    s.tree_sha256 = w.store.putTree(m);
    w.store.save(s);
    expect(await run('6.5', { key: 'b8' })).toMatchObject({
      outcome: 'rework',
      edge: 'B8',
      reason_code: 'scope_drift',
    });
  });
  it('the agent says the scope is exceeded at 6.4: the self-check raises B8', async () => {
    const again = w.store.load(ITEM);
    if (again) {
      again.task_idx = 0;
      w.store.save(again);
    }
    w.agent.push(() => ({
      final:
        '{"kind":"implementation","status":"blocked","summary":"big","files_changed":[],"checks_run":[],"blocker":{"reason":"scope_exceeded","detail":"d"}}',
    }));
    done(await run('6.4', { key: 'x4' }));
    expect(await run('6.5', { key: 'x5' })).toMatchObject({ edge: 'B8' });
  });
  it('R1: the diff over the lane budget, a sensitive path, a new dependency; at the top of the ladder it is ET8', async () => {
    const add = (files: Record<string, string>) => {
      const s = w.store.load(ITEM);
      if (!s) throw new Error('no session');
      const m = { ...w.store.getTree(s.tree_sha256) } as Record<
        string,
        { sha256: string; size: number; exec: boolean }
      >;
      for (const [p, c] of Object.entries(files))
        m[p] = { sha256: w.store.putBlob(c), size: c.length, exec: false };
      s.tree_sha256 = w.store.putTree(m);
      w.store.save(s);
    };
    add(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`src/gen${i}.js`, `exports.v = ${i};\n`]),
      ),
    );
    expect(await run('6.5', { key: 'r1a' })).toMatchObject({
      outcome: 'relane',
      edge: 'R1',
      trigger: 'diff_over_lane_budget',
      to_lane: 'L4',
    });
    // the same diff is within the budget of L6, which is the top of the ladder: a sensitive path there has nowhere to go
    expect(await run('6.5', { key: 'r1b', lane: 'L6', attempt: 2 })).toMatchObject({
      outcome: 'completed',
    });
    add({ 'src/migrations/9.sql': 'x' });
    expect(await run('6.5', { key: 'r1top', lane: 'L6', attempt: 3 })).toMatchObject({
      trigger: 'ET8',
      reason_code: 'lane_outgrown',
    });
  });
  it('R1 sensitive path and new dependency found in the tree', async () => {
    const s = w.store.load(ITEM);
    if (!s) throw new Error('no session');
    const m = { ...w.store.getTree(s.tree_sha256) } as Record<
      string,
      { sha256: string; size: number; exec: boolean }
    >;
    m['src/migrations/001.sql'] = {
      sha256: w.store.putBlob('create table t();'),
      size: 17,
      exec: false,
    };
    s.tree_sha256 = w.store.putTree(m);
    w.store.save(s);
    expect(await run('6.5', { key: 's1' })).toMatchObject({
      outcome: 'relane',
      trigger: 'sensitive_path',
    });
    delete m['src/migrations/001.sql'];
    const pj = JSON.stringify({
      name: 'synth',
      scripts: { test: 'node --test', check: 'node --test' },
      dependencies: { zod: '1.0.0' },
    });
    m['package.json'] = { sha256: w.store.putBlob(pj), size: pj.length, exec: false };
    s.tree_sha256 = w.store.putTree(m);
    w.store.save(s);
    expect(await run('6.5', { key: 's2' })).toMatchObject({
      outcome: 'relane',
      trigger: 'new_dependency',
    });
  });
  it('a broken environment at the self-check is B6, and the oracles must pass on their own', async () => {
    w.testRuns.push({ exit: 127 });
    expect(await run('6.5', { key: 'e1' })).toMatchObject({
      edge: 'B6',
      reason_code: 'env_broken',
    });
  });
  it('HUMAN-WAIT keeps a snapshot of the real workspace; with no workspace there is no snapshot', async () => {
    const snaps = new StoreWaitSnapshots(w.store);
    const kept = await snaps.keep({
      unit_id: 'u',
      item_id: ITEM,
      lease_epoch: 1,
      gate: 'G3o',
      gate_instance_id: 'g1',
    });
    expect(kept.ok && w.store.readSnapshot(kept.value.snapshot_ref)?.tree_sha256).toBe(
      w.store.load(ITEM)?.tree_sha256,
    );
    const none = await snaps.keep({
      unit_id: 'u',
      item_id: 'someone-else',
      lease_epoch: 1,
      gate: 'X1',
      gate_instance_id: 'g2',
    });
    expect(none.ok).toBe(false);
  });
});
