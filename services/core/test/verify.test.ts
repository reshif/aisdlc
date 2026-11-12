import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrompt } from '@aisdlc/agents/files';
import {
  AgentCodingPort,
  SYNTH_BASE_SHA,
  SessionStore,
  StoreWaitSnapshots,
  sha256 as sha256b,
  synthOracleCode,
  synthOracleEntry,
  synthRepo,
} from '@aisdlc/build';
import { HttpPushGuards } from '@aisdlc/codehost';
import { startTestCodeHost, type TestCodeHost } from '@aisdlc/codehost/testing';
import {
  DEFAULT_CONSTITUTION,
  VERIFY_EVENT,
  verifyStream,
  type CodingSessionResult,
  type ProjectSettings,
  type VerifyCheckResult,
} from '@aisdlc/contracts';
import { err, ok as kok } from '@aisdlc/kernel';
import {
  FakeAgentKeys,
  FakeEnvelope,
  FakeProjectSettings,
  FakeSandbox,
  FakeStagePorts,
  GuardedSandbox,
  RunKeyVault,
  emptySeed,
  type RepoFile,
  type SandboxSpec,
  type StagePorts,
} from '@aisdlc/ports';
import { FakeReviewer, type RepoFilesPort } from '@aisdlc/verify';
import { migrateVerify } from '@aisdlc/verify-service';
import { startTestVerify, type TestVerify } from '@aisdlc/verify-service/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionCapacity,
  AgentVerifyPort,
  CoreBuildSource,
  CorePush,
  CorePushGuards,
  planUnits,
  readItem,
  storeArtefact,
  submitRequest,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M14.3 end to end through core, with fakes only behind the ports: the real record, ledger and Notary, the real S6 port
// (a scripted sandbox), the real Push Broker over the in-repo fake GitHub, and the real verify service (its own
// schema and record streams) reading the base and the pushed head from that fake GitHub, its kits in the same scripted
// sandbox and A5 as a fake reviewer. S6 -> S7 7.1 to 7.5 -> the 7.6 guard -> G4 -> Done; X2 at 7.4 on a protected
// path; Q1 at 7.2 on a locked-test edit; the 7.6 guard stops an item whose check failed.

void HttpPushGuards;
let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await migrateVerify(s.record.pool);
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';
const ORACLE_PATH = 'test/oracle-add.test.js';
const DONE =
  '{"kind":"implementation","status":"completed","summary":"fixed add","files_changed":[],"checks_run":[]}';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const sessionResult = (files: Record<string, string>, final: string) => {
  const out: Record<string, string> = {};
  const changed = Object.entries(files).map(([path, content]) => {
    const h = sha256b(content);
    out[`blobs/${h}`] = content;
    return { path, sha256: h, size: content.length, exec: false };
  });
  const res: CodingSessionResult = {
    schema: 'coding-session/1',
    status: 'finished',
    tripwire: null,
    final_text: final,
    turns: 2,
    usage: { input_tokens: 5, output_tokens: 5 },
    tool_events: [],
    ignored_harness: [],
    setting_sources: [],
    key_on_disk: false,
    error: null,
    changed,
    deleted: [],
    changes_truncated: false,
  };
  out['session.json'] = JSON.stringify(res);
  return { exit_code: 0, out };
};

const settingsOf = (project: string): ProjectSettings => {
  const slot = (principals: string[]) => ({
    kind: 'principals' as const,
    principals: principals as never,
  });
  const slots = ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'];
  return {
    project_id: project as never,
    role_map: Object.fromEntries(slots.map((k) => [k, slot(['bob'])])),
    two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
    gating_profile: { gates: GATING_OFF.gates, schedule: 'auto', tier_floor_applied: true },
    kill_delegations: [],
    version: 1,
    updated_at: '2026-11-09T00:00:00.000Z',
  } as unknown as ProjectSettings;
};

interface World {
  readonly repo: string;
  readonly itemId: string;
  readonly host: TestCodeHost;
  readonly verify: TestVerify;
  readonly fakes: FakeStagePorts;
  readonly reviewer: FakeReviewer;
  readonly d: WorkDriverDeps;
  readonly dir: string;
  /** Changes the verify service sees on top of the pushed head (a later push it did not make). */
  tamper: Record<string, string>;
  /** Scripted answers for verify's own sessions (`s7-...`). */
  s7: (spec: SandboxSpec, cmd: string) => { exit_code: number; stdout?: string } | undefined;
  heads: string[];
}

let counter = 0;
const worlds: World[] = [];

