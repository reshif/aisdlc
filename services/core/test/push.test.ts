import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrompt } from '@aisdlc/agents/files';
import {
  AgentCodingPort,
  ITEM,
  SYNTH_BASE_SHA,
  SessionStore,
  StoreWaitSnapshots,
  sha256 as sha256b,
  specHashOf,
  synthOracleCode,
  synthOracleEntry,
  synthRepo,
  type PushRequest,
} from '@aisdlc/build';
import {
  PUSH_EVENT,
  UNIT_EVENT,
  patchHashOf,
  patchSetOf,
  pushStream,
  unitStream,
  type CodingSessionResult,
  type Lane,
  type Level,
  type ProjectSettings,
  type PrrGatingProfile,
} from '@aisdlc/contracts';
import { HttpPushGuards } from '@aisdlc/codehost';
import { startTestCodeHost, type TestCodeHost } from '@aisdlc/codehost/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { ok as kok } from '@aisdlc/kernel';
import {
  FakeAgentKeys,
  FakeEnvelope,
  FakeProjectSettings,
  FakeSandbox,
  FakeStagePorts,
  GuardedSandbox,
  RunKeyVault,
  emptySeed,
  type CodeHostSeed,
  type SandboxSpec,
  type StagePorts,
} from '@aisdlc/ports';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionCapacity,
  approveBatch,
  CoreBuildSource,
  createCoreApp,
  CorePush,
  CorePushGuards,
  listPullRequests,
  listPushReceipts,
  listUnits,
  readGoverning,
  readItem,
  rebuildPushes,
  requestFromTwin,
  storeArtefact,
  submitRequest,
  planUnits,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M13.6 on the real record, ledger and Notary, the real S6 port (a scripted sandbox), the real Push Broker (the GitHub
// REST adapter in Push mode over the in-repo fake GitHub HTTP server) and core's own guards (the Unit's lease from its
// rows, X2 from the ledger): an admitted Unit, 6.1 to 6.6, a Draft PR on the fake GitHub, then the fake S7.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
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

interface Written {
  files?: Record<string, string>;
}

const sessionResult = (w: Written, final: string) => {
  const out: Record<string, string> = {};
  const changed = Object.entries(w.files ?? {}).map(([path, content]) => {
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

const seedFor = (repo: string, files: Array<[string, string]>): CodeHostSeed =>
  emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo, branch: 'main', sha: SYNTH_BASE_SHA }],
    files: files.map(([path, content]) => ({ repo, sha: SYNTH_BASE_SHA, path, content })),
  });

const settingsOf = (project: string): ProjectSettings => {
  const slot = (principals: string[]) => ({
    kind: 'principals' as const,
    principals: principals as never,
  });
  return {
    project_id: project as never,
    role_map: {
      admin: slot(['bob']),
      requesters: slot(['bob']),
      intent: slot(['bob']),
      design: slot(['bob']),
      g4: slot(['bob']),
      g5: slot(['bob']),
      x: slot(['bob']),
      sec: slot(['bob']),
      m4: slot(['bob']),
      kill: slot(['bob']),
    },
    two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
    gating_profile: { gates: GATING_OFF.gates, schedule: 'auto', tier_floor_applied: true },
    kill_delegations: [],
    version: 1,
    updated_at: '2026-11-09T00:00:00.000Z',
  } as ProjectSettings;
};

interface World {
  readonly repo: string;
  readonly project: string;
  readonly itemId: string;
  readonly host: TestCodeHost;
  readonly sandbox: FakeSandbox;
  readonly fakes: FakeStagePorts;
  readonly d: WorkDriverDeps;
  readonly source: CoreBuildSource;
  readonly push: CorePush;
  readonly store: SessionStore;
  wSpecs: SandboxSpec[];
  /** While set, S6 stalls at 6.1 (the Unit is admitted and holds its lease, nothing ran): for the tests that call the broker's client directly. */
  stall: { on: boolean };
  /** What the test agent writes at 6.3, and what the coder does at 6.4. */
  author: () => Written;
  coder: () => Written;
  dir: string;
}

let counter = 0;
const worlds: World[] = [];

