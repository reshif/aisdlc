import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  EVIDENCE_BUCKET,
  VERIFY_EVENT,
  evidenceStream,
  verifyStream,
  type CodingSessionResult,
  type ProjectSettings,
  type VerifyCheckResult,
} from '@aisdlc/contracts';
import { err, ok as kok } from '@aisdlc/kernel';
import {
  FakeAgentKeys,
  FakeEnvelope,
  FakeObjectStore,
  fakeKeyCustody,
  FakeProjectSettings,
  FakeSandbox,
  FakeStagePorts,
  GuardedSandbox,
  RunKeyVault,
  emptySeed,
  type EvidenceSignerPort,
  type ObjectStorePort,
  type RepoFile,
  type SandboxSpec,
  type StagePorts,
} from '@aisdlc/ports';
import { FakeReviewer, verifyPackMain, type RepoFilesPort } from '@aisdlc/verify';
import { migrateVerify } from '@aisdlc/verify-service';
import { startTestVerify, type TestVerify } from '@aisdlc/verify-service/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionCapacity,
  AgentVerifyPort,
  CoreBuildSource,
  CoreEvidence,
  listEvidencePacks,
  readSignedPack,
  rebuildEvidencePacks,
  evidencePackView,
  gateCardContext,
  itemVerifyView,
  signedPackBytes,
  CorePush,
  CorePushGuards,
  FakePrincipalLinks,
  listPullRequests,
  listPushReceipts,
  listUnits,
  rebuildPushes,
  rebuildUnits,
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
// sandbox and A5 as a fake reviewer. S6 -> S7 7.1 to 7.5 -> 7.6 (the Evidence Pack signed by the real Notary and
// stored in a fake write-once object store) -> G4 -> Done; X2 at 7.4 on a protected path; Q1 at 7.2 on a locked-test
// edit; M14.4: B9 and its limit to D2, B10, B11, B12 -> E6 -> G3o and its limit to D2, a check with no verdict.

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

const sessionResult = (files: Record<string, string>, final: string, deleted: string[] = []) => {
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
    deleted,
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
  readonly objects: CountingObjectStore;
  /** Changes the verify service sees on top of the pushed head (a later push it did not make). */
  tamper: Record<string, string>;
  /** Scripted answers for verify's own sessions (`s7-...`). */
  s7: (spec: SandboxSpec, cmd: string) => { exit_code: number; stdout?: string } | undefined;
  heads: string[];
  /** B11 worlds: the coding sessions of 6.4, in order, with what each saw (the prompt and whether the old approach was there). */
  sessions: Array<{ prompt: string; sawOldApproach: boolean }>;
}

/** The fake write-once store, counting the puts that stored something new. */
class CountingObjectStore extends FakeObjectStore implements ObjectStorePort {
  readonly stored: string[] = [];
  override async put(bucket: string, bytes: Uint8Array, opts: { contentType: string }) {
    const before = await this.head(bucket, sha256b(Buffer.from(bytes))).catch(() => null);
    const r = await super.put(bucket, bytes, opts);
    if (r.ok && !(before?.ok && before.value)) this.stored.push(r.value.sha256);
    return r;
  }
}

let counter = 0;
const worlds: World[] = [];

/** B11 worlds: the first approach adds a hack file beside the fix; the re-planned one, from the branch head, undoes it. */
const HACK = 'src/parser-hack.js';
const FIXED_V2 = `${FIXED}// approach 2: add stays where it is; the parser is fixed upstream\n`;

