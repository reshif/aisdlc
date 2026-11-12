import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrompt } from '@aisdlc/agents/files';
import {
  AgentCodingPort,
  FakeBuildSource,
  ITEM,
  SYNTH_REPO,
  SessionStore,
  sha256,
  stageRequest,
  synthRepo,
} from '@aisdlc/build';
import type { CodingSessionResult, SandboxGrantRef, StageOutcome } from '@aisdlc/contracts';
import { ok } from '@aisdlc/kernel';
import {
  FakeSandbox,
  FakeStagePort,
  GuardedSandbox,
  type FakeSandboxOutcome,
  RunKeyVault,
  type SandboxPort,
  type SandboxSpec,
} from '@aisdlc/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGrants } from '../src/grants.js';
import { startTestController, type TestController } from '../src/testing.js';

// M14.2: an existing S6 path (packages/build/test/coding-port.test.ts: 6.1 to 6.5 green on the synthetic repo) run
// twice, once on `FakeSandbox` directly and once through the sandbox-controller and `HttpSandbox` with the same
// `FakeSandbox` behind it. The outcomes are the same; every session the controller started named the item's grant;
// once the grant is no longer active the controller starts nothing and the step is an error (delivered again).

const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;
const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';
const DONE =
  '{"kind":"implementation","status":"completed","summary":"ok","files_changed":[],"checks_run":[]}';
const GRANT: SandboxGrantRef = {
  grant_id: 'unit-main@1',
  item_id: ITEM,
  unit_id: 'unit-main',
  lease_epoch: 1,
};

/**
 * The synthetic repo's sessions: a W session fixes `add`; O sessions run the tests over whatever tree they get.
 * `w` (M19) answers a W session first: `null` goes on to the scripted fix; anything else is what the session gives.
 */
function scriptedSandbox(
  w?: (spec: SandboxSpec) => Promise<FakeSandboxOutcome | null> | FakeSandboxOutcome | null,
): FakeSandbox {
  const calc = (spec: SandboxSpec): string => {
    const f = spec.repo.find((x) => x.path === 'src/calc.js');
    return f ? Buffer.from(f.content).toString() : '';
  };
  return new FakeSandbox(async (spec) => {
    const first = spec.class === 'W' && w ? await w(spec) : null;
    if (first !== null) return first;
    if (spec.class === 'W') {
      const h = sha256(FIXED);
      const res: CodingSessionResult = {
        schema: 'coding-session/1',
        status: 'finished',
        tripwire: null,
        final_text: DONE,
        turns: 3,
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_events: [],
        ignored_harness: ['CLAUDE.md'],
        setting_sources: [],
        key_on_disk: false,
        error: null,
        changed: [{ path: 'src/calc.js', sha256: h, size: FIXED.length, exec: false }],
        deleted: [],
        changes_truncated: false,
      };
      return { exit_code: 0, out: { [`blobs/${h}`]: FIXED, 'session.json': JSON.stringify(res) } };
    }
    const cmd = spec.command.join(' ');
    const fixed = calc(spec).includes('a + b');
    if (cmd === 'npm test -- test/oracle-add.test.js') {
      return fixed ? { exit_code: 0 } : { exit_code: 1, stdout: 'not ok 1 - add adds\n' };
    }
    if (cmd.startsWith('npm test -- ')) return { exit_code: 1, stdout: 'not ok 1 - repro\n' };
    if (cmd === 'npm test') {
      const hasOracle = spec.repo.some((x) => x.path === 'test/oracle-add.test.js');
      return hasOracle && !fixed
        ? { exit_code: 1, stdout: 'not ok 1 - add adds\n' }
        : { exit_code: 0 };
    }
    return { exit_code: 0 };
  });
}

interface World {
  port: AgentCodingPort;
  fake: FakeSandbox;
  vault: RunKeyVault;
  source: FakeBuildSource;
}