async function world(
  o: {
    lane?: Lane;
    protectedGlobs?: string[];
    paths?: string[];
    withOracles?: boolean;
    laneOf?: (itemId: string) => Promise<string>;
    level?: Level;
    gating?: PrrGatingProfile;
    /** Makes the item instead of a plain N1 request (the remediation path: a twin gap as an N6 request). */
    submit?: (project: string, repo: string) => Promise<string>;
  } = {},
): Promise<World> {
  counter += 1;
  const project = `push${counter}`;
  const repo = `acme/${project}`;
  const seeded = await seedActivePrr(s, {
    level: o.level ?? 'full',
    gating: o.gating ?? GATING_OFF,
    project,
    repo,
  });
  approvers(s, seeded.project, ['bob']);
  const settings = new FakeProjectSettings();
  settings.set(settingsOf(project));
  const itemId = o.submit
    ? await o.submit(project, repo)
    : (ok(
        await submitRequest(s.deps, {
          project_id: pid(project),
          repo,
          lane: o.lane ?? 'L3',
          requester: pr('alice'),
          channel: 'N1',
          text: `push test ${counter}`,
        }),
      ).item_id as string);
  const synth = synthRepo();
  const host = await startTestCodeHost({
    seed: seedFor(repo, [['README.md', '# hi\n']]),
    mode: 'push',
    guards: new CorePushGuards(s.record.pool, o.laneOf),
  });
  // the plan: one Unit against the repo's base commit, the oracle spec G2 approved bound to it
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
          paths: o.paths ?? ['src/', 'test/', 'package.json'],
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
  if (o.withOracles !== false) {
    ok(await store$('oracle_specs', '3.4', { kind: 'oracle_specs', oracles: [synthOracleEntry] }));
    ok(
      await store$('verification_binding', '5.4', {
        bindings: [{ unit_key: 'main', oracle_ids: ['O1'] }],
      }),
    );
  }
  const source = new CoreBuildSource({
    pool: s.record.pool,
    deps: s.deps,
    repo: { files: async () => kok(synth.files) as never },
  });
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-core-push-'));
  const store = new SessionStore(dir);
  const w = {
    repo,
    project,
    itemId,
    host,
    fakes: new FakeStagePorts(),
    source,
    store,
    dir,
    wSpecs: [] as SandboxSpec[],
    stall: { on: false },
    author: () => ({ files: { [ORACLE_PATH]: synthOracleCode() } }) as Written,
    coder: () => ({ files: { 'src/calc.js': FIXED } }) as Written,
  } as unknown as World;
  const sandbox = new FakeSandbox((spec) => {
    if (spec.class === 'W') {
      w.wSpecs.push(spec);
      const task = JSON.parse(
        Buffer.from(
          spec.repo.find((f) => f.path.endsWith('task.json'))?.content ?? '{}',
        ).toString(),
      ) as { prompt?: string };
      const authoring = (task.prompt ?? '').startsWith('Step 6.3');
      return sessionResult(
        authoring ? w.author() : w.coder(),
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
  const vault = new RunKeyVault();
  const guard = { execAllowedRepos: () => [repo], hasOpenSecretFinding: async () => kok(false) };
  const push = new CorePush(
    {
      pool: s.record.pool,
      clock: s.clock,
      ledger: s.deps.ledger as never,
      ...(o.laneOf ? { laneOf: o.laneOf } : {}),
    },
    host.rest,
  );
  const coding = new AgentCodingPort({
    sandbox: new GuardedSandbox(sandbox, guard),
    store,
    source,
    guard,
    keys: vault,
    fallback: w.fakes.coding,
    push,
    ...(o.protectedGlobs ? { tripwires: { protected_globs: o.protectedGlobs } } : {}),
    model: 'claude-sonnet-5-5',
    prompt: readPrompt,
  });
  const stalled = {
    port: 'coding' as const,
    run: async (req: Parameters<typeof coding.run>[0]) =>
      w.stall.on && req.step === '6.1'
        ? kok({ outcome: 'held' as const, reason: 'WIP' as const })
        : coding.run(req),
  };
  const ports: StagePorts = {
    planning: w.fakes.planning,
    coding: stalled,
    verify: w.fakes.verify,
    release: w.fakes.release,
  };
  const envelope = new FakeEnvelope();
  const snapshots = new StoreWaitSnapshots(store);
  const capacity = new AdmissionCapacity({
    pool: s.record.pool,
    settings,
    envelope,
    sessionCap: 1,
  });
  Object.assign(w, {
    sandbox,
    push,
    d: {
      ...driverOver(s, { ports: ports as never }),
      ports,
      capacity,
      admission: { settings, envelope, snapshots, sessionCap: 50, attempted: capacity.attempted },
      keys: new FakeAgentKeys(),
      vault,
    } as unknown as WorkDriverDeps,
  });
  worlds.push(w);
  return w;
}

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.host.stop();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

const q = <T extends object>(sql: string, args: unknown[] = []) =>
  s.record.pool.query<T>(sql, args).then((x) => x.rows);
const writesOf = (w: World): string[] =>
  w.host.server.apiRequests
    .filter((r) => r.method !== 'GET')
    .map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/g, '<id>')}`);

const baseReq = (w: World, over: Partial<PushRequest> = {}): PushRequest => ({
  item_id: w.itemId,
  repo: w.repo,
  lane: 'L3',
  unit_key: 'main',
  lease_epoch: 1,
  base_sha: SYNTH_BASE_SHA,
  patch: patchSetOf([
    {
      op: 'put',
      path: 'src/calc.js',
      mode: '100644',
      content_b64: Buffer.from(FIXED).toString('base64'),
    },
  ]),
  message: 'Fix add',
  command_key: `cmd/${Math.random()}`,
  evidence: {
    title: 'Fix add',
    lane: 'L3',
    base_sha: SYNTH_BASE_SHA,
    oracles: [{ oracle_id: 'O1', spec_sha256: specHashOf(synthOracleEntry) }],
    files_changed: 1,
    lines_changed: 2,
    checks: [{ name: 'tests', result: 'passed' }],
    refs: {},
  },
  ...over,
});

/** Runs the item until its S6 is admitted (a lease), so a Unit exists with a held lease. */
const admitted = (st: NonNullable<Awaited<ReturnType<typeof readItem>>>['state']) =>
  st.lease !== null;

describe('a full run: admitted Unit, 6.1 to 6.6, a Draft PR on the fake GitHub, the fake S7', () => {
  it('A6 writes the oracles, the coder fixes, the broker pushes; the receipt is in the record and the ledger; the Unit is Pushed with its head', async () => {
    const w = await world();
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');

    // S6 ran 6.0 to 6.6 in order, then S7 (the fake): the hand-off to verify
    const coding = w.fakes.coding.calls.map((c) => c.step);
    expect(coding).toEqual([]); // 6.0 is the driver's admission; 6.1 to 6.6 were the real port's
    expect(w.fakes.verify.calls.map((c) => c.step)[0]).toBe('7.1');
    // A6 wrote the oracles in a W session with its own contract; the coder ran in another
    expect(w.wSpecs).toHaveLength(2);
    const [authoring, coding1] = w.wSpecs.map((sp) =>
      JSON.parse(
        Buffer.from(sp.repo.find((f) => f.path.endsWith('task.json'))?.content ?? '{}').toString(),
      ),
    ) as Array<{ allowed_tools: string[]; prompt: string }>;
    expect(authoring?.allowed_tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    expect(coding1?.allowed_tools).toContain('Bash');
    // the keys: one for A6 at 6.3 (its contract's tools), one for the coder at 6.4
    const runs = await q<{ agent_id: string; step: string }>(
      `SELECT body ->> 'agent_id' AS agent_id, body ->> 'step' AS step FROM record.record_event
        WHERE type = 'agent.run_dispatched' AND body ->> 'item_id' = $1 ORDER BY global_seq`,
      [w.itemId],
    );
    void runs;
    // the authored oracle is an artefact of the item (content-addressed, secret-scanned), returned by the source
    const files = ok(
      await w.source.oracleFiles({ item_id: w.itemId, repo: w.repo, unit_key: 'main' }),
    );
    expect(files.map((f) => f.path)).toEqual([ORACLE_PATH]);

    // the Draft PR on the fake GitHub, from the Unit's branch, with the fix and the oracle, parent = the base commit
    const branch = `agent/${w.itemId}/main`;
    const pull = w.host.server.pulls[0];
    expect(pull).toMatchObject({ number: 1, draft: true, state: 'open', merged: false });
    expect(pull?.head.ref).toBe(branch);
    expect(pull?.body).toContain('Draft pull request opened by the factory');
    expect(pull?.body).toContain(`${w.itemId}`);
    expect(pull?.body).toContain(specHashOf(synthOracleEntry));
    const head = w.host.server.objects.commit(w.repo, pull?.head.sha ?? '');
    expect(head?.parents).toEqual([SYNTH_BASE_SHA]);
    expect(head?.author.name).toBe('aisdlc[bot]');
    expect(
      w.host.server.objects.fileAt(w.repo, pull?.head.sha ?? '', 'src/calc.js')?.toString(),
    ).toBe(FIXED);
    expect(
      w.host.server.objects.fileAt(w.repo, pull?.head.sha ?? '', ORACLE_PATH)?.toString(),
    ).toBe(synthOracleCode());
    // the request log: only the allowed write calls
    expect(writesOf(w)).toEqual([
      'POST /repos/' + w.repo + '/git/blobs',
      'POST /repos/' + w.repo + '/git/blobs',
      'POST /repos/' + w.repo + '/git/trees',
      'POST /repos/' + w.repo + '/git/commits',
      'POST /repos/' + w.repo + '/git/refs',
      'POST /repos/' + w.repo + '/pulls',
    ]);

    // the record: the intent BEFORE the receipt, the receipt as an event and a ledger entry, in this order
    const ev = await q<{ type: string; global_seq: string }>(
      'SELECT type, global_seq::text FROM record.record_event WHERE stream = $1 ORDER BY global_seq',
      [pushStream(w.itemId)],
    );
    expect(ev.map((e) => e.type)).toEqual([PUSH_EVENT.intended, PUSH_EVENT.receipt_recorded]);
    const [receipt] = await listPushReceipts(s.record.pool, w.itemId);
    expect(receipt).toMatchObject({
      status: 'applied',
      branch,
      lease_epoch: 1,
      base_sha: SYNTH_BASE_SHA,
      head_sha: pull?.head.sha,
      pr_number: 1,
      files: 2,
      code: null,
    });
    const led = await q<{ entry_type: string; subject_hash: string; body: { head_sha: string } }>(
      `SELECT entry_type, subject_hash, body FROM ledger.ledger_entry WHERE entry_type = 'push.receipt' AND subject_id = $1`,
      [w.itemId],
    );
    expect(led).toHaveLength(1);
    expect(led[0]?.subject_hash).toBe(receipt?.patch_hash);
    expect(led[0]?.body.head_sha).toBe(pull?.head.sha);
    // the PullRequest read model
    expect(await listPullRequests(s.record.pool, w.itemId)).toEqual([
      expect.objectContaining({
        pr_ref: 'pr:1',
        number: 1,
        head_ref: branch,
        head_sha: pull?.head.sha,
        state: 'open',
        draft: true,
      }),
    ]);
    // the Unit: Pushed, with the head SHA and the PR (the grant lives until G4; verify is M14)
    const [unit] = await listUnits(s.record.pool, w.itemId);
    expect(unit).toMatchObject({ head_sha: pull?.head.sha, pr_ref: 'pr:1' });
    const progress = await q<{ to: string; head_sha: string | null }>(
      `SELECT body ->> 'to' AS "to", body ->> 'head_sha' AS head_sha FROM record.record_event
        WHERE stream = $1 AND type = $2 ORDER BY global_seq`,
      [unitStream(w.itemId), UNIT_EVENT.state_changed],
    );
    expect(progress.map((p) => p.to)).toEqual(['Building', 'Pushed']);
    expect(progress[1]?.head_sha).toBe(pull?.head.sha);

    // the read models are rebuildable from the record alone
    const before = await listPushReceipts(s.record.pool, w.itemId);
    expect(await rebuildPushes(s.deps, w.itemId)).toBe(1);
    expect(await listPushReceipts(s.record.pool, w.itemId)).toEqual(before);
    expect(await listPullRequests(s.record.pool, w.itemId)).toHaveLength(1);
  });
});

describe('R2b: the first N6 -> G0 -> L2 remediation PR (a twin gap, the normal intake, the engine, the Push Broker)', () => {
  it('a gap becomes an N6 request, a person approves G0, L2 runs to a Draft PR through the broker; the factory never merges, a person does', async () => {
    let gapId = '';
    const w = await world({
      lane: 'L2',
      level: 'light',
      // G0 on (the remediation enters S1 like any request and waits for G0), the rest off
      gating: { ...GATING_OFF, gates: { ...GATING_OFF.gates, g0g1: 'on' } },
      submit: async (project, repo) => {
        const g = await readGoverning(s.record.pool, repo);
        const gap = g?.governing?.prr.gaps.find(
          (x) => x.status === 'open' && x.visibility_class !== 'private_only',
        );
        if (!gap) throw new Error('the seeded record has no open public-safe gap');
        gapId = gap.gap_id;
        // the gap is in an approved twin batch (a person, on the ledger) before it can be asked for
        ok(
          await approveBatch({ ...s.deps, ledger: s.config.ledger }, pid(project), {
            repo: repo as never,
            rows: [{ gap_id: gap.gap_id, disposition: 'track_only' }],
            on_behalf_of: pr('alice'),
          }),
        );
        const r = ok(
          await requestFromTwin(s.deps, pid(project), {
            repo: repo as never,
            gap_id: gap.gap_id,
            on_behalf_of: pr('alice'),
          }),
        );
        if (!r.item_id) throw new Error('the remediation request made no item');
        return r.item_id;
      },
    });

    // the intake: N6, L2, origin issue, the twin's own text (never what GitHub says now)
    const requested = await q<{ body: Record<string, unknown> }>(
      `SELECT e.body FROM record.record_event e WHERE e.type = 'work.requested'
          AND e.body -> 'request_text' ->> 'text' LIKE $1`,
      [`%${gapId}%`],
    );
    expect(requested[0]?.body).toMatchObject({
      lane: 'L2',
      channel: 'N6',
      request_text: { origin: 'issue', taint: 'untrusted' },
    });

    // the engine stops at G0 until a person decides it; then L2 runs S3, S5 (partial), S6 and the fake S7
    const atMerge = (st: NonNullable<Awaited<ReturnType<typeof readItem>>>['state']) =>
      (st.waiting as { kind?: string; what?: string } | null)?.what === 'merge';
    const waiting = await runItem(s, w.d, w.itemId, { stop: atMerge });
    expect(waiting?.state.lane).toBe('L2');
    expect(waiting?.state.terminal).toBeNull();
    expect(atMerge(waiting?.state as never)).toBe(true);
    const g0 = await q<{ actor: string; decision: string }>(
      `SELECT actor, decision FROM ledger.ledger_entry WHERE entry_type = 'decision' AND gate_id = 'G0'
          AND subject_id = $1`,
      [w.itemId],
    );
    expect(g0).toEqual([{ actor: 'bob', decision: 'approve' }]);

    // the Draft PR the broker opened from the Unit's branch; nothing merged it
    const pull = w.host.server.pulls[0];
    expect(pull).toMatchObject({ draft: true, state: 'open', merged: false });
    expect(pull?.head.ref).toBe(`agent/${w.itemId}/main`);
    expect(writesOf(w).some((x) => /merge/i.test(x))).toBe(false);
    const [receipt] = await listPushReceipts(s.record.pool, w.itemId);
    expect(receipt).toMatchObject({ status: 'applied', pr_number: pull?.number });

    // a person merges on GitHub (the factory observes it): the item ends Done
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
    expect(writesOf(w).some((x) => /merge/i.test(x))).toBe(false);
  });
});

describe('the broker’s refusals, each recorded as a receipt and a ledger entry, and nothing written to GitHub', () => {
  /** A world stopped with the Unit admitted and its lease held at epoch 1. */
  const atLease = async (o: Parameters<typeof world>[0] = {}): Promise<World> => {
    const w = await world(o);
    w.stall.on = true;
    await runItem(s, w.d, w.itemId, { stop: admitted });
    w.stall.on = false;
    return w;
  };
  const refusedCodes = async (w: World) =>
    (await listPushReceipts(s.record.pool, w.itemId)).map((r) => `${r.status}:${r.code}`);
  const ledgerPushes = (w: World) =>
    q<{ body: { status: string; code: string | null } }>(
      `SELECT body FROM ledger.ledger_entry WHERE entry_type = 'push.receipt' AND subject_id = $1 ORDER BY ledger_seq`,
      [w.itemId],
    );

  it('a stale lease epoch is refused (the Unit owner says the lease is at another epoch); recorded as refused_stale_epoch', async () => {
    const w = await atLease();
    const r = ok(await w.push.push(baseReq(w, { lease_epoch: 2 })));
    expect(r).toMatchObject({ kind: 'refused', code: 'stale_epoch' });
    expect(await refusedCodes(w)).toEqual(['refused_stale_epoch:stale_epoch']);
    expect((await ledgerPushes(w)).map((l) => l.body.status)).toEqual(['refused_stale_epoch']);
    expect(writesOf(w)).toEqual([]);
    // the right epoch goes through
    expect(ok(await w.push.push(baseReq(w, { lease_epoch: 1 })))).toMatchObject({ kind: 'pushed' });
  });

  it('a lease that moved (a takeover bumps the epoch) makes the session’s epoch stale', async () => {
    const w = await atLease();
    await s.record.pool.query('UPDATE core.lease SET epoch = 2 WHERE item_id = $1', [w.itemId]);
    expect(ok(await w.push.push(baseReq(w)))).toMatchObject({
      kind: 'refused',
      code: 'stale_epoch',
    });
    expect(writesOf(w)).toEqual([]);
  });

  it('a released lease is no lease', async () => {
    const w = await atLease();
    await s.record.pool.query("UPDATE core.lease SET status = 'released' WHERE item_id = $1", [
      w.itemId,
    ]);
    expect(ok(await w.push.push(baseReq(w)))).toMatchObject({ kind: 'refused', code: 'no_lease' });
    expect(await refusedCodes(w)).toEqual(['no_lease:no_lease']);
  });

  it('a planted secret in the patch is refused with the rule id only; the record and the ledger never hold the value', async () => {
    const w = await atLease();
    const { RULES } = await import('@aisdlc/secrets-rules');
    const planted = RULES.find(
      (r) => r.id === 'aws-access-key-id',
    )?.fixtures.positive()[0] as string;
    const patch = patchSetOf([
      {
        op: 'put',
        path: 'src/config.js',
        mode: '100644',
        content_b64: Buffer.from(planted).toString('base64'),
      },
    ]);
    const r = ok(await w.push.push(baseReq(w, { patch })));
    expect(r).toMatchObject({ kind: 'refused', code: 'secret_in_patch' });
    expect(r.kind === 'refused' && r.message).toContain('aws-access-key-id');
    expect(writesOf(w)).toEqual([]);
    const secretTail = planted.slice(-16);
    const everything = JSON.stringify([
      await q('SELECT body FROM record.record_event WHERE stream = $1', [pushStream(w.itemId)]),
      await ledgerPushes(w),
      w.host.server.allText(),
    ]);
    expect(everything).not.toContain(secretTail);
  });

  it('a spike (L7): core refuses before the broker, and the broker’s own guard (core’s word for the lane) refuses when the caller lies', async () => {
    // the catalogue lets no L7 item into S6 today (OB §2.1 is silent: `unspecified`, so L8): the item's lane is core's word, replaced here
    const w = await atLease({ laneOf: async () => 'L7' });
    const guards = new CorePushGuards(s.record.pool, async () => 'L7');
    const lease = await guards.lease(w.itemId, 'main');
    expect(lease, JSON.stringify(lease)).toMatchObject({
      state: 'ok',
      value: { held: true, epoch: 1, lane: 'L7' },
    });
    // the caller (a lying one) names L4 and the right epoch: the broker asks core and refuses, before any write
    const lying = baseReq(w, { lane: 'L4' });
    const direct = await w.host.rest.apply_patch({
      repo: w.repo,
      item_id: w.itemId,
      unit_key: 'main',
      lane: 'L4',
      lease_epoch: 1,
      branch: `agent/${w.itemId}/main`,
      base_sha: SYNTH_BASE_SHA,
      expected_head: null,
      patch: lying.patch,
      message: 'x',
      evidence: lying.evidence,
    } as never);
    expect(direct).toMatchObject({ state: 'unreadable', code: 'spike_lane' });
    expect(writesOf(w)).toEqual([]);
    // CorePush itself reads the lane from core and never calls the broker for a spike
    const asked = w.host.server.apiRequests.length;
    expect(ok(await w.push.push(baseReq(w, { lane: 'L4' })))).toMatchObject({
      kind: 'refused',
      code: 'spike_lane',
    });
    expect(w.host.server.apiRequests.length).toBe(asked);
    expect((await refusedCodes(w)).at(-1)).toBe('refused:spike_lane');
  });

  it('a branch that moved (somebody else pushed) is refused, not forced; the factory never rebases onto it', async () => {
    const w = await atLease();
    const first = ok(await w.push.push(baseReq(w)));
    expect(first, JSON.stringify(first)).toMatchObject({ kind: 'pushed' });
    // a person pushes to the Unit's branch (against the rules)
    w.host.server.moveBranch(w.repo, `agent/${w.itemId}/main`, 'e'.repeat(40));
    const second = ok(
      await w.push.push(
        baseReq(w, {
          patch: patchSetOf([
            {
              op: 'put',
              path: 'src/calc.js',
              mode: '100644',
              content_b64: Buffer.from(`${FIXED}// v2\n`).toString('base64'),
            },
          ]),
        }),
      ),
    );
    expect(second).toMatchObject({ kind: 'refused', code: 'non_fast_forward' });
    expect((await refusedCodes(w)).at(-1)).toBe('refused:non_fast_forward');
    // no ref update, no PR update after the refusal
    expect(writesOf(w).filter((l) => l.startsWith('PATCH')).length).toBe(0);
  });

  it('SK-1: after an edit the factory pushes again to the same branch and updates the same PR; the head moves forward', async () => {
    const w = await atLease();
    const a = ok(await w.push.push(baseReq(w)));
    const v2 = patchSetOf([
      {
        op: 'put',
        path: 'src/calc.js',
        mode: '100644',
        content_b64: Buffer.from(`${FIXED}// edited\n`).toString('base64'),
      },
    ]);
    const b = ok(await w.push.push(baseReq(w, { patch: v2 })));
    expect(a.kind === 'pushed' && b.kind === 'pushed' && b.pr_number === a.pr_number).toBe(true);
    const receipts = await listPushReceipts(s.record.pool, w.itemId);
    expect(receipts.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(w.host.server.pulls).toHaveLength(1);
    const head = w.host.server.objects.commit(w.repo, b.kind === 'pushed' ? b.head_sha : '');
    expect(head?.parents).toEqual([a.kind === 'pushed' ? a.head_sha : '']);
    // the Unit's head is the newest, and a redelivery of the same command pushes nothing again
    const [unit] = await listUnits(s.record.pool, w.itemId);
    expect(unit?.head_sha).toBe(b.kind === 'pushed' ? b.head_sha : '');
    const req = baseReq(w, { patch: v2 });
    const again = ok(await w.push.push(req));
    expect(again).toMatchObject({
      kind: 'pushed',
      head_sha: b.kind === 'pushed' ? b.head_sha : '',
    });
    expect(await listPushReceipts(s.record.pool, w.itemId)).toHaveLength(2);
    expect(w.host.server.pulls).toHaveLength(1);
  });

  it('a broker that cannot be reached is no verdict: an error (delivered again), the intent is recorded, no receipt', async () => {
    const w = await atLease();
    w.host.server.answerWith(500);
    const r = await w.push.push(baseReq(w));
    expect(r.ok).toBe(false);
    w.host.server.answerNormally();
    expect(await listPushReceipts(s.record.pool, w.itemId)).toEqual([]);
    const ev = await q<{ type: string }>('SELECT type FROM record.record_event WHERE stream = $1', [
      pushStream(w.itemId),
    ]);
    expect(ev.map((e) => e.type)).toEqual([PUSH_EVENT.intended]);
  });
});