async function world(
  o: { oracleEntry?: typeof synthOracleEntry; b11?: boolean } = {},
): Promise<World> {
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
  ok(
    await store$('oracle_specs', '3.4', {
      kind: 'oracle_specs',
      oracles: [o.oracleEntry ?? synthOracleEntry],
    }),
  );
  ok(
    await store$('verification_binding', '5.4', {
      bindings: [{ unit_key: 'main', oracle_ids: ['O1'] }],
    }),
  );
  const source = new CoreBuildSource({
    pool: s.record.pool,
    deps: s.deps,
    // the base from the synthetic repo; any other commit (a Unit's branch head) from where it lives: the fake GitHub
    repo: {
      files: async (r, sha) => {
        if (sha === SYNTH_BASE_SHA) return kok(synth.files) as never;
        const objects = host.server.objects;
        const paths = objects.pathsAt(r, sha);
        if (!paths) return err({ code: 'not_found', message: `no commit ${sha}` }) as never;
        return kok(
          paths.map((p) => ({ path: p, content: objects.fileAt(r, sha, p) ?? Buffer.alloc(0) })),
        ) as never;
      },
    },
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
    sessions: [],
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
      if (authoring)
        return sessionResult(
          { [ORACLE_PATH]: synthOracleCode() },
          '{"status":"completed","summary":"wrote"}',
        );
      if (!o.b11) return sessionResult({ 'src/calc.js': FIXED }, DONE);
      const prompt = task.prompt ?? '';
      const sawOldApproach = spec.repo.some((f) => f.path === HACK);
      w.sessions.push({ prompt, sawOldApproach });
      // the re-planned session starts from the branch head: it undoes the wrong approach (the hack) and goes on
      return sawOldApproach
        ? sessionResult({ 'src/calc.js': FIXED_V2 }, DONE, [HACK])
        : sessionResult({ 'src/calc.js': FIXED, [HACK]: 'exports.hack = true;\n' }, DONE);
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
  const objects = new CountingObjectStore();
  const verifyPort = new AgentVerifyPort({
    pool: s.record.pool,
    client: verify.client,
    keys: vault,
    fallback: fakes.verify,
    evidence: new CoreEvidence({
      pool: s.record.pool,
      clock: s.clock,
      ledger: s.deps.ledger as never,
      // the core stack's real Notary (over HTTP), whose `core` caller holds the `evidence` scope
      signer: s.deps.ledger?.notary as unknown as EvidenceSignerPort,
      objects,
      store,
    }),
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
    objects,
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
      // owner decision 2026-11-13: a re-plan of a pushed Unit takes its PR back to draft through the Push Broker
      pulls: host.rest,
      ...(o.b11
        ? {
            review: {
              source: host.rest,
              links: new FakePrincipalLinks().link('bob', 'bob'),
            },
          }
        : {}),
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
  it('the pushed head is verified by 7.1 to 7.5 in the verify service; 7.6 signs the passing pack; G4; Done', async () => {
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
    // each result is bound into the item by hash (its output); 7.6 is the Evidence Pack, never the stage-port fake
    const st = done?.state;
    const { verifyResultHash } = await import('@aisdlc/contracts');
    for (const r of rs) expect(st?.outputs[r.step]).toBe(verifyResultHash(r));
    expect(w.fakes.verify.calls).toHaveLength(0);
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.map((p) => [p.disposition.kind, p.passing, p.head_sha])).toEqual([
      ['passed', true, pull?.head.sha],
    ]);
    expect(st?.outputs['7.6']).toBe(packs[0]?.pack_sha256);
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
    // the passing pack binds the X2 instance with its ledger decision, and 7.4 as met under it
    const [p] = await listEvidencePacks(s.record.pool, w.itemId);
    const pack = ok(await readSignedPack(w.objects, p as never)).signed.pack;
    expect(pack.passing).toBe(true);
    const g = pack.gates.find((x) => x.gate === 'X2');
    expect(g).toMatchObject({ station: '7.4!X2', status: 'decided', outcome: 'approve' });
    expect(g?.decisions.map((d) => d.decision)).toEqual(['approve']);
    expect(pack.steps[3]).toMatchObject({ step: '7.4', gate_approved: true, met: true });
    expect(rs.map((r) => r.step)).toEqual(['7.1', '7.2', '7.3', '7.4', '7.5']);

    // M14.6: the portal's reads of the same record
    const v = ok(await itemVerifyView(s.record.pool, w.itemId));
    expect(v.head_sha).toBe(r74?.head_sha);
    expect(v.steps.map((x) => `${x.step}:${x.status}`)).toEqual([
      '7.1:passed',
      '7.2:passed',
      '7.3:passed',
      '7.4:raised',
      '7.5:passed',
    ]);
    const s74 = v.steps[3];
    expect(s74?.gate).toMatchObject({ gate: 'X2', status: 'decided', outcome: 'approve' });
    expect(s74?.gate?.card_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s74?.findings.items.some((f) => f.kind === 'protected_path')).toBe(true);
    expect(v.pack).toMatchObject({ pack_sha256: p?.pack_sha256, passing: true });
    const ev = ok(await evidencePackView(s.record.pool, w.objects, w.itemId));
    expect(ev.contents).toMatchObject({ verified: true, units: [pack.units[0]?.unit_key] });
    expect(ev.contents?.steps).toEqual(pack.steps);
    expect(ev.verify_command).toContain(`--head ${pack.head_sha}`);
    const without = ok(await evidencePackView(s.record.pool, undefined, w.itemId));
    expect([without.contents, without.contents_problem]).toEqual([
      null,
      'the object store is not configured for this service',
    ]);
    const bytes = ok(
      await signedPackBytes(s.record.pool, w.objects, w.itemId, p?.pack_sha256 as string),
    );
    expect(sha256b(Buffer.from(bytes.bytes))).toBe(p?.object_key);
    const ctx = ok(await gateCardContext(s.record.pool, s74?.gate?.card_id as string));
    expect(ctx).toMatchObject({ gate: 'X2', station: '7.4!X2', step: '7.4', quorum_required: 1 });
    expect(ctx.decisions.map((d) => d.decision)).toEqual(['approve']);
    expect(ctx.check?.result_sha256).toBe(s74?.result_sha256);
    // X2 at 7.4 binds the patch 6.6 pushed (its artefact's hash is the patch hash)
    expect(ctx.patch).toMatchObject({ source: 'bound_artefact', bound: true });
    expect(
      ctx.binds.some((b) => b.label === '6.6 patch' && b.value === ctx.patch?.patch_hash),
    ).toBe(true);
    expect(ctx.binds.map((b) => b.label)).toContain('station');
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

    // M14.6: Q1 on the portal: 7.2 raised ET10, and the SECT card's context is the quarantine and that result
    const v = ok(await itemVerifyView(s.record.pool, w.itemId));
    const s72 = v.steps[1];
    expect(s72).toMatchObject({ step: '7.2', status: 'raised' });
    expect(s72?.raised).toMatchObject({ kind: 'trigger', trigger: 'ET10' });
    expect(s72?.gate).toMatchObject({ gate: 'SECT', status: 'pending' });
    expect(s72?.findings.items[0]?.repair_class).toBe('quarantine');
    const ctx = ok(await gateCardContext(s.record.pool, s72?.gate?.card_id as string));
    expect(ctx).toMatchObject({ gate: 'SECT', step: null, station: 'sect:1' });
    expect(ctx.quarantine).toMatchObject({ cause: 'locked_test_edit', origin_step: '7.2' });
    expect(ctx.check?.step).toBe('7.2');
    expect(ctx.binds.find((b) => b.label === 'quarantine evidence')?.value).toBe(q?.pack_sha256);
  });

  it('M14.4 7.6: the pack is signed, stored once, recorded with its ledger entry, rebuilt, and verifies offline', async () => {
    const w = await world();
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
    const head = w.host.server.pulls[0]?.head.sha as string;
    const [p] = await listEvidencePacks(s.record.pool, w.itemId);
    if (!p) throw new Error('no pack');
    // stored once in the write-once bucket, under the sha256 of its bytes
    expect(w.objects.stored).toEqual([p.object_key]);
    expect((await w.objects.delete(EVIDENCE_BUCKET, p.object_key)).ok).toBe(false);
    const read = ok(await readSignedPack(w.objects, p));
    const pack = read.signed.pack;
    expect(pack).toMatchObject({
      item_id: w.itemId,
      head_sha: head,
      base_sha: SYNTH_BASE_SHA,
      passing: true,
      units: [{ unit_key: 'main' }],
      oracle_locks: { [ORACLE_PATH]: sha256b(synthOracleCode()) },
    });
    expect(pack.steps.map((x) => [x.step, x.verdict, x.met])).toEqual([
      ['7.1', 'passed', true],
      ['7.2', 'passed', true],
      ['7.3', 'passed', true],
      ['7.4', 'passed', true],
      ['7.5', 'passed', true],
    ]);
    expect(pack.push_receipt?.head_sha).toBe(head);
    // every gate the item had raised by 7.6 (none here: the project's gating is off before G4)
    expect(pack.gates).toEqual([]);
    // the record event and the ledger entry carry the pack id, bound to the head
    const ev = await s.record.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1',
      [evidenceStream(w.itemId)],
    );
    expect(ev.rows[0]?.n).toBe(1);
    const le = await s.record.pool.query<{ subject_hash: string; head: string }>(
      `SELECT subject_hash, body->>'head_sha' AS head FROM ledger.ledger_entry
        WHERE entry_type = 'evidence.pack_signed' AND subject_id = $1`,
      [w.itemId],
    );
    expect(le.rows).toEqual([{ subject_hash: p.pack_sha256, head }]);
    // the read model is a fold of the record
    await s.record.pool.query('DELETE FROM core.evidence_pack WHERE item_id = $1', [w.itemId]);
    expect(await rebuildEvidencePacks(s.deps, w.itemId)).toBe(1);
    expect(await listEvidencePacks(s.record.pool, w.itemId)).toEqual([p]);
    // a retry of the 7.6 command signs and stores nothing again
    const again = await w.d.ports.verify.run({
      command_key: p.command_key,
      item_id: w.itemId as never,
      project_id: done?.state.project_id as never,
      repo: w.repo as never,
      lane: 'L3',
      step: '7.6',
      attempt: 1,
      approved_gates: [],
      denied_gates: [],
      catalogue_ref: done?.state.catalogue_ref as never,
    });
    expect(again).toEqual({
      ok: true,
      value: { outcome: 'completed', output_hash: p.pack_sha256 },
    });
    expect(w.objects.stored).toHaveLength(1);
    expect(await listEvidencePacks(s.record.pool, w.itemId)).toHaveLength(1);

    // offline: the CLI with the pack bytes and the Notary's public key only
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-pack-'));
    try {
      const file = join(dir, 'pack.json');
      const keyFile = join(dir, 'notary.jwk');
      writeFileSync(file, read.bytes);
      writeFileSync(keyFile, JSON.stringify(s.deps.ledger?.notaryKey));
      const lines: string[] = [];
      const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
      const run = (args: string[]) =>
        verifyPackMain(['--pack', file, '--notary-key', keyFile, ...args], io);
      expect(await run(['--head', head, '--item', w.itemId, '--object-key', p.object_key])).toBe(0);
      expect(lines.join('\n')).toMatch(/evidence pack OK/);
      // a wrong head
      expect(await run(['--head', 'f'.repeat(40)])).toBe(1);
      expect(lines.at(-1)).toMatch(/head_mismatch/);
      // a wrong key
      const other = await fakeKeyCustody({ seed: 'someone-else' }).publicKey('dev:notary');
      writeFileSync(keyFile, JSON.stringify(other.ok ? other.value : {}));
      expect(await run(['--head', head])).toBe(1);
      expect(lines.at(-1)).toMatch(/bad_signature/);
      writeFileSync(keyFile, JSON.stringify(s.deps.ledger?.notaryKey));
      // a tampered pack: one verdict flipped and the file re-canonicalised, then the id fixed up as well
      const signed = JSON.parse(Buffer.from(read.bytes).toString()) as {
        pack: { steps: Array<{ verdict: string }> };
        pack_sha256: string;
      };
      const { canonicalJson, sha256Hex } = await import('@aisdlc/kernel');
      (signed.pack.steps[0] as { verdict: string }).verdict = 'failed';
      writeFileSync(file, canonicalJson(signed as never));
      expect(await run(['--head', head])).toBe(1);
      expect(lines.at(-1)).toMatch(/pack_hash_mismatch/);
      signed.pack_sha256 = sha256Hex(canonicalJson(signed.pack as never));
      writeFileSync(file, canonicalJson(signed as never));
      expect(await run(['--head', head])).toBe(1);
      expect(lines.at(-1)).toMatch(/bad_signature/);
      // bytes that are not the canonical form
      writeFileSync(file, Buffer.concat([Buffer.from(read.bytes), Buffer.from('\n')]));
      expect(await run(['--head', head])).toBe(1);
      expect(lines.at(-1)).toMatch(/not_canonical/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B9: a repairable 7.1 failure goes back to 6.4 under the pinned limit (ET3, 3 rounds), then D2 carries both packs', async () => {
    const w = await world();
    w.s7 = (_spec, cmd) =>
      cmd === 'npm run check' ? { exit_code: 1, stdout: 'not ok 1 - lint\n' } : undefined;
    const st = (await runItem(s, w.d, w.itemId, { stop: (x) => x.underlying === 'Handoff' }))
      ?.state;
    expect(st?.underlying, JSON.stringify(st?.waiting)).toBe('Handoff');
    expect(st?.rework.by_loop['B9:et3_rounds']).toBe(3);
    expect(st?.attempts['s:6.4']).toBe(4);
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.map((p) => [p.disposition.kind, p.passing])).toEqual([
      ['rework', false],
      ['rework', false],
      ['rework', false],
      ['handoff', false],
    ]);
    expect(packs[0]?.disposition).toEqual({
      kind: 'rework',
      edge: 'B9',
      loop: 'et3_rounds',
      reason_code: 'repairable_7.1',
    });
    const d2 = packs[3];
    expect(d2?.disposition).toEqual({
      kind: 'handoff',
      trigger: 'ET3',
      step: '7.6',
      reason_code: 'b9_limit',
    });
    // D2: the Handoff Pack (A11) beside the Evidence Pack, both in the write-once bucket, both bound into the Handoff
    const h = st?.handoffs.at(-1);
    expect(h).toMatchObject({ code: 'D2', trigger: 'ET3', origin_phase: 'S7' });
    expect(d2?.handoff_pack_sha256).toMatch(/^[0-9a-f]{64}$/);
    const hp = ok(await w.objects.get(EVIDENCE_BUCKET, d2?.handoff_object_key as string));
    const handoff = JSON.parse(Buffer.from(hp).toString()) as {
      schema: string;
      failing_tests: string[];
    };
    expect(handoff.schema).toBe('handoff-pack/1');
    expect(handoff.failing_tests.some((f) => f.startsWith('7.1 command_failed'))).toBe(true);
    const { d2HandoffHash } = await import('@aisdlc/contracts');
    expect(st?.outputs['7.6']).toBe(
      d2HandoffHash({
        schema: 'd2-handoff/1',
        item_id: w.itemId as never,
        trigger: 'ET3',
        reason_code: 'b9_limit',
        evidence_pack_sha256: d2?.pack_sha256 as string,
        handoff_pack_sha256: d2?.handoff_pack_sha256 ?? null,
      }),
    );
    // every pack of the item is signed and stored, none of them passing
    for (const p of packs) {
      const r = ok(await readSignedPack(w.objects, p));
      expect(r.signed.pack.passing).toBe(false);
    }
    expect(w.fakes.verify.calls).toHaveLength(0);
  });

  it('B10: A5 finds the spec ambiguous at 7.3: back to 3.2 (G2 portion again)', async () => {
    const w = await world();
    w.reviewer.scripted((req) =>
      req.check === 'spec_conformance'
        ? {
            verdict: 'findings',
            findings: [
              {
                severity: 'high',
                rule_id: 'spec_ambiguous',
                location: { path: 'src/calc.js' },
                message: 'the spec does not say what add does with strings',
              },
            ],
          }
        : undefined,
    );
    const st = (
      await runItem(s, w.d, w.itemId, {
        stop: (x) => (x.rework.by_edge['B10'] ?? 0) > 0,
      })
    )?.state;
    expect(st?.rework.by_edge['B10']).toBe(1);
    // the spec is drafted again (3.2 ran a second time)
    expect(st?.attempts['s:3.2']).toBe(2);
    expect(await listEvidencePacks(s.record.pool, w.itemId)).toEqual([]);
  });

  it('B11: A5 finds the approach wrong: 7.6 records the pack and sends the item back to 5.1 (G3 again)', async () => {
    const w = await world();
    w.reviewer.scripted((req) =>
      req.check === 'spec_conformance'
        ? {
            verdict: 'findings',
            findings: [
              {
                severity: 'high',
                rule_id: 'approach_wrong',
                location: { path: 'src/calc.js' },
                message: 'the plan patches add where the parser is the bug',
              },
            ],
          }
        : undefined,
    );
    const st = (
      await runItem(s, w.d, w.itemId, {
        stop: (x) => (x.rework.by_edge['B11'] ?? 0) > 0,
      })
    )?.state;
    expect(st?.rework.by_edge['B11']).toBe(1);
    // the plan is made again (5.1 ran a second time)
    expect(st?.attempts['s:5.1']).toBe(2);
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.map((p) => p.disposition)).toEqual([
      { kind: 'rework', edge: 'B11', loop: null, reason_code: 'approach_wrong_7.3' },
    ]);
    const r = ok(await readSignedPack(w.objects, packs[0] as never));
    const s73 = r.signed.pack.steps.find((x) => x.step === '7.3');
    expect(s73?.findings.items.map((f) => [f.kind, f.repair_class])).toEqual([
      ['conformance_review', 'approach_wrong'],
    ]);
  });

  it('B11 after the push (owner decision 2026-11-13): re-planned on the SAME branch and PR, fast-forward, a new pack for the new head, G4, merge', async () => {
    const w = await world({ b11: true });
    // A5 finds the approach wrong on the first head only
    let conformance = 0;
    w.reviewer.scripted((req) => {
      if (req.check !== 'spec_conformance') return undefined;
      conformance += 1;
      return conformance > 1
        ? undefined
        : {
            verdict: 'findings',
            findings: [
              {
                severity: 'high',
                rule_id: 'approach_wrong',
                location: { path: 'src/calc.js' },
                message: 'the plan patches add where the parser is the bug',
              },
            ],
          };
    });
    const unitRows = async () =>
      (
        await s.record.pool.query(
          `SELECT u.unit_id, u.state, u.branch, u.lease_epoch, u.head_sha, u.pr_ref, u.base_sha, u.plan_sha256,
                  l.epoch, l.status, l.holder_kind
             FROM core.unit u LEFT JOIN core.lease l USING (unit_id) WHERE u.item_id = $1 ORDER BY u.unit_key`,
          [w.itemId],
        )
      ).rows;
    const grantRows = async () =>
      (
        await s.record.pool.query(
          `SELECT grant_id, unit_id, lease_epoch, status, release_cause, resumes_grant_id
             FROM core.admission_grant WHERE item_id = $1 ORDER BY lease_epoch`,
          [w.itemId],
        )
      ).rows;

    // ---- to 7.6's B11: the Unit is pushed (branch and draft PR), the pack of the head is a rework, never a pass
    const first = (
      await runItem(s, w.d, w.itemId, { stop: (x) => (x.rework.by_edge['B11'] ?? 0) > 0 })
    )?.state;
    expect(first?.rework.by_edge['B11']).toBe(1);
    const [h1receipt] = await listPushReceipts(s.record.pool, w.itemId);
    const h1 = h1receipt?.head_sha as string;
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
    const prNumber = h1receipt?.pr_number as number;
    expect(w.host.server.objects.pathsAt(w.repo, h1)).toContain(HACK);

    // ---- the re-plan (5.1 again), 6.0 re-admits at a higher epoch, S6 builds on the branch head, 6.6 fast-forwards
    // the SAME branch and PR, S7 again, G4, merge
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal, JSON.stringify(done?.state.waiting)).toBe('Done');
    expect(done?.state.attempts['s:5.1']).toBe(2);
    // the Unit's record: pushed, sent back to Planned by the `replanned` release (its branch and PR kept), admitted again
    // at a higher epoch, pushed again on the same PR
    const unitEvents = (
      await s.record.pool.query<{ type: string; body: Record<string, unknown> }>(
        'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
        [`unit:${w.itemId}`],
      )
    ).rows.map((r) =>
      [
        r.type.replace('unit.', ''),
        r.body['to'] ?? r.body['cause'] ?? r.body['lease_epoch'],
        r.body['pr_ref'] ?? '',
      ].join(' '),
    );
    expect(unitEvents.slice(0, 8)).toEqual([
      'admitted 1 ',
      'state_changed Building ',
      `state_changed Pushed pr:${prNumber}`,
      'lease_changed left_s6 ',
      'grant_released replanned ',
      'admitted 2 ',
      'state_changed Building ',
      `state_changed Pushed pr:${prNumber}`,
    ]);
    const g1 = (await grantRows())[0] as { lease_epoch: number; release_cause: string };
    expect(g1.release_cause).toBe('replanned');
    // on entering the re-plan the PR got ONE ids-only comment, before the new commit was written; nothing was closed or
    // opened
    const { replanCommentOf } = await import('@aisdlc/contracts');
    expect(w.host.server.pulls[0]?.comments?.map((c) => c.body)).toEqual([
      replanCommentOf(w.itemId, 'main', g1.lease_epoch),
    ]);
    const writes = w.host.server.apiRequests
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.path.replace(w.repo, 'R')}`);
    const commentAt = writes.indexOf(`POST /repos/R/issues/${prNumber}/comments`);
    const commitsAt = writes.flatMap((x, i) => (x === 'POST /repos/R/git/commits' ? [i] : []));
    expect(commitsAt).toHaveLength(2);
    expect(commentAt).toBeGreaterThan(commitsAt[0] as number);
    expect(commentAt).toBeLessThan(commitsAt[1] as number);
    expect(writes.filter((x) => x === 'POST /repos/R/pulls')).toHaveLength(1);
    expect(writes.some((x) => /PATCH .*pulls\/\d+$/.test(x))).toBe(true);
    // the rows are a fold of the record: rebuilt, the same
    const beforeRebuild = { units: await unitRows(), grants: await grantRows() };
    await rebuildUnits(s.deps, w.itemId);
    expect({ units: await unitRows(), grants: await grantRows() }).toEqual(beforeRebuild);
    const receipts = (await listPushReceipts(s.record.pool, w.itemId)).filter(
      (r) => r.status === 'applied',
    );
    expect(receipts.map((r) => [r.branch, r.pr_number, r.base_sha])).toEqual([
      [`agent/${w.itemId}/main`, prNumber, SYNTH_BASE_SHA],
      [`agent/${w.itemId}/main`, prNumber, SYNTH_BASE_SHA],
    ]);
    const h2 = receipts[1]?.head_sha as string;
    expect(h2).not.toBe(h1);
    expect(receipts[1]?.lease_epoch).toBeGreaterThan(receipts[0]?.lease_epoch as number);
    // a fast-forward: the new commit's parent is the old head, never a force
    expect(w.host.server.objects.commit(w.repo, h2)?.parents).toEqual([h1]);
    expect(w.host.server.pulls).toHaveLength(1);
    expect(w.host.server.pulls[0]?.head.sha).toBe(h2);
    expect(w.host.server.pulls[0]?.commits.map((c) => c.sha)).toEqual([h1, h2]);
    expect(w.host.server.pulls[0]?.comments).toHaveLength(1);
    expect(
      w.host.server.apiRequests.filter(
        (r) => r.method !== 'GET' && /\/pulls$/.test(r.path) && r.method === 'POST',
      ),
    ).toHaveLength(1);
    // the re-planned session started from the branch head (it saw the old approach) and was told to undo it; the new head
    // no longer has it
    expect(w.sessions.map((x) => x.sawOldApproach)).toEqual([false, true]);
    expect(w.sessions[1]?.prompt).toContain(`head of this Unit's branch (${h1})`);
    expect(w.host.server.objects.pathsAt(w.repo, h2)).not.toContain(HACK);
    const [u2] = await listUnits(s.record.pool, w.itemId);
    expect(u2).toMatchObject({ head_sha: h2, pr_ref: `pr:${prNumber}` });
    expect(
      (await listPullRequests(s.record.pool, w.itemId)).map((p) => [p.number, p.head_sha]),
    ).toEqual([[prNumber, h2]]);
    // the epoch only increased, and the grants say why each ended
    const grants = (await grantRows()) as Array<{ lease_epoch: number; release_cause: string }>;
    expect(grants.map((g) => g.release_cause)).toEqual(['replanned', expect.any(String)]);
    expect((grants[1]?.lease_epoch ?? 0) > (grants[0]?.lease_epoch ?? 0)).toBe(true);
    const history = (
      await s.record.pool.query<{ epoch: number }>(
        'SELECT epoch FROM core.lease_history WHERE unit_id = $1 ORDER BY n',
        [`${w.itemId}:main`],
      )
    ).rows.map((r) => r.epoch);
    expect([...history].sort((a, b) => a - b)).toEqual(history);

    // ---- every approval binds the new head; nothing of the old head carries over
    const rs = await results(w);
    expect(
      rs.map((r) => `${r.step}@${r.head_sha === h1 ? 'h1' : r.head_sha === h2 ? 'h2' : '?'}`),
    ).toEqual([
      '7.1@h1',
      '7.2@h1',
      '7.3@h1',
      '7.4@h1',
      '7.5@h1',
      '7.1@h2',
      '7.2@h2',
      '7.3@h2',
      '7.4@h2',
      '7.5@h2',
    ]);
    const { verifyResultHash } = await import('@aisdlc/contracts');
    for (const r of rs.filter((x) => x.head_sha === h2))
      expect(done?.state.outputs[r.step]).toBe(verifyResultHash(r));
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.map((p) => [p.disposition.kind, p.passing, p.head_sha])).toEqual([
      ['rework', false, h1],
      ['passed', true, h2],
    ]);
    expect(done?.state.outputs['7.6']).toBe(packs[1]?.pack_sha256);
    // what gate-check checks, with the Notary's public key only: the new pack passes for exactly the new head, the old
    // pack for neither
    const { checkSignedEvidencePack } = await import('@aisdlc/contracts');
    const key = s.deps.ledger?.notaryKey as never;
    const bytesOf = async (i: number) =>
      ok(await readSignedPack(w.objects, packs[i] as never)).bytes;
    expect(
      await checkSignedEvidencePack(await bytesOf(1), key, { head_sha: h2, item_id: w.itemId }),
    ).toMatchObject({
      ok: true,
    });
    expect(await checkSignedEvidencePack(await bytesOf(1), key, { head_sha: h1 })).toMatchObject({
      ok: false,
      code: 'head_mismatch',
    });
    expect(await checkSignedEvidencePack(await bytesOf(0), key, { head_sha: h2 })).toMatchObject({
      ok: false,
      code: 'head_mismatch',
    });
    expect(await checkSignedEvidencePack(await bytesOf(0), key, { head_sha: h1 })).toMatchObject({
      ok: false,
      code: 'not_passing',
    });
    const signed2 = ok(await readSignedPack(w.objects, packs[1] as never)).signed.pack;
    expect(signed2.push_receipt).toMatchObject({ head_sha: h2, pr_number: prNumber });
    // G4 was asked once, after the new pack, and its review binds the new head and that pack
    const g4 = done?.state.gates.filter((g) => g.gate === 'G4') ?? [];
    expect(g4.map((g) => g.outcome)).toEqual(['approve']);
    const { readGateState } = await import('@aisdlc/decisions');
    const g4state = await readGateState(s.record.pool, g4[0]?.gate_instance_id as string);
    const { G4_REVIEW_FACT } = await import('@aisdlc/contracts');
    const review = (g4state?.open.payload.facts as Record<string, unknown>)[G4_REVIEW_FACT] as {
      units: Array<{ head_sha: string; pack_sha256: string }>;
    };
    expect(review.units.map((u) => [u.head_sha, u.pack_sha256])).toEqual([
      [h2, packs[1]?.pack_sha256],
    ]);
    // and the read models of the push rebuild to the same rows
    const prs = await listPullRequests(s.record.pool, w.itemId);
    await rebuildPushes(s.deps, w.itemId);
    expect(await listPullRequests(s.record.pool, w.itemId)).toEqual(prs);
  });

  it('B12: a locked test the approved spec moved away from raises E6 at 7.2, chained to G3o; the 2nd time is D2', async () => {
    const w = await world({
      oracleEntry: { ...synthOracleEntry, description: 'add(2, 3) is five' },
    });
    const st = (await runItem(s, w.d, w.itemId, { stop: (x) => x.underlying === 'Handoff' }))
      ?.state;
    expect(st?.rework.by_edge['B12']).toBe(1);
    const at72 = st?.gates
      .filter((g) => g.station.startsWith('7.2!'))
      .map((g) => [g.gate, g.outcome]);
    expect(at72).toEqual([
      ['E6', 'approve'],
      ['G3o', 'approve'],
    ]);
    const r72 = (await results(w)).filter((r) => r.step === '7.2');
    expect(r72.map((r) => r.raised)).toEqual([
      { kind: 'gate', gate: 'E6', reason_code: 'locked_test_must_change' },
      { kind: 'gate', gate: 'E6', reason_code: 'locked_test_must_change' },
    ]);
    expect(st?.handoffs.at(-1)).toMatchObject({ code: 'D2', trigger: 'ET3' });
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.map((p) => p.disposition)).toEqual([
      { kind: 'handoff', trigger: 'ET3', step: '7.2', reason_code: 'b12_limit' },
    ]);
    const pack = ok(await readSignedPack(w.objects, packs[0] as never)).signed.pack;
    expect(pack.steps.map((x) => [x.step, x.met])).toEqual([
      ['7.1', true],
      ['7.2', false],
      ['7.3', false],
      ['7.4', false],
      ['7.5', false],
    ]);
    expect(pack.steps[1]?.findings.items[0]?.repair_class).toBe('locked_test_change');
  });

  it('7.6 never signs a passing pack when a step has no verdict: a kit that gave no answer is D2 (ET4)', async () => {
    const w = await world();
    // every oracle session of S7 is void (127: the command could not run): no verdict, nothing to repair
    w.s7 = (_spec, cmd) => (cmd.startsWith('npm test -- ') ? { exit_code: 127 } : undefined);
    const st = (await runItem(s, w.d, w.itemId, { stop: (x) => x.underlying === 'Handoff' }))
      ?.state;
    const packs = await listEvidencePacks(s.record.pool, w.itemId);
    expect(packs.some((p) => p.passing)).toBe(false);
    expect(packs.at(-1)?.disposition).toMatchObject({ kind: 'handoff', trigger: 'ET4' });
    expect(st?.handoffs.at(-1)).toMatchObject({ code: 'D2', trigger: 'ET4' });
  });
});
