import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCodingPort,
  FakeBuildSource,
  FakePush,
  ITEM,
  SYNTH_REPO,
  SessionStore,
  specHashOf,
  stageRequest,
  synthOracleCode,
  synthOracleEntry,
  synthRepo,
} from '@aisdlc/build';
import type { StageOutcome } from '@aisdlc/contracts';
import { readPrompt } from '@aisdlc/agents/files';
import { ok } from '@aisdlc/kernel';
import { FakeStagePort, GuardedSandbox, RunKeyVault, type SessionGuardDeps } from '@aisdlc/ports';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerAvailable, startRig, type Rig } from './rig.js';

// M13.6 in the REAL sandbox: A6 (the test agent, bound at 6.3 as the step's specialist) writes the oracle test files from the
// G2-approved specs in a real W session (the real Claude Agent SDK harness, `settingSources: []`, the contract's tools, the
// Unit key lent for the run), the factory checks them by spec hash, runs each red in a real O session (node --test) and locks
// them; then the coder fixes, 6.5 is green, and 6.6 hands exactly the Unit's patch to the (fake) Push Broker. Only the model is
// a script (the FakeProvider's `ScriptStep`s, served by the fake Messages server). The repo is synthetic.

const docker = dockerAvailable();
if (!docker.ok) console.warn(`S6 oracle-authoring sandbox tests SKIPPED: ${docker.why}`);
const KEY = `aisk_${'fedcba9876543210'.repeat(3)}`;
const DONE =
  '{"kind":"implementation","status":"completed","summary":"fixed add","files_changed":[{"path":"src/calc.js","change":"modified"}],"checks_run":[{"name":"npm test","passed":true}]}';
const WROTE = '{"status":"completed","summary":"wrote the oracle"}';
const ORACLE = 'test/oracle-add.test.js';

let rig: Rig;
let dir: string;
let store: SessionStore;
let source: FakeBuildSource;
let push: FakePush;
const vault = new RunKeyVault();

const guard: SessionGuardDeps = {
  execAllowedRepos: () => [SYNTH_REPO],
  hasOpenSecretFinding: async () => ok(false),
};
const port = () =>
  new AgentCodingPort({
    sandbox: new GuardedSandbox(rig.driver(), guard),
    store,
    source,
    guard,
    keys: vault,
    fallback: new FakeStagePort('coding'),
    push,
    model: 'claude-sonnet-5-5',
    prompt: readPrompt,
    limits: { run_time_s: 150, max_turns: 12, test_time_s: 120 },
  });