describe('SP-FID-3: a protected path is written only under an X2 decision bound to exactly that patch hash', () => {
  const protectedWorld = () =>
    world({ protectedGlobs: [], paths: ['src/', 'test/', 'package.json', 'AGENTS.md'] });
  const x2Pending = (st: NonNullable<Awaited<ReturnType<typeof readItem>>>['state']) =>
    st.gates.some((g) => g.gate === 'X2' && g.status === 'pending');

  it('6.6 raises X2 with the patch hash (the patch is an artefact), nothing is written; approved, the push runs again and is written; another patch with the same X2 is refused', async () => {
    const w = await protectedWorld();
    w.coder = () => ({ files: { 'src/calc.js': FIXED, 'AGENTS.md': 'new rules\n' } });
    const at = await runItem(s, w.d, w.itemId, { stop: x2Pending });
    const gate = at?.state.gates.find((g) => g.gate === 'X2' && g.status === 'pending');
    expect(gate, 'X2 is open').toBeDefined();
    // nothing was written to the host: the broker refused before any request
    expect(writesOf(w)).toEqual([]);
    expect(
      (await listPushReceipts(s.record.pool, w.itemId)).map((r) => `${r.status}:${r.code}`),
    ).toEqual(['refused:protected_path']);
    // the gate's facts carry the patch as its artefact: its sha256 IS the patch hash, and it is the gate's subject
    const opened = await q<{
      body: { facts: { artefacts?: Array<{ step: string; type: string; sha256: string }> } };
    }>(
      `SELECT body FROM record.record_event WHERE type = 'gate.opened' AND body ->> 'gate_instance_id' = $1`,
      [gate?.gate_instance_id],
    );
    const art = opened[0]?.body.facts.artefacts?.find((a) => a.step === '6.6');
    expect(art).toMatchObject({ type: 'patch' });
    const hash = art?.sha256 as string;
    const [refused] = await listPushReceipts(s.record.pool, w.itemId);
    expect(refused?.patch_hash).toBe(hash);
    const guards = new CorePushGuards(s.record.pool);
    expect(await guards.x2Bound(w.itemId, hash)).toEqual({ state: 'ok', value: false });
    // the card shows the patch (paths and sizes), never as markup the decider has to trust
    const { renderArtefact } = await import('../src/planning/render.js');
    const stored = await q<{ content: string }>(
      'SELECT content FROM core.artefact WHERE item_id = $1 AND sha256 = $2',
      [w.itemId, hash],
    );
    expect(renderArtefact('patch', JSON.parse(stored[0]?.content ?? '{}'))).toContain(
      '`AGENTS.md`',
    );

    // a person approves X2 (a ledger decision on that gate instance): the step runs again with X2 approved
    const d = await decideGate(s, gate?.gate_instance_id as string, 'bob', 'approve');
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect(await guards.x2Bound(w.itemId, hash)).toEqual({ state: 'ok', value: true });
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
    const receipts = await listPushReceipts(s.record.pool, w.itemId);
    expect(receipts.map((r) => r.status)).toEqual(['refused', 'applied']);
    expect(receipts[1]?.patch_hash).toBe(hash);
    const pull = w.host.server.pulls[0];
    expect(
      w.host.server.objects.fileAt(w.repo, pull?.head.sha ?? '', 'AGENTS.md')?.toString(),
    ).toBe('new rules\n');
    expect(pull?.body).toContain('Protected paths touched');

    // the SAME decision does not cover a different patch: a different hash, refused
    const other = patchSetOf([
      {
        op: 'put',
        path: 'AGENTS.md',
        mode: '100644',
        content_b64: Buffer.from('other rules\n').toString('base64'),
      },
    ]);
    expect(patchHashOf(other)).not.toBe(hash);
    expect(await guards.x2Bound(w.itemId, patchHashOf(other))).toEqual({
      state: 'ok',
      value: false,
    });
    const again = ok(await w.push.push(baseReq(w, { patch: other, lease_epoch: 1 })));
    expect(again).toMatchObject({ kind: 'refused' });
    // and it is not covering another item's identical patch either
    expect(await guards.x2Bound(ITEM, hash)).toEqual({ state: 'ok', value: false });
  });

  it('X2 denied is a handoff (D1), never a write', async () => {
    const w = await protectedWorld();
    w.coder = () => ({ files: { 'src/calc.js': FIXED, 'AGENTS.md': 'new rules\n' } });
    const at = await runItem(s, w.d, w.itemId, { stop: x2Pending });
    const gate = at?.state.gates.find((g) => g.gate === 'X2' && g.status === 'pending');
    ok(await decideGate(s, gate?.gate_instance_id as string, 'bob', 'reject'));
    await runItem(s, w.d, w.itemId, { passes: 6 });
    const st = (await readItem(s.record.pool, w.itemId))?.state;
    expect(st?.underlying === 'Handoff' || st?.phase === 'Handoff').toBe(true);
    expect(writesOf(w)).toEqual([]);
    const guards = new CorePushGuards(s.record.pool);
    const [r] = await listPushReceipts(s.record.pool, w.itemId);
    expect(await guards.x2Bound(w.itemId, r?.patch_hash as string)).toEqual({
      state: 'ok',
      value: false,
    });
  });
});