const dirs: string[] = [];
let tc: TestController | undefined;
afterEach(async () => {
  await tc?.close();
  tc = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(sandboxOf: (fake: FakeSandbox) => SandboxPort, fake: FakeSandbox): World {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-sbc-s6-'));
  dirs.push(dir);
  const s = synthRepo();
  const source = new FakeBuildSource(s.files, s.plan, [s.oracle]);
  source.grant = GRANT;
  const guard = {
    execAllowedRepos: () => [SYNTH_REPO],
    hasOpenSecretFinding: async () => ok(false),
  };
  const vault = new RunKeyVault();
  const port = new AgentCodingPort({
    sandbox: new GuardedSandbox(sandboxOf(fake), guard),
    store: new SessionStore(dir),
    source,
    guard,
    keys: vault,
    fallback: new FakeStagePort('coding'),
    model: 'claude-sonnet-5-5',
    prompt: readPrompt,
    now: () => 1_000_000,
  });
  return { port, fake, vault, source };
}

async function step(w: World, s: Parameters<typeof stageRequest>[0], key?: string) {
  const req = stageRequest(s, key ? { key } : {});
  if (req.agent) w.vault.put(req.agent.run_id, 'fake-vkey-1', KEY);
  return w.port.run(req);
}

async function s6(w: World): Promise<StageOutcome[]> {
  const out: StageOutcome[] = [];
  for (const s of ['6.1', '6.2', '6.3', '6.4', '6.5'] as const) {
    const r = await step(w, s);
    if (!r.ok) throw new Error(r.error.message);
    out.push(r.value);
  }
  return out;
}

describe('S6 6.1 to 6.5 through the sandbox-controller', () => {
  it('answers exactly what the in-process FakeSandbox answers, and every session named the grant', async () => {
    const direct = await s6(world((f) => f, scriptedSandbox()));
    expect(direct.map((o) => o.outcome)).toEqual(Array(5).fill('completed'));

    const fake = scriptedSandbox();
    const grants = new FakeGrants().grant(GRANT);
    tc = await startTestController({ driver: fake, grants });
    const c = tc;
    const via = await s6(world(() => c.client, fake));
    expect(via).toEqual(direct);
    expect(fake.runs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(fake.runs.map((r) => r.class))).toEqual(new Set(['O', 'W']));
    for (const r of fake.runs) expect(r.grant).toEqual(GRANT);
    expect(grants.asked.length).toBe(fake.runs.length);
    const slots = await c.client.slots();
    expect(slots.ok && slots.value.used_total).toBe(0);
  });

  it('a grant that is no longer active starts nothing: the step is an error, delivered again, never an outcome', async () => {
    const fake = scriptedSandbox();
    const grants = new FakeGrants().grant(GRANT);
    tc = await startTestController({ driver: fake, grants });
    const c = tc;
    const w = world(() => c.client, fake);
    expect((await step(w, '6.1')).ok).toBe(true);
    grants.revoke(GRANT.grant_id);
    const before = fake.runs.length;
    const r = await step(w, '6.2');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain('refused');
    expect(fake.runs.length).toBe(before);
    // no grant at all from the source: the adapter refuses before it calls the controller
    w.source.grant = null;
    grants.grant(GRANT);
    const none = await step(w, '6.2', 'again');
    expect(!none.ok && none.error.message).toContain('no admission grant');
    expect(fake.runs.length).toBe(before);
  });
});

// M19, the runner-killed-mid-session drill (docs/runbooks/drill-runner.md): the runner dies while 6.4's coding session
// runs. Either way the step is NOT answered (no outcome is kept: no silent pass), the slot is free again, and the
// command delivered again with the same key runs a fresh session under the SAME grant and lease epoch and completes.
describe('M19: a runner killed in the middle of a coding session', () => {
  async function upTo64(w: World) {
    for (const s of ['6.1', '6.2', '6.3'] as const) {
      const r = await step(w, s);
      expect(r.ok && r.value.outcome).toBe('completed');
    }
  }

  it("the session's container is killed: a void run, the step is an error and the redelivery completes", async () => {
    let killed = 0;
    const fake = scriptedSandbox(() => (killed++ === 0 ? { status: 'killed' } : null));
    const grants = new FakeGrants().grant(GRANT);
    tc = await startTestController({ driver: fake, grants });
    const c = tc;
    const w = world(() => c.client, fake);
    await upTo64(w);
    const first = await step(w, '6.4', 'cmd-6.4');
    expect(first.ok).toBe(false);
    expect(!first.ok && first.error.message).toMatch(/void \(killed\)/);
    // the slot is free at once, and the grant is untouched
    const slots = await c.client.slots();
    expect(slots.ok && slots.value.used_total).toBe(0);
    expect(slots.ok && slots.value.free.W).toBe(1);
    // the outbox delivers the same command again (same key): a fresh session, the same grant, an outcome
    const again = await step(w, '6.4', 'cmd-6.4');
    expect(again.ok && again.value.outcome).toBe('completed');
    const ws = fake.runs.filter((r) => r.class === 'W');
    expect(ws).toHaveLength(2);
    for (const r of fake.runs) expect(r.grant).toEqual(GRANT);
    expect(new Set(ws.map((r) => r.grant?.lease_epoch))).toEqual(new Set([GRANT.lease_epoch]));
  });

  it('the controller itself dies mid-session: the step is an error; the next controller sweeps, then the redelivery completes', async () => {
    let started!: () => void;
    const inSession = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const hang = new Promise<null>((r) => (release = () => r(null)));
    const dying = scriptedSandbox(() => {
      started();
      return hang;
    });
    const grants = new FakeGrants().grant(GRANT);
    tc = await startTestController({ driver: dying, grants });
    const dead = tc;
    // core's view of the runner host: one URL, whichever controller process answers on it
    let current: SandboxPort = dead.client;
    const viaHost: SandboxPort = { run: (spec) => current.run(spec) };
    const w = world(() => viaHost, dying);
    await upTo64(w);
    const pending = step(w, '6.4', 'cmd-6.4');
    await inSession;
    await dead.kill();
    const first = await pending;
    expect(first.ok).toBe(false);
    expect(!first.ok && first.error.message).toMatch(/sandbox (unavailable|driver_failure)/);

    // the restarted controller (a new process: a new driver, nothing running) sweeps before it places anything
    const swept: Array<ReadonlySet<string>> = [];
    const fresh = scriptedSandbox();
    tc = await startTestController({
      driver: fresh,
      grants,
      sweep: async (keep) => {
        swept.push(keep);
        return { containers: ['s6-w-dead'], networks: ['s6-w-dead'], scratch: [], errors: [] };
      },
    });
    const r0 = await tc.controller.sweep();
    expect(r0.containers).toEqual(['s6-w-dead']);
    expect(swept.map((k) => [...k])).toEqual([[]]);
    current = tc.client;
    const again = await step(w, '6.4', 'cmd-6.4');
    expect(again.ok && again.value.outcome).toBe('completed');
    expect(fresh.runs.filter((r) => r.class === 'W')).toHaveLength(1);
    expect(fresh.runs[0]?.grant).toEqual(GRANT);
    const slots = await tc.client.slots();
    expect(slots.ok && slots.value.used_total).toBe(0);
    release();
  });
});
