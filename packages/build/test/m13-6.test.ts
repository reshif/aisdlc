import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrompt } from '@aisdlc/agents/files';
import {
  patchHashOf,
  patchSetOf,
  type CodingSessionResult,
  type StageOutcome,
} from '@aisdlc/contracts';
import { ok } from '@aisdlc/kernel';
import {
  FakeSandbox,
  FakeStagePort,
  GuardedSandbox,
  RunKeyVault,
  type FakeSandboxOutcome,
  type SandboxSpec,
} from '@aisdlc/ports';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentCodingPort,
  FakeBuildSource,
  FakePush,
  ITEM,
  SYNTH_REPO,
  SessionStore,
  sha256,
  specHashOf,
  stageRequest,
  synthOracleCode,
  synthOracleEntry,
  synthRepo,
} from '../src/index.js';

// M13.6 in the port, against `FakeSandbox` (same preflight, cap and output scan as the real driver): 6.3 where A6 WRITES the
// oracle test files, 6.6 where the patch goes to the Push Broker, and the L7 spike. The real sandbox runs the same flows
// in services/coding-runner/test/oracles-s6.test.ts.

const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;
const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';
const SPEC = specHashOf(synthOracleEntry);
const DONE =
  '{"kind":"implementation","status":"completed","summary":"ok","files_changed":[],"checks_run":[]}';

interface Written {
  files?: Record<string, string>;
  deleted?: string[];
  status?: CodingSessionResult['status'];
  tripwire?: CodingSessionResult['tripwire'];
}

let dir: string;
let store: SessionStore;
let source: FakeBuildSource;
let push: FakePush;
let sandbox: FakeSandbox;
let port: AgentCodingPort;
let vault: RunKeyVault;
/** What the test agent (A6) does at 6.3, then what the coder does at 6.4. */
let author: (spec: SandboxSpec) => Written;
let coder: (spec: SandboxSpec) => Written;
let wSpecs: SandboxSpec[];
const ORACLE_PATH = 'test/oracle-add.test.js';

const result = (w: Written, final: string): { exit_code: number; out: Record<string, string> } => {
  const out: Record<string, string> = {};
  const changed = Object.entries(w.files ?? {}).map(([path, content]) => {
    const h = sha256(content);
    out[`blobs/${h}`] = content;
    return { path, sha256: h, size: content.length, exec: false };
  });
  const res: CodingSessionResult = {
    schema: 'coding-session/1',
    status: w.status ?? 'finished',
    tripwire: w.tripwire ?? null,
    final_text: final,
    turns: 2,
    usage: { input_tokens: 5, output_tokens: 5 },
    tool_events: [],
    ignored_harness: [],
    setting_sources: [],
    key_on_disk: false,
    error: null,
    changed,
    deleted: w.deleted ?? [],
    changes_truncated: false,
  };
  out['session.json'] = JSON.stringify(res);
  return { exit_code: 0, out };
};