async function world(): Promise<World> {
  counter += 1;
  const project = `vfy${counter}`;
  const repo = `acme/${project}`;
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF, project, repo });
  approvers(s, seeded.project, ['bob']);
  const settings = new FakeProjectSettings();
  settings.set(settingsOf(project));
  const sub = ok(
    await submitRequest(s.deps, {
      project_id: pid(project),
      repo,
      lane: 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `verify test ${counter}`,
    }),
  );
  const itemId = sub.item_id as string;
  const synth = synthRepo();
  const text = (f: RepoFile) =>
    typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString();
  const host = await startTestCodeHost({
    seed: emptySeed({
      installation: {
        installation_id: 4242,
        account_login: 'acme',
        repository_selection: 'selected',
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
        suspended: false,
      },
      repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo, branch: 'main', sha: SYNTH_BASE_SHA }],
      files: synth.files.map((f) => ({
        repo,
        sha: SYNTH_BASE_SHA,
        path: f.path,
        content: text(f),
      })),
    }),
    mode: 'push',
    guards: new CorePushGuards(s.record.pool),
  });
  ok(
    await planUnits(s.deps, {
      item_id: itemId as never,
      project_id: project as never,
      repo,
      plan_sha256: sha256b(`plan-${itemId}`),
      base_sha: SYNTH_BASE_SHA,
      units: [
        {
          unit_key: 'main',
          title: 'Fix add',
          paths: ['src/', 'test/', 'package.json'],
          size: 'small',
          depends_on: [],
          position: 0,
          envelope: { max_tokens: 400_000, max_cost_micro_usd: 3_000_000 },
        },
      ],
    }),
  );
  const store$ = (type: string, step: string, content: unknown) =>
    storeArtefact(s.deps, {
      item_id: itemId,
      project_id: project,
      type: type as never,
      step: step as never,
      command_key: `seed/${step}/${type}`,
      run_id: null,
      content,
    });
  ok(await store$('oracle_specs', '3.4', { kind: 'oracle_specs', oracles: [synthOracleEntry] }));
  ok(
    await store$('verification_binding', '5.4', {
      bindings: [{ unit_key: 'main', oracle_ids: ['O1'] }],
    }),
  );
  const source = new CoreBuildSource({
    pool: s.record.pool,
    deps: s.deps,
    repo: { files: async () => kok(synth.files) as never },
  });
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-core-verify-'));
  const store = new SessionStore(dir);
  const w = {
    repo,
    itemId,
    host,
    dir,
    tamper: {},
    heads: [],
    s7: () => undefined,
  } as unknown as World;
  const sandbox = new FakeSandbox((spec) => {
    if (spec.class === 'W') {
      const task = JSON.parse(
        Buffer.from(
          spec.repo.find((f) => f.path.endsWith('task.json'))?.content ?? '{}',
        ).toString(),
      ) as { prompt?: string };
      const authoring = (task.prompt ?? '').startsWith('Step 6.3');
      return authoring
        ? sessionResult(
            { [ORACLE_PATH]: synthOracleCode() },
            '{"status":"completed","summary":"wrote"}',
          )
        : sessionResult({ 'src/calc.js': FIXED }, DONE);
    }
    const cmd = spec.command.join(' ');
    if (spec.session_id.startsWith('s7-')) {
      const scripted = w.s7(spec, cmd);
      if (scripted) return scripted;
    }
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
  // the verify service reads the repo where it lives: the fake GitHub, at the base and at the pushed head
  const files: RepoFilesPort = {
    files: async (r, sha) => {
      const objects = host.server.objects;
      const paths = objects.pathsAt(r, sha);
      if (!paths) return err({ code: 'not_found', message: `no commit ${sha}` });
      if (sha !== SYNTH_BASE_SHA) w.heads.push(sha);
      const out: RepoFile[] = paths.map((p) => ({
        path: p,
        content: objects.fileAt(r, sha, p) ?? Buffer.alloc(0),
      }));
      if (sha === SYNTH_BASE_SHA) return kok(out);
      const m = new Map(out.map((f) => [f.path, f]));
      for (const [p, c] of Object.entries(w.tamper)) m.set(p, { path: p, content: c });
      return kok([...m.values()]);
    },
  };
  const reviewer = new FakeReviewer();
  const verify = await startTestVerify({ pool: s.record.pool, sandbox, files, reviewer });
  const vault = new RunKeyVault();
  const guard = { execAllowedRepos: () => [repo], hasOpenSecretFinding: async () => kok(false) };
  const fakes = new FakeStagePorts();
  const push = new CorePush(
    { pool: s.record.pool, clock: s.clock, ledger: s.deps.ledger as never },
    host.rest,
  );
  const coding = new AgentCodingPort({
    sandbox: new GuardedSandbox(sandbox, guard),
    store,
    source,
    guard,
    keys: vault,
    fallback: fakes.coding,
    push,
    model: 'claude-sonnet-5-5',
    prompt: readPrompt,
  });
  const verifyPort = new AgentVerifyPort({
    pool: s.record.pool,
    client: verify.client,
    keys: vault,
    fallback: fakes.verify,
    constitution: () => DEFAULT_CONSTITUTION,
    guard,
    store,
  });
  const ports: StagePorts = {
    planning: fakes.planning,
    coding,
    verify: verifyPort,
    release: fakes.release,
  };
  const envelope = new FakeEnvelope();
  const capacity = new AdmissionCapacity({
    pool: s.record.pool,
    settings,
    envelope,
    sessionCap: 1,
  });
  Object.assign(w, {
    verify,
    fakes,
    reviewer,
    d: {
      ...driverOver(s, { ports: ports as never }),
      ports,
      capacity,
      admission: {
        settings,
        envelope,
        snapshots: new StoreWaitSnapshots(store),
        sessionCap: 50,
        attempted: capacity.attempted,
      },
      keys: new FakeAgentKeys(),
      vault,
    } as unknown as WorkDriverDeps,
  });
  worlds.push(w);
  return w;
}

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.verify.close();
    await w.host.stop();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

const results = async (w: World): Promise<VerifyCheckResult[]> => {
  const q = await s.record.pool.query<{ body: { result: VerifyCheckResult } }>(
    'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
    [verifyStream(w.itemId), VERIFY_EVENT.check_recorded],
  );
  return q.rows.map((r) => r.body.result);
};

describe('S6 -> S7 through core', () => {
  it('the pushed head is verified by 7.1 to 7.5 in the verify service; the 7.6 guard lets it on; G4; Done', async () => {
    const w = await world();
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal, JSON.stringify(done?.state.waiting)).toBe('Done');
    const rs = await results(w);
    expect(rs.map((r) => `${r.step}:${r.verdict}`)).toEqual([
      '7.1:passed',
      '7.2:passed',
      '7.3:passed',
      '7.4:passed',
      '7.5:passed',
    ]);
    // the head verified is the one the Push Broker wrote; the base is the plan's base commit
    const pull = w.host.server.pulls[0];
    expect(new Set(rs.map((r) => r.head_sha))).toEqual(new Set([pull?.head.sha]));
    expect(rs.every((r) => r.base_sha === SYNTH_BASE_SHA)).toBe(true);
    // each result is bound into the item by hash (its output), and 7.6 (the fake, until M14.4) ran once
    const st = done?.state;
    const { verifyResultHash } = await import('@aisdlc/contracts');
    for (const r of rs) expect(st?.outputs[r.step]).toBe(verifyResultHash(r));
    expect(w.fakes.verify.calls.map((c) => c.step)).toEqual(['7.6']);
    // A5 reviewed at 7.3 and 7.5 under the run key the driver minted (lent for the call, never recorded)
    expect(w.reviewer.calls.map((c) => [c.check, c.key_seen])).toEqual([
      ['spec_conformance', true],
      ['constitution', true],
    ]);
    const leaked = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream LIKE 'verify:%' AND body::text LIKE '%aisk_%'`,
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
  });

  it('X2 at 7.4: a protected path in the head raises X2 bound to the result; approved, 7.5 runs and the item goes on', async () => {
    const w = await world();
    w.tamper = { 'AGENTS.md': 'Agents: read the README first.\n' };
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
    const rs = await results(w);
    const r74 = rs.find((r) => r.step === '7.4');
    expect(r74?.raised).toEqual({ kind: 'gate', gate: 'X2', reason_code: 'protected_path' });
    const x2 = done?.state.gates.filter((g) => g.gate === 'X2') ?? [];
    expect(x2.map((g) => [g.station, g.status, g.outcome])).toEqual([
      ['7.4!X2', 'decided', 'approve'],
    ]);
    expect(rs.map((r) => r.step)).toEqual(['7.1', '7.2', '7.3', '7.4', '7.5']);
  });

  it('no X2 at 7.4 when the head touches no protected path', async () => {
    const w = await world();
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.gates.some((g) => g.gate === 'X2')).toBe(false);
  });

  it('Q1 at 7.2: a locked test edited in the head quarantines the item (SECT before any handoff)', async () => {
    const w = await world();
    w.tamper = { [ORACLE_PATH]: `${synthOracleCode()}// relaxed\n` };
    const it2 = await runItem(s, w.d, w.itemId, {
      decide: (g) => (g === 'SECT' ? 'hold' : 'approve'),
    });
    const st = (await readItem(s.record.pool, w.itemId))?.state;
    expect(st?.underlying, JSON.stringify(st?.waiting)).toBe('Quarantined');
    void it2;
    const q = st?.quarantines?.[0];
    const r72 = (await results(w)).find((r) => r.step === '7.2');
    expect(q).toMatchObject({
      trigger: 'ET10',
      origin_phase: 'S7',
      origin_step: '7.2',
      cause: 'locked_test_edit',
    });
    const { verifyResultHash } = await import('@aisdlc/contracts');
    expect(q?.pack_sha256).toBe(r72 ? verifyResultHash(r72) : 'none');
    expect(st?.gates.find((g) => g.gate === 'SECT')?.status).toBe('pending');
  });

  it('the 7.6 guard: a check that failed stops the item before 7.6; nothing is taken as a pass', async () => {
    const w = await world();
    w.s7 = (_spec, cmd) =>
      cmd === 'npm run check' ? { exit_code: 1, stdout: 'not ok 1 - lint\n' } : undefined;
    await runItem(s, w.d, w.itemId);
    const st = (await readItem(s.record.pool, w.itemId))?.state;
    expect(st?.terminal).toBeNull();
    expect(st?.waiting).toMatchObject({
      kind: 'stuck',
      reason: 'stage_failed:s7_unmet',
      step: '7.6',
    });
    expect((await results(w)).find((r) => r.step === '7.1')?.verdict).toBe('failed');
    expect(w.fakes.verify.calls).toHaveLength(0);
  });
});