describe('core answers the Push Broker over HTTP (scope push_guard): the same facts, from its rows and the ledger', () => {
  const TOKENS = {
    codehost: 'codehost-at-core-'.padEnd(32, 'x'),
    reader: 'reader-at-core-'.padEnd(32, 'x'),
  };

  it('the lease and X2 routes need the scope, answer core’s own word, and the Push Broker pushes over them', async () => {
    const w = await world();
    w.stall.on = true;
    await runItem(s, w.d, w.itemId, { stop: admitted });
    w.stall.on = false;
    const app = createCoreApp({
      pool: s.record.pool,
      auth: new ServiceAuth(TOKENS),
      callers: { codehost: ['push_guard'], reader: ['read'] },
      registry: s.registry,
      clock: s.clock,
    });
    const url = await listen(app);
    try {
      const get = (token: string, path: string) =>
        fetch(new URL(path, url), { headers: { authorization: `Bearer ${token}` } });
      const lease = `/v1/push-guards/${w.itemId}/units/main/lease`;
      expect((await get(TOKENS.reader, lease)).status).toBe(403);
      expect((await fetch(new URL(lease, url))).status).toBe(401);
      const ok1 = await get(TOKENS.codehost, lease);
      expect(await ok1.json()).toEqual({ held: true, epoch: 1, lane: 'L3' });
      expect(
        (await get(TOKENS.codehost, `/v1/push-guards/${w.itemId}/units/Bad..Key/lease`)).status,
      ).toBe(400);
      const hash = 'a'.repeat(64);
      expect(
        await (
          await get(TOKENS.codehost, `/v1/push-guards/${w.itemId}/x2?patch_hash=${hash}`)
        ).json(),
      ).toEqual({ bound: false });
      expect(
        (await get(TOKENS.codehost, `/v1/push-guards/${w.itemId}/x2?patch_hash=zz`)).status,
      ).toBe(400);

      // the broker with its guards over HTTP (what the codehost process has): a push at the held epoch is written, a stale one is not
      const guards = new HttpPushGuards({ baseUrl: url, token: TOKENS.codehost });
      expect(await guards.lease(w.itemId, 'main')).toEqual({
        state: 'ok',
        value: { held: true, epoch: 1, lane: 'L3' },
      });
      const host = await startTestCodeHost({
        seed: seedFor(w.repo, [['README.md', '# hi\n']]),
        mode: 'push',
        guards,
      });
      try {
        const req = (epoch: number) => ({
          repo: w.repo,
          item_id: w.itemId,
          unit_key: 'main',
          lane: 'L3',
          lease_epoch: epoch,
          branch: `agent/${w.itemId}/main`,
          base_sha: SYNTH_BASE_SHA,
          expected_head: null,
          patch: baseReq(w).patch,
          message: 'Fix add',
          evidence: baseReq(w).evidence,
        });
        expect(await host.rest.apply_patch(req(5) as never)).toMatchObject({
          state: 'unreadable',
          code: 'stale_epoch',
        });
        expect(await host.rest.apply_patch(req(1) as never)).toMatchObject({ state: 'ok' });
      } finally {
        await host.stop();
      }
      // a core that cannot be reached is no answer: the broker refuses (unknown is unmet)
      await app.close();
      const dead = new HttpPushGuards({ baseUrl: url, token: TOKENS.codehost, timeoutMs: 500 });
      expect((await dead.lease(w.itemId, 'main')).state).toBe('unknown');
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