function make(lane: string, tripwires?: { protected_globs: string[] }): void {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-m136-'));
  store = new SessionStore(dir);
  const s = synthRepo();
  source = new FakeBuildSource(s.files, { ...s.plan, lease_epoch: 4 }, []);
  push = new FakePush();
  vault = new RunKeyVault();
  wSpecs = [];
  author = () => ({ files: { [ORACLE_PATH]: synthOracleCode() } });
  coder = () => ({ files: { 'src/calc.js': FIXED } });
  sandbox = new FakeSandbox((spec): FakeSandboxOutcome => {
    if (spec.class === 'W') {
      wSpecs.push(spec);
      const task = JSON.parse(
        Buffer.from(
          spec.repo.find((f) => f.path.endsWith('task.json'))?.content ?? '{}',
        ).toString(),
      ) as { prompt?: string };
      const authoring = (task.prompt ?? '').startsWith('Step 6.3');
      return result(
        (authoring ? author : coder)(spec),
        authoring ? '{"status":"completed","summary":"wrote"}' : DONE,
      );
    }
    const cmd = spec.command.join(' ');
    const calc = Buffer.from(
      spec.repo.find((f) => f.path === 'src/calc.js')?.content ?? '',
    ).toString();
    const fixed = calc.includes('a + b');
    if (cmd.startsWith('npm test -- ')) {
      return cmd.endsWith('oracle-add.test.js') && fixed
        ? { exit_code: 0 }
        : { exit_code: 1, stdout: 'not ok 1 - add adds\n' };
    }
    if (cmd === 'npm test') {
      const hasOracle = spec.repo.some((x) => x.path === ORACLE_PATH);
      return hasOracle && !fixed
        ? { exit_code: 1, stdout: 'not ok 1 - add adds\n' }
        : { exit_code: 0 };
    }
    return { exit_code: 0 };
  });
  const guard = {
    execAllowedRepos: () => [SYNTH_REPO],
    hasOpenSecretFinding: async () => ok(false),
  };
  port = new AgentCodingPort({
    sandbox: new GuardedSandbox(sandbox, guard),
    store,
    source,
    guard,
    keys: vault,
    fallback: new FakeStagePort('coding'),
    push,
    ...(tripwires ? { tripwires } : {}),
    model: 'claude-sonnet-5-5',
    prompt: readPrompt,
  });
  void lane;
}