beforeAll(async () => {
  if (docker.ok) rig = await startRig({ apiKey: KEY });
});
afterAll(async () => {
  if (docker.ok) await rig?.teardown();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-s6o-'));
  store = new SessionStore(dir);
  const s = synthRepo();
  // NO oracle files bound to the Unit: A6 writes them
  source = new FakeBuildSource(s.files, s.plan, []);
  push = new FakePush();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (
  step: Parameters<typeof stageRequest>[0],
  o: Parameters<typeof stageRequest>[1] = {},
): Promise<StageOutcome> => {
  const req = stageRequest(step, o);
  if (req.agent) vault.put(req.agent.run_id, 'fake-vkey-1', KEY);
  const r = await port().run(req);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const completed = (o: StageOutcome) =>
  expect(o, JSON.stringify(o)).toMatchObject({ outcome: 'completed' });
const write = (file_path: string, content: string) => ({
  tool_uses: [{ name: 'Write', input: { file_path, content } }],
});
const fixCalc = {
  tool_uses: [
    {
      name: 'Edit',
      input: { file_path: '/work/repo/src/calc.js', old_string: 'a - b', new_string: 'a + b' },
    },
  ],
};

describe.skipIf(!docker.ok)('M13.6: oracle authoring and the push, in the real sandbox', () => {
  it('A6 writes the oracle in a W session with its own tools; the check passes by spec hash; the oracle is red in an O session and locked', async () => {
    completed(await run('6.1'));
    completed(await run('6.2'));
    const before = rig.model.seen.length;
    rig.model.reply(write(`/work/repo/${ORACLE}`, synthOracleCode()), { text: WROTE });
    completed(await run('6.3'));

    const s = store.load(ITEM);
    expect(s).toMatchObject({ stage: 'oracles_red', oracle_ids: ['O1'] });
    expect(Object.keys(s?.locks ?? {})).toEqual([ORACLE]);
    // kept by the source: a redo of 6.3 does not write it again
    expect(source.saved_oracles).toHaveLength(1);
    expect(source.saved_oracles[0]?.[0]).toMatchObject({ path: ORACLE });
    const before2 = rig.model.seen.length;
    completed(await run('6.3', { key: 'redo/6.3' }));
    expect(rig.model.seen.length).toBe(before2);

    // what the model was shown: A6's prompt and the approved spec as data, only A6's tools, the Unit key as the API key
    const seen = rig.model.seen.slice(before, before2);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const r of seen) {
      const text = JSON.stringify(r.body);
      expect(text).toContain('A6 test agent');
      expect(text).toContain('add(2, 3) is 5'); // the approved spec's description, quoted as DATA
      expect(text).toContain(`aisdlc-oracle id=O1 spec=${specHashOf(synthOracleEntry)}`);
      expect(text).not.toContain('push to main'); // the planted CLAUDE.md is not loaded
      const names = ((r.body['tools'] ?? []) as Array<{ name: string }>).map((t) => t.name);
      expect(names.sort()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
      expect(String(r.headers['x-api-key'] ?? r.headers['authorization'] ?? '')).toContain(KEY);
    }
    expect(rig.leftovers()).toEqual({ containers: [], networks: [], volumes: [], scratch: [] });
  });

  it('A6 may only ADD files: an edit of the implementation is ET8 and nothing is locked', async () => {
    completed(await run('6.1'));
    completed(await run('6.2'));
    rig.model.reply(write(`/work/repo/${ORACLE}`, synthOracleCode()), fixCalc, { text: WROTE });
    expect(await run('6.3')).toMatchObject({
      outcome: 'trigger',
      trigger: 'ET8',
      reason_code: 'oracle_author_touched_existing',
    });
    expect(store.load(ITEM)?.stage).toBe('baselined');
    expect(source.saved_oracles).toHaveLength(0);
  });

  it('an oracle written for another spec is a G3o deviation, never a silent pass', async () => {
    completed(await run('6.1'));
    completed(await run('6.2'));
    rig.model.reply(write(`/work/repo/${ORACLE}`, synthOracleCode('c'.repeat(64))), {
      text: WROTE,
    });
    expect(await run('6.3')).toMatchObject({ outcome: 'gate_needed', gate: 'G3o' });
  });

  it('6.1 to 6.6: A6 writes, the coder fixes, 6.5 is green, and the Unit’s patch (the fix and the oracle) goes to the Push Broker', async () => {
    completed(await run('6.1'));
    completed(await run('6.2'));
    rig.model.reply(write(`/work/repo/${ORACLE}`, synthOracleCode()), { text: WROTE });
    completed(await run('6.3'));
    rig.model.reply(
      { tool_uses: [{ name: 'Read', input: { file_path: '/work/repo/src/calc.js' } }] },
      fixCalc,
      { text: DONE },
    );
    completed(await run('6.4'));
    completed(await run('6.5'));
    const o = await run('6.6');
    completed(o);
    expect(push.requests).toHaveLength(1);
    const r = push.requests[0];
    expect(r?.patch.files.map((f) => f.path).sort()).toEqual(['src/calc.js', ORACLE]);
    expect(r?.base_sha).toBe(synthRepo().plan.base_sha);
    expect(store.load(ITEM)?.stage).toBe('pushed');
    expect(rig.leftovers()).toEqual({ containers: [], networks: [], volumes: [], scratch: [] });
  });
});
