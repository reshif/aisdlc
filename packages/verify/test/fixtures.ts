import { agentDefinition } from '@aisdlc/agents';
import { readPrompt } from '@aisdlc/agents/files';
import {
  ITEM,
  SYNTH_BASE_SHA,
  SYNTH_REPO,
  sha256,
  synthOracleEntry,
  synthRepo,
} from '@aisdlc/build';
import {
  DEFAULT_CONSTITUTION,
  VerifyRunRequest,
  type Lane,
  type VerifyStep,
} from '@aisdlc/contracts';
import {
  FakeSandbox,
  type FakeSandboxOutcome,
  type RepoFile,
  type SandboxSpec,
} from '@aisdlc/ports';
import { FakeHoldouts, FakeRepoFiles, FakeReviewer, VerifyRunner } from '../src/index.js';
import { specHashOf } from '@aisdlc/build';

// The S7 world of the tests: the synthetic repo of S6 (packages/build testing.ts) at its base commit, and a Unit head
// with the fix and the locked oracle, behind fakes of every port (a scripted sandbox in place of the containers).

export const HEAD_SHA = 'b'.repeat(40);
export const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;
export const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';

const text = (c: RepoFile['content']): string => Buffer.from(c).toString('utf8');

export interface World {
  readonly files: FakeRepoFiles;
  readonly sandbox: FakeSandbox;
  readonly reviewer: FakeReviewer;
  readonly holdouts: FakeHoldouts;
  readonly runner: VerifyRunner;
  readonly base: RepoFile[];
  head: RepoFile[];
  readonly oraclePath: string;
  readonly oracleCode: string;
  /** Override a sandbox answer (return undefined for the default). */
  script: (spec: SandboxSpec, cmd: string) => FakeSandboxOutcome | undefined;
  readonly specs: SandboxSpec[];
}

/** The head: the base plus `changes` (null deletes). */
export function headOf(
  base: readonly RepoFile[],
  changes: Record<string, string | null>,
): RepoFile[] {
  const m = new Map(base.map((f) => [f.path, f]));
  for (const [p, c] of Object.entries(changes)) {
    if (c === null) m.delete(p);
    else m.set(p, { path: p, content: c });
  }
  return [...m.values()];
}

export function world(): World {
  const s = synthRepo();
  const base = s.files;
  const w: World = {
    files: new FakeRepoFiles(),
    sandbox: undefined as never,
    reviewer: new FakeReviewer(),
    holdouts: new FakeHoldouts(),
    runner: undefined as never,
    base,
    head: headOf(base, { 'src/calc.js': FIXED, [s.oracle.path]: s.oracle.content }),
    oraclePath: s.oracle.path,
    oracleCode: s.oracle.content,
    script: () => undefined,
    specs: [],
  };
  const sandbox = new FakeSandbox((spec) => {
    w.specs.push(spec);
    const cmd = spec.command.join(' ');
    const scripted = w.script(spec, cmd);
    if (scripted) return scripted;
    const calc = text(spec.repo.find((f) => f.path === 'src/calc.js')?.content ?? '');
    const fixed = calc.includes('a + b');
    // one test file: the oracle and the holdouts assert add; anything else passes
    if (cmd.startsWith('npm test -- ')) {
      const file = cmd.slice('npm test -- '.length);
      const asserts = file === w.oraclePath || file.startsWith('holdout/');
      return asserts && !fixed
        ? { exit_code: 1, stdout: 'not ok 1 - add adds\n' }
        : { exit_code: 0 };
    }
    if (cmd === 'npm test' || cmd === 'npm run check') {
      const hasOracle = spec.repo.some((f) => f.path === w.oraclePath);
      return hasOracle && !fixed
        ? { exit_code: 1, stdout: 'not ok 1 - add adds\n' }
        : { exit_code: 0 };
    }
    return { exit_code: 0 };
  });
  Object.assign(w, {
    sandbox,
    runner: new VerifyRunner({
      sandbox,
      files: w.files,
      holdouts: w.holdouts,
      reviewer: w.reviewer,
      prompt: readPrompt,
    }),
  });
  w.files.set(SYNTH_REPO, SYNTH_BASE_SHA, base);
  return w;
}

const def = agentDefinition('A5');
export const reviewBinding = () => ({
  agent: {
    run_id: 'run-a5-1',
    agent_id: 'A5' as const,
    contract_version: def.contract.contract_version,
    prompt_ref: def.prompt.ref,
    prompt_sha256: def.prompt.sha256,
    vkey_id: 'fake-vkey-1',
    tools: [...def.contract.tools],
    data_class_max: def.contract.data_class_max,
  },
  gateway_key: KEY,
  artefacts: [
    {
      type: 'oracle_specs',
      sha256: sha256(JSON.stringify([synthOracleEntry])),
      text: JSON.stringify([synthOracleEntry]),
    },
  ],
});

export function request(
  w: World,
  step: VerifyStep,
  over: Partial<VerifyRunRequest> = {},
): VerifyRunRequest {
  return VerifyRunRequest.parse({
    command_key: `${ITEM}/${step}/1`,
    item_id: ITEM,
    project_id: 'acme',
    unit_key: 'unit-main',
    step,
    attempt: 1,
    repo: SYNTH_REPO,
    lane: 'L3' as Lane,
    base_sha: SYNTH_BASE_SHA,
    head_sha: HEAD_SHA,
    locks: { [w.oraclePath]: sha256(w.oracleCode) },
    oracles: [
      { oracle_id: 'O1', requirement_id: 'REQ-1', spec_sha256: specHashOf(synthOracleEntry) },
    ],
    repro: false,
    approved_gates: [],
    x2_covered: false,
    x3_approved: false,
    approved_hosts: [],
    constitution: DEFAULT_CONSTITUTION,
    grant: null,
    review: step === '7.3' || step === '7.5' ? reviewBinding() : null,
    ...over,
  });
}

/** Runs one step over the world's head. */
export async function check(w: World, step: VerifyStep, over: Partial<VerifyRunRequest> = {}) {
  w.files.set(SYNTH_REPO, HEAD_SHA, w.head);
  const r = await w.runner.run(request(w, step, over));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