const run = async (
  step: Parameters<typeof stageRequest>[0],
  o: Parameters<typeof stageRequest>[1] = {},
): Promise<StageOutcome> => {
  const req = stageRequest(step, o);
  if (req.agent) vault.put(req.agent.run_id, 'fake-vkey-1', KEY);
  const r = await port.run(req);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const completed = (o: StageOutcome) =>
  expect(o, JSON.stringify(o)).toMatchObject({ outcome: 'completed' });

beforeEach(() => make('L3'));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('6.3: A6 writes the oracle test files from the G2-approved specs', () => {
  beforeEach(async () => {
    completed(await run('6.1'));
    completed(await run('6.2'));
  });

  it('writes them in a W session with the test agent contract (no Bash), checks them by spec hash, runs them red and locks them', async () => {
    completed(await run('6.3'));
    expect(wSpecs).toHaveLength(1);
    const spec = wSpecs[0] as SandboxSpec;
    expect(spec.class).toBe('W');
    // the W session was given the key by the lender, and no file of the repo copy holds it
    expect(spec.gateway_key).toBe(KEY);
    for (const f of spec.repo) expect(Buffer.from(f.content).toString()).not.toContain(KEY);
    const task = JSON.parse(
      Buffer.from(spec.repo.find((f) => f.path.endsWith('task.json'))?.content ?? '{}').toString(),
    ) as {
      allowed_tools: string[];
      prompt: string;
      system_prompt: string;
      approved_classes: string[];
    };
    expect(task.allowed_tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    // the factory tells it the marker to copy; the approved spec is quoted as DATA inside a fence
    expect(task.prompt).toContain(`// aisdlc-oracle id=O1 spec=${SPEC}`);
    expect(task.system_prompt).toContain('A6 test agent');
    expect(task.system_prompt).toContain('add(2, 3) is 5');
    expect(task.system_prompt).toMatch(/DATA/);
    // the spec check passed, the oracle ran red, and the file is locked by hash
    const s = store.load(ITEM);
    expect(s?.stage).toBe('oracles_red');
    expect(s?.locks).toEqual({ [ORACLE_PATH]: sha256(synthOracleCode()) });
    expect(s?.oracle_ids).toEqual(['O1']);
    // the source holds what was written: every later look sees these bytes
    expect(source.saved_oracles).toHaveLength(1);
    expect(source.saved_oracles[0]?.[0]).toMatchObject({ path: ORACLE_PATH });
  });

  it('a redo of 6.3 uses the kept files: A6 does not write them twice', async () => {
    completed(await run('6.3'));
    completed(await run('6.3', { key: 'redo/6.3' }));
    expect(wSpecs).toHaveLength(1);
  });

  it('G3o on every deviation, by kind: spec mismatch, an unapproved oracle, a missing one, no marker, not red', async () => {
    const cases: Array<[string, Written, string]> = [
      [
        'spec_mismatch',
        { files: { [ORACLE_PATH]: synthOracleCode('f'.repeat(64)) } },
        'spec_mismatch',
      ],
      [
        'oracle_unbound',
        {
          files: {
            [ORACLE_PATH]: synthOracleCode(),
            'test/extra.test.js': `// aisdlc-oracle id=O9 spec=${'e'.repeat(64)}\nrequire('node:test')('x',()=>{throw new Error('x')});\n`,
          },
        },
        'oracle_unbound',
      ],
      ['oracle_missing', { files: {} }, 'oracle_missing'],
      [
        'no_marker',
        { files: { [ORACLE_PATH]: "require('node:test')('x',()=>{});\n" } },
        'no_marker',
      ],
    ];
    for (const [i, [name, written, kind]] of cases.entries()) {
      author = () => written;
      source.oracle_files = [];
      const o = await run('6.3', { key: `dev/${name}/${i}` });
      expect(o, name).toMatchObject({
        outcome: 'gate_needed',
        gate: 'G3o',
        reason_code: 'oracle_deviation',
      });
      const rec = store.getRecord<{ deviations: Array<{ kind: string }> }>(
        'oracle-deviation',
        (o as { output_hash: string }).output_hash,
      );
      expect(
        rec?.deviations.map((d) => d.kind),
        name,
      ).toContain(kind);
    }
  });

  it('G3o when the oracle is green already (it does not fail first)', async () => {
    author = () => ({ files: { [ORACLE_PATH]: synthOracleCode() } });
    // a repo where add already adds: the oracle passes before any implementation
    const fixedFiles = synthRepo().files.map((f) =>
      f.path === 'src/calc.js' ? { ...f, content: FIXED } : f,
    );
    make('L3');
    source.repoFiles = fixedFiles;
    completed(await run('6.1'));
    completed(await run('6.2'));
    const o = await run('6.3');
    expect(o).toMatchObject({ outcome: 'gate_needed', gate: 'G3o' });
    const rec = store.getRecord<{ deviations: Array<{ kind: string }> }>(
      'oracle-deviation',
      (o as { output_hash: string }).output_hash,
    );
    expect(rec?.deviations.map((d) => d.kind)).toContain('oracle_not_red');
  });

  it('A6 may only ADD files: a change or a deletion of a file already in the repo is ET8', async () => {
    for (const w of [
      { files: { 'src/calc.js': FIXED } },
      { deleted: ['test/mul.test.js'] },
    ] as Written[]) {
      author = () => w;
      const o = await run('6.3', { key: `touch/${JSON.stringify(w).length}` });
      expect(o).toMatchObject({
        outcome: 'trigger',
        trigger: 'ET8',
        reason_code: 'oracle_author_touched_existing',
      });
    }
    expect(store.load(ITEM)?.stage).toBe('baselined');
  });

  it('a tripwire, a canary or a spent budget in the authoring session is the same stop as the coder’s', async () => {
    author = () => ({ status: 'budget' });
    expect(await run('6.3', { key: 'b' })).toMatchObject({ outcome: 'trigger', trigger: 'ET1' });
    author = () => ({
      tripwire: { kind: 'credential_hunting', class: 'quarantine', detail: 'looked for ~/.aws' },
    });
    expect(await run('6.3', { key: 'q' })).toMatchObject({ outcome: 'trigger', trigger: 'ET10' });
    author = () => ({ files: { [ORACLE_PATH]: `// ${makeCanary('a6')}\n${synthOracleCode()}` } });
    const o = await run('6.3', { key: 'c' });
    // a factory canary in what came back from the sandbox is a quarantine, never a file in the repo
    expect(o).toMatchObject({ outcome: 'trigger', trigger: 'ET10' });
  });

  it('no test agent bound to the command: nothing is written, and the check finds every approved oracle missing (G3o)', async () => {
    const req = stageRequest('6.3', { key: 'noagent' });
    const { agent: _a, ...noAgent } = req;
    void _a;
    const r = await port.run(noAgent as never);
    expect(r.ok && r.value).toMatchObject({ outcome: 'gate_needed', gate: 'G3o' });
    expect(wSpecs).toHaveLength(0);
  });

  it('locked thereafter: the coder editing the authored oracle is a quarantine (ET10)', async () => {
    completed(await run('6.3'));
    coder = () => ({ files: { 'src/calc.js': FIXED, [ORACLE_PATH]: '// edited\n' } });
    const o = await run('6.4');
    expect(o).toMatchObject({ outcome: 'trigger', trigger: 'ET10' });
  });
});

describe('6.6: the patch goes to the Push Broker', () => {
  const upTo65 = async (): Promise<void> => {
    completed(await run('6.1'));
    completed(await run('6.2'));
    completed(await run('6.3'));
    completed(await run('6.4'));
    completed(await run('6.5'));
  };

  it('pushes the Unit’s change against its base, with the epoch it ran under, and completes with the head', async () => {
    await upTo65();
    const o = await run('6.6');
    completed(o);
    expect(push.requests).toHaveLength(1);
    const r = push.requests[0];
    expect(r).toMatchObject({
      item_id: ITEM,
      repo: SYNTH_REPO,
      lane: 'L3',
      unit_key: 'unit-main',
      lease_epoch: 4,
    });
    // exactly the fix and the oracle, nothing of the session directory
    expect(r?.patch.files.map((f) => `${f.op} ${f.path}`)).toEqual(
      ['put src/calc.js', `put ${ORACLE_PATH}`].sort(),
    );
    expect(r?.evidence.oracles).toEqual([{ oracle_id: 'O1', spec_sha256: SPEC }]);
    expect(r?.evidence.checks.every((c) => c.result === 'passed')).toBe(true);
    expect(store.load(ITEM)?.stage).toBe('pushed');
    expect(store.load(ITEM)?.pushed).toMatchObject({ pr_number: 1 });
    // idempotent: the same command is not pushed twice
    expect(await run('6.6')).toEqual(o);
    expect(push.requests).toHaveLength(1);
  });

  it('refuses to push what 6.5 did not pass', async () => {
    completed(await run('6.1'));
    expect(await run('6.6')).toEqual({ outcome: 'failed', code: 'not_self_checked' });
    expect(push.requests).toHaveLength(0);
  });

  it('a protected path is X2 bound to the patch hash: recorded as an artefact, raised with the hash; approved but unbound is ET8', async () => {
    // the coder's own tripwire is switched off here: the broker is the last defence and must hold on its own
    make('L3', { protected_globs: [] });
    source.plan = { ...source.plan, scope_globs: [...source.plan.scope_globs, 'AGENTS.md'] };
    coder = () => ({ files: { 'src/calc.js': FIXED, 'AGENTS.md': 'new rules\n' } });
    await upTo65();
    push.script((r) =>
      r.patch.files.some((f) => f.path === 'AGENTS.md')
        ? {
            kind: 'refused',
            code: 'protected_path',
            message: 'x',
            patch_hash: patchHashOf(r.patch),
          }
        : undefined,
    );
    const o = await run('6.6');
    const hash = patchHashOf(patchSetOf(push.requests[0]?.patch.files ?? []));
    expect(o).toEqual({
      outcome: 'gate_needed',
      gate: 'X2',
      reason_code: 'protected_path',
      output_hash: hash,
    });
    const art = source.artefacts.find((a) => a.type === 'patch');
    expect(art?.sha256).toBe(hash);
    // the gate was approved, but the broker still finds no decision bound to this patch: no second gate, a handoff
    const again = await run('6.6', { key: 'x2/6.6', approved: ['X2'] });
    expect(again).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET8',
      reason_code: 'x2_not_bound',
    });
  });

  it('the broker’s other refusals: a secret is Q1, a stale epoch or a moved branch a handoff, a spike never a push, an unreachable broker is delivered again', async () => {
    await upTo65();
    const refuse = (code: never) =>
      push.script((r) => ({
        kind: 'refused',
        code,
        message: 'm',
        patch_hash: patchHashOf(r.patch),
      }));
    refuse('stale_epoch' as never);
    expect(await run('6.6', { key: 'b' })).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET8',
      reason_code: 'push_stale_epoch',
    });
    refuse('non_fast_forward' as never);
    expect(await run('6.6', { key: 'c' })).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET8',
      reason_code: 'push_non_fast_forward',
    });
    refuse('spike_lane' as never);
    expect(await run('6.6', { key: 'd' })).toEqual({
      outcome: 'failed',
      code: 'spike_never_pushes',
    });
    push.breakIt();
    const r = await port.run(stageRequest('6.6', { key: 'e' }));
    expect(r.ok).toBe(false);
    push.breakIt(false);
    refuse('secret_in_patch' as never);
    expect(await run('6.6', { key: 'a' })).toMatchObject({ outcome: 'trigger', trigger: 'ET10' });
  });
});

describe('L7: the throwaway S6 ends in the SPIKE report and never reaches the Push Broker', () => {
  it('6.5 produces the report, the work is archived as a content-addressed snapshot, and nothing is pushed', async () => {
    make('L7');
    const L7 = { lane: 'L7' };
    source.plan = { ...source.plan, oracles: [] };
    completed(await run('6.1', L7));
    completed(await run('6.2', L7));
    completed(await run('6.3', L7));
    completed(await run('6.4', L7));
    const o = await run('6.5', L7);
    completed(o);
    const s = store.load(ITEM);
    expect(s?.stage).toBe('spiked');
    // the report is a content-addressed record: findings, a recommendation, the archive reference
    const art = source.artefacts.find((a) => a.type === 'spike_report');
    expect(art).toBeDefined();
    expect((o as { output_hash: string }).output_hash).toBe(art?.sha256);
    const report = art?.content as {
      findings: string[];
      recommendation: string;
      archive_ref: string | null;
      lane: string;
      files_changed: number;
    };
    expect(report.lane).toBe('L7');
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.recommendation).toMatch(/spike|throwaway|raise a normal work item/);
    expect(report.files_changed).toBe(1);
    // the branch is archived: a snapshot of the session, read back by its reference, whose tree has the work
    expect(report.archive_ref).toMatch(/^snap:[0-9a-f]{32}$/);
    const snap = store.readSnapshot(report.archive_ref ?? '');
    expect(snap?.tree_sha256).toBe(s?.tree_sha256);
    expect(store.textOf(snap?.tree_sha256 ?? '', 'src/calc.js')).toContain('a + b');
    // never the Push Broker: no request, and a 6.6 asked for a spike is refused before it reaches the broker
    expect(push.requests).toHaveLength(0);
    expect(await run('6.6', L7)).toEqual({ outcome: 'failed', code: 'spike_never_pushes' });
    expect(push.requests).toHaveLength(0);
  });

  it('a spike with no local work archives nothing', async () => {
    make('L7');
    const L7 = { lane: 'L7' };
    source.plan = { ...source.plan, oracles: [] };
    coder = () => ({ files: {} });
    for (const st of ['6.1', '6.2', '6.3', '6.4', '6.5'] as const) completed(await run(st, L7));
    const art = source.artefacts.find((a) => a.type === 'spike_report');
    expect((art?.content as { archive_ref: string | null }).archive_ref).toBeNull();
  });

  it('a spike is still quarantined for credential hunting: the tripwires stand', async () => {
    make('L7');
    const L7 = { lane: 'L7' };
    source.plan = { ...source.plan, oracles: [] };
    for (const st of ['6.1', '6.2', '6.3'] as const) completed(await run(st, L7));
    coder = () => ({ tripwire: { kind: 'credential_hunting', class: 'quarantine', detail: 'x' } });
    expect(await run('6.4', L7)).toMatchObject({ outcome: 'trigger', trigger: 'ET10' });
  });
});
