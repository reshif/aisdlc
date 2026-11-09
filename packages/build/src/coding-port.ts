import { buildContext, primaryAgentFor, validateOutput } from '@aisdlc/agents';
import {
  CODING_BLOB_DIR,
  CODING_RESULT_FILE,
  CODING_RUNNER_PATH,
  CODING_SESSION_DIR,
  CODING_TASK_FILE,
  CodingSessionResult,
  EXEC_NOT_ALLOWED,
  type CodingTask,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import {
  StagePortError,
  checkSessionAllowed,
  type CodingPort,
  type RepoFile,
  type RunKeyLender,
  type SandboxPort,
  type SandboxRun,
  type SessionGuardDeps,
} from '@aisdlc/ports';
import {
  DEFAULT_DIFF_BUDGET,
  DEFAULT_PROTECTED_GLOBS,
  DEFAULT_SENSITIVE_GLOBS,
  evaluateTree,
  heaviest,
  nextLaneUp,
  type Tripwire,
  type TripwirePolicy,
  type TreeManifest,
} from '@aisdlc/tripwires';
import { testOneArgv } from './contract.js';
import { bindOracles, checkOracleBinding, type OracleDeviation } from './oracles.js';
import { buildHandoffPack } from './pack.js';
import type { BuildSourcePort, BuildTask, UnitPlan } from './source.js';
import { sha256, type SessionState, type SessionStore } from './store.js';

// AgentCodingPort (PLAN M13.3, M13.4): the real `CodingPort` for S6 6.1 to 6.5. 6.0 (admission) is the work
// driver's and 6.6 (the draft PR through the Push Broker) is M13.6's: both go to `fallback`.
//
//   6.1 provision/rehydrate   the session's WORKSPACE: the repo at the Unit's base commit (from the source), or the
//                             tree a snapshot kept (HUMAN-WAIT), or a cold rebuild after a quarantine's false
//                             positive. DEC-18 and B1 are checked first: a repo off the owner allow-list is BLOCKED
//                             with cause `exec_not_allowed` (never skipped), an open secret finding blocks too.
//   6.2 baseline              the task contract's `test` in an O session (no key, the mirror only) over the base
//                             tree: red or a broken environment is B6.
//   6.3 oracles red           the oracle files bound at 5.4 are added, checked against the G2-approved specs
//                             (G3o on deviation), and each must FAIL (O sessions); then locked by hash.
//   6.4 task loop             one W session per task of the Unit: the coding agent (Claude Agent SDK, in the sandbox,
//                             the Unit's key from the vault as its API key) with the factory's context as its system
//                             prompt. Tripwires stop it: ET10 (Q1), X1, X3, a locked-test change request (E6), ET8,
//                             ET1, ET2. A stopped session keeps its workspace (the snapshot).
//   6.5 self-check            tests, `check` and every oracle in O sessions over the final tree, and the tripwires
//                             again over the whole diff against the base: B7 (the failing round, with the loop it
//                             counts against), B8 (scope), R1 (budget, sensitive path, new dependency), ET11, ET12.
//
// Every outcome that stops the session builds the Handoff Pack (A11) first. The port is idempotent per command key.

export interface CodingPortDeps {
  readonly sandbox: SandboxPort;
  readonly store: SessionStore;
  readonly source: BuildSourcePort;
  readonly guard: SessionGuardDeps;
  readonly keys: RunKeyLender;
  /** 6.0 and 6.6. */
  readonly fallback: CodingPort;
  /** The locked prompt text of a prompt ref (`@aisdlc/agents/files` `readPrompt`: the files beside the bundle). */
  readonly prompt: (ref: string) => string;
  /** The gateway's model id for the coder (its route). */
  readonly model: string;
  readonly now?: () => number;
  readonly tripwires?: Partial<{
    protected_globs: readonly string[];
    sensitive_globs: readonly string[];
    diff_budget: Record<string, { max_files: number; max_lines: number }>;
  }>;
  readonly limits?: Partial<{ run_time_s: number; max_turns: number; test_time_s: number }>;
}

const STEPS_OURS = ['6.1', '6.2', '6.3', '6.4', '6.5'];

const hex = (s: string, n: number): string => sha256(s).slice(0, n);
const done = (...parts: unknown[]): StageOutcome => ({
  outcome: 'completed',
  output_hash: sha256(canonicalJson(parts as never)),
});
const rework = (
  edge: 'B6' | 'B7' | 'B8',
  reason_code: string,
  extra: { loop?: string; observed?: number } = {},
): StageOutcome => ({
  outcome: 'rework',
  edge,
  reason_code: reason_code.slice(0, 64),
  ...(extra.loop ? { loop: extra.loop } : {}),
  ...(extra.observed !== undefined ? { observed: extra.observed } : {}),
});

interface TestRun {
  readonly void_: boolean;
  readonly exit: number | null;
  readonly green: boolean;
  readonly failing: string[];
  readonly canary: boolean;
}

const failingNames = (text: string, exit: number | null): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/gm)) names.add(m[1] as string);
  for (const m of text.matchAll(/^\s*✖ (.+?)(?: \(\d[\d.]*m?s\))?$/gm)) names.add(m[1] as string);
  if (names.size === 0 && exit !== 0) names.add(`exit ${exit}`);
  return [...names].map((n) => n.slice(0, 200)).sort();
};

export class AgentCodingPort implements CodingPort {
  readonly port = 'coding' as const;

  constructor(private readonly d: CodingPortDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    if (!STEPS_OURS.includes(req.step)) return this.d.fallback.run(req);
    const prior = this.d.store.outcomeOf(req.command_key);
    if (prior !== null) return ok(prior);
    try {
      const o = await this.step(req);
      if (!(o as { transient?: boolean }).transient) this.d.store.keepOutcome(req.command_key, o);
      return ok(o);
    } catch (e) {
      // unknown whether it ran: the command is delivered again with the same key
      return err(
        StagePortError({ message: `coding ${req.step}: ${(e as Error).message}`.slice(0, 300) }),
      );
    }
  }

  private step(req: StageRequest): Promise<StageOutcome> {
    switch (req.step) {
      case '6.1':
        return this.provision(req);
      case '6.2':
        return this.baseline(req);
      case '6.3':
        return this.oracles(req);
      case '6.4':
        return this.build(req);
      default:
        return this.selfCheck(req);
    }
  }

  // ------------------------------------------------------------------------------------------ helpers

  private session(req: StageRequest): SessionState {
    const s = this.d.store.load(req.item_id);
    if (s === null) throw new Error('no session workspace: 6.1 has not provisioned it');
    return s;
  }

  private async plan(req: StageRequest): Promise<UnitPlan> {
    const p = await this.d.source.unitPlan({
      item_id: req.item_id,
      repo: req.repo,
      lane: req.lane,
    });
    if (!p.ok) throw new Error(`the Unit's plan: ${p.error.message}`);
    return p.value;
  }

  /** DEC-18 and B1 for a class, as the B6 outcome that BLOCKS the item, or null when the session may start. */
  private async blocked(req: StageRequest, cls: 'W' | 'O'): Promise<StageOutcome | null> {
    const g = await checkSessionAllowed(this.d.guard, req.repo, cls);
    if (g.ok) return null;
    if (g.error.code === 'exec_not_allowed') return rework('B6', EXEC_NOT_ALLOWED);
    if (g.error.code === 'b1_blocked') return rework('B6', 'b1_secret_finding_open');
    throw new Error(`the session guard: ${g.error.message}`);
  }

  private sid(tag: string, req: StageRequest): string {
    return `s6-${tag}-${hex(req.item_id, 8)}-${hex(req.command_key, 8)}`;
  }

  private async sandboxRun(spec: Parameters<SandboxPort['run']>[0]): Promise<SandboxRun> {
    const r = await this.d.sandbox.run(spec);
    if (!r.ok) throw new Error(`sandbox ${r.error.code}: ${r.error.message}`);
    return r.value;
  }

  /** A test run in an O session (no key, the mirror only) over a tree. */
  private async runOnce(
    req: StageRequest,
    tag: string,
    tree: string,
    argv: readonly string[],
  ): Promise<TestRun> {
    const r = await this.sandboxRun({
      session_id: this.sid(tag, req),
      class: 'O',
      command: argv,
      repo: this.d.store.filesOf(tree),
      repo_full_name: req.repo,
      limits: { time_s: this.d.limits?.test_time_s ?? 600 },
    });
    const text = `${r.stdout}\n${r.stderr}`;
    const void_ =
      r.status !== 'exited' || r.exit_code === 125 || r.exit_code === 126 || r.exit_code === 127;
    return {
      void_,
      exit: r.exit_code,
      green: !void_ && r.exit_code === 0,
      failing: void_ ? [] : failingNames(text, r.exit_code),
      canary: r.quarantined,
    };
  }

  private policyOf(
    s: SessionState,
    plan: UnitPlan,
    lane: string,
    unlocked: boolean,
  ): TripwirePolicy {
    return {
      protected_globs: [...(this.d.tripwires?.protected_globs ?? DEFAULT_PROTECTED_GLOBS)],
      sensitive_globs: [...(this.d.tripwires?.sensitive_globs ?? DEFAULT_SENSITIVE_GLOBS)],
      locked_paths: unlocked ? [] : Object.keys(s.locks),
      scope_globs: [...plan.scope_globs],
      diff_budget:
        (this.d.tripwires?.diff_budget ?? DEFAULT_DIFF_BUDGET)[lane] ??
        (DEFAULT_DIFF_BUDGET['L4'] as { max_files: number; max_lines: number }),
    };
  }

  private verdict(s: SessionState, plan: UnitPlan, lane: string, unlocked = false) {
    const store = this.d.store;
    const base = store.getTree(s.base_tree_sha256);
    const now = store.getTree(s.tree_sha256);
    return {
      base,
      now,
      v: evaluateTree(this.policyOf(s, plan, lane, unlocked), {
        base,
        now,
        before: (p) => store.textOf(s.base_tree_sha256, p),
        after: (p) => store.textOf(s.tree_sha256, p),
        locks: unlocked ? {} : s.locks,
      }),
    };
  }

  /** The Handoff Pack (A11) and a trigger outcome that carries its hash; the session stays (the snapshot is kept). */
  private trigger(
    s: SessionState,
    base: TreeManifest,
    now: TreeManifest,
    trigger: 'ET1' | 'ET2' | 'ET3' | 'ET8' | 'ET10' | 'ET11' | 'ET12',
    reason: string,
    failing: readonly string[] = [],
    questions: readonly string[] = [],
  ): StageOutcome {
    if (trigger === 'ET10') s.tainted = true;
    s.snapshot_ref = this.d.store.snapshot(s, { why: trigger, reason });
    this.d.store.save(s);
    const pack = buildHandoffPack(s, base, now, {
      trigger,
      reason_code: reason,
      failing,
      open_questions: questions,
    });
    const h = this.d.store.putRecord('handoff-pack', pack);
    return { outcome: 'trigger', trigger, reason_code: reason.slice(0, 64), output_hash: h };
  }

  // ------------------------------------------------------------------------------------------ 6.1

  private async provision(req: StageRequest): Promise<StageOutcome> {
    const plan = await this.plan(req);
    const stop = await this.blocked(req, 'W');
    if (stop) return stop;
    const store = this.d.store;
    const have = store.load(req.item_id);
    // rehydrate: the same session goes on (HUMAN-WAIT, a back-edge, an env fix): its workspace is what the last run left
    if (
      have !== null &&
      !have.tainted &&
      have.unit_key === plan.unit_key &&
      have.base_sha === plan.base_sha
    ) {
      return done('rehydrated', have.item_id, have.generation, have.tree_sha256);
    }
    const files = await this.d.source.files(req.repo, plan.base_sha);
    if (!files.ok) throw new Error(`the repo at ${plan.base_sha}: ${files.error.message}`);
    // a cold rebuild (SECT false positive) or a new plan: the old workspace is not trusted; its snapshot stays for the record
    if (have !== null)
      store.snapshot(have, { why: have.tainted ? 'tainted_cold_rebuild' : 'replaced' });
    const tree = store.putFiles(files.value);
    const s: SessionState = {
      item_id: req.item_id,
      repo: req.repo,
      unit_key: plan.unit_key,
      base_sha: plan.base_sha,
      generation: (have?.generation ?? 0) + 1,
      base_tree_sha256: tree,
      tree_sha256: tree,
      locks: {},
      oracle_ids: [],
      task_idx: 0,
      rounds: [],
      failing_history: [],
      scope_drifts: 0,
      started_ms: this.now(),
      tainted: false,
      pending_gate: null,
      approved_classes: [],
      ignored_harness: [],
      snapshot_ref: null,
      feedback: [],
      fix_round: 0,
      stage: 'provisioned',
    };
    store.save(s);
    return done('provisioned', s.item_id, s.generation, tree);
  }

  // ------------------------------------------------------------------------------------------ 6.2

  private async baseline(req: StageRequest): Promise<StageOutcome> {
    const s = this.session(req);
    const stop = await this.blocked(req, 'O');
    if (stop) return stop;
    const files = this.d.store.filesOf(s.base_tree_sha256);
    const test = this.d.source.contract(req.repo, s.base_sha, files)['test'];
    if (!test) return rework('B6', 'no_test_command');
    const r = await this.runOnce(req, '62', s.base_tree_sha256, test);
    if (r.canary) return rework('B6', 'env_broken');
    if (r.void_) return rework('B6', 'env_broken');
    if (!r.green) return rework('B6', 'red_baseline');
    s.stage = 'baselined';
    this.d.store.save(s);
    return done('baseline', s.item_id, s.base_tree_sha256);
  }

  // ------------------------------------------------------------------------------------------ 6.3

  private async oracles(req: StageRequest): Promise<StageOutcome> {
    const s = this.session(req);
    const plan = await this.plan(req);
    const stop = await this.blocked(req, 'O');
    if (stop) return stop;
    const store = this.d.store;
    const of = await this.d.source.oracleFiles({
      item_id: req.item_id,
      repo: req.repo,
      unit_key: s.unit_key,
    });
    if (!of.ok) throw new Error(`the oracle files: ${of.error.message}`);
    const repro = req.lane === 'L0';
    const bound = bindOracles(of.value);
    const deviations: OracleDeviation[] = checkOracleBinding(plan.oracles, bound, repro);

    // the oracle files join the workspace (a file already there is replaced: the bound oracle is the source of truth)
    const m = { ...store.getTree(s.base_tree_sha256) } as Record<
      string,
      { sha256: string; size: number; exec: boolean }
    >;
    for (const f of of.value) {
      const buf = Buffer.from(f.content);
      m[f.path] = { sha256: store.putBlob(buf), size: buf.length, exec: false };
    }
    const withOracles = store.putTree(m);
    const test = this.d.source.contract(req.repo, s.base_sha, store.filesOf(withOracles))['test'];
    if (!test) return rework('B6', 'no_test_command');
    // each oracle must FAIL first: an assertion failure is exit 1; anything else that is not green is a broken environment
    for (const f of of.value) {
      const r = await this.runOnce(
        req,
        `63-${hex(f.path, 4)}`,
        withOracles,
        testOneArgv(test, f.path),
      );
      if (r.canary || r.void_ || (r.exit !== 0 && r.exit !== 1)) return rework('B6', 'env_broken');
      if (r.green) {
        const b = bound.find((x) => x.path === f.path);
        deviations.push({ kind: 'oracle_not_red', oracle_id: b?.oracle_id ?? null, path: f.path });
      }
    }
    s.tree_sha256 = withOracles;
    s.locks = Object.fromEntries(of.value.map((f) => [f.path, sha256(f.content)]));
    s.oracle_ids = repro ? ['repro'] : plan.oracles.map((o) => o.oracle_id);
    s.stage = 'oracles_red';
    store.save(s);
    if (deviations.length > 0) {
      const record = store.putRecord('oracle-deviation', {
        item_id: s.item_id,
        unit_key: s.unit_key,
        approved: plan.oracles,
        bound,
        deviations,
      });
      if (req.denied_gates.includes('G3o')) {
        return this.trigger(
          s,
          store.getTree(s.base_tree_sha256),
          store.getTree(s.tree_sha256),
          'ET8',
          'oracle_deviation_denied',
          [],
          [`G3o was denied for ${deviations.length} oracle deviations`],
        );
      }
      return {
        outcome: 'gate_needed',
        gate: 'G3o',
        reason_code: 'oracle_deviation',
        output_hash: record,
      };
    }
    return done('oracles_red', s.item_id, s.locks);
  }

  // ------------------------------------------------------------------------------------------ 6.4

  private taskPrompt(s: SessionState, plan: UnitPlan, task: BuildTask | null): string {
    const parts: string[] = [];
    if (task) parts.push(`Task ${task.task_id}: ${task.title}\n\n${task.instructions}`);
    else
      parts.push(
        'Fix what the self-check found. Make the smallest change that turns the failing tests green.',
      );
    if (s.oracle_ids.length > 0)
      parts.push(
        `The oracle tests (${s.oracle_ids.join(', ')}) are locked: do not edit them. They must pass when you are done.`,
      );
    if (s.feedback.length > 0)
      parts.push(`Feedback from the factory:\n${s.feedback.map((f) => `- ${f}`).join('\n')}`);
    parts.push(
      `Work only inside the Unit's scope${plan.scope_globs.length ? ` (${plan.scope_globs.join(', ')})` : ''}. When you are done answer with ONE JSON object of the schema implementation.v1.`,
    );
    return parts.join('\n\n');
  }

  private async build(req: StageRequest): Promise<StageOutcome> {
    const store = this.d.store;
    const s = this.session(req);
    if (s.tainted) throw new Error('the session is tainted: only a cold rebuild (6.1) may go on');
    const plan = await this.plan(req);
    const stop = await this.blocked(req, 'W');
    if (stop) return stop;
    const agent = req.agent;
    const def = primaryAgentFor('6.4');
    if (!agent || !def) throw new Error('6.4 needs the coder bound to the command');
    // gates approved earlier at this step: X1 and X3 let the session do the thing once; E6 then G3o let it change the locked tests
    if (req.approved_gates.includes('X1') && !s.approved_classes.includes('gate_x1'))
      s.approved_classes.push('gate_x1');
    if (req.approved_gates.includes('X3') && !s.approved_classes.includes('gate_x3'))
      s.approved_classes.push('gate_x3');
    const unlocked = req.approved_gates.includes('E6') && req.approved_gates.includes('G3o');
    if (
      req.denied_gates.includes('X3') &&
      !s.feedback.includes('A new dependency was refused: find an alternative that adds none.')
    ) {
      s.feedback.push('A new dependency was refused: find an alternative that adds none.');
    }
    s.pending_gate = null;
    s.stage = 'building';

    const ctxInputs = await this.d.source.context({
      item_id: req.item_id,
      repo: req.repo,
      base_sha: s.base_sha,
    });
    if (!ctxInputs.ok) throw new Error(`the affirmed context: ${ctxInputs.error.message}`);
    const ctx = buildContext({
      ...ctxInputs.value,
      agent_id: 'coder',
      purpose: 'item',
      merged_sha: s.base_sha,
    });
    const system = `${this.d.prompt(def.prompt.ref)}\n\n${ctx.text}`;
    const tools = agent.tools.filter((t) => t !== 'KnowledgeSearch');

    const total = plan.tasks.length;
    const fixMode = s.fix_round > 0 && s.task_idx >= total;
    for (let guard = 0; guard < 64; guard++) {
      const task = fixMode ? null : (plan.tasks[s.task_idx] ?? null);
      if (!fixMode && task === null) break;
      const policy = this.policyOf(s, plan, req.lane, unlocked);
      const spec: CodingTask = {
        schema: 'coding-task/1',
        model: this.d.model,
        system_prompt: system,
        prompt: this.taskPrompt(s, plan, task),
        allowed_tools: tools,
        max_turns: this.d.limits?.max_turns ?? 40,
        time_s: this.d.limits?.run_time_s ?? 1800,
        policy: {
          protected_globs: [...policy.protected_globs],
          sensitive_globs: [...policy.sensitive_globs],
          locked_paths: [...policy.locked_paths],
          scope_globs: [...policy.scope_globs],
          diff_budget: { ...policy.diff_budget },
        },
        approved_classes: [...s.approved_classes],
      };
      const files: RepoFile[] = [
        ...store.filesOf(s.tree_sha256),
        { path: `${CODING_SESSION_DIR}/${CODING_TASK_FILE}`, content: JSON.stringify(spec) },
      ];
      // the Unit's key is lent for the length of the run and goes nowhere else: the driver sets it as the sandbox's gateway key env
      const ran = await this.d.keys.lend(agent.run_id, (secret) =>
        this.sandboxRun({
          session_id: this.sid(`64-${guard}`, req),
          class: 'W',
          command: ['node', CODING_RUNNER_PATH],
          repo: files,
          repo_full_name: req.repo,
          gateway_key: secret,
        }),
      );
      if (ran === null)
        throw new Error(
          'no run key held for this command: it is delivered again and a new key is minted',
        );
      const taskId = task?.task_id ?? `fix-${s.fix_round}`;
      const before = store.getTree(s.base_tree_sha256);

      if (ran.quarantined) {
        s.rounds.push({
          round: s.rounds.length + 1,
          task_id: taskId,
          tree_sha256: s.tree_sha256,
          failing: [],
          note: 'a factory canary came out of the sandbox',
        });
        return this.trigger(
          s,
          before,
          store.getTree(s.tree_sha256),
          'ET10',
          'secret_access',
          [],
          ['a canary was found in the sandbox output'],
        );
      }
      if (ran.status === 'timed_out')
        return this.trigger(s, before, store.getTree(s.tree_sha256), 'ET2', 'session_time');
      if (ran.status !== 'exited') throw new Error(`the coding session was void (${ran.status})`);
      const file = ran.out.find((f) => f.path === CODING_RESULT_FILE);
      const parsed = file
        ? CodingSessionResult.safeParse(safeJson(Buffer.from(file.content).toString('utf8')))
        : null;
      if (!parsed || !parsed.success)
        throw new Error('the coding session returned no valid result');
      const res = parsed.data;

      // merge what changed (each blob checked against the hash the runner named: the runner's word is not enough)
      const m = { ...store.getTree(s.tree_sha256) } as Record<
        string,
        { sha256: string; size: number; exec: boolean }
      >;
      const blobs = new Map(
        ran.out
          .filter((f) => f.path.startsWith(`${CODING_BLOB_DIR}/`))
          .map((f) => [f.path.slice(CODING_BLOB_DIR.length + 1), f]),
      );
      for (const c of res.changed) {
        const b = blobs.get(c.sha256);
        if (!b || b.sha256 !== c.sha256)
          throw new Error(`the runner reported ${c.path} without its blob`);
        store.putBlob(Buffer.from(b.content));
        m[c.path] = { sha256: c.sha256, size: c.size, exec: c.exec };
      }
      for (const p of res.deleted) delete m[p];
      // E6 then G3o were approved: the oracle tests may now change, and what they changed to is locked again (the deviation was decided)
      if (unlocked) {
        for (const p of Object.keys(s.locks)) {
          const e = m[p];
          if (e === undefined) delete s.locks[p];
          else s.locks[p] = e.sha256;
        }
      }
      s.tree_sha256 = store.putTree(m);
      s.ignored_harness = res.ignored_harness;

      // the factory's own look at the tree, beside what the runner said
      const { now, v } = this.verdict(s, plan, req.lane, unlocked);
      const reported: Tripwire[] = res.tripwire
        ? [
            {
              kind: res.tripwire.kind,
              class: res.tripwire.class,
              detail: res.tripwire.detail,
              ...(res.tripwire.path ? { path: res.tripwire.path } : {}),
            },
          ]
        : [];
      const trips: Tripwire[] = [...reported, ...v.tripwires];
      if (res.key_on_disk)
        trips.push({
          kind: 'secret_access',
          class: 'quarantine',
          detail: 'the session key was found on disk',
        });
      const worst = heaviest(
        trips.filter((t) => ['quarantine', 'gate_x1', 'gate_x3'].includes(t.class)),
      );
      s.rounds.push({
        round: s.rounds.length + 1,
        task_id: taskId,
        tree_sha256: s.tree_sha256,
        failing: [],
        note: worst ? `stopped: ${worst.detail}` : `session ${res.status}, ${res.turns} turns`,
      });
      if (worst?.class === 'quarantine')
        return this.trigger(s, before, now, 'ET10', worst.kind, [], [worst.detail]);
      if (worst?.class === 'gate_x1' || worst?.class === 'gate_x3') {
        s.pending_gate = worst.class === 'gate_x1' ? 'X1' : 'X3';
        store.save(s);
        return { outcome: 'gate_needed', gate: s.pending_gate, reason_code: worst.kind };
      }
      if (res.status === 'budget') return this.trigger(s, before, now, 'ET1', 'budget_exhausted');
      if (res.status === 'timeout') return this.trigger(s, before, now, 'ET2', 'session_time');
      if (res.status === 'error')
        throw new Error(`the coding session failed: ${res.error ?? 'unknown'}`);

      const out = parseImplementation(res.final_text);
      if (out === null)
        s.feedback = [
          ...s.feedback.filter((f) => !f.startsWith('Your last answer')),
          'Your last answer was not one valid implementation.v1 JSON object.',
        ].slice(-8);
      else if (out.status === 'gave_up')
        return this.trigger(s, before, now, 'ET8', 'agent_gave_up', [], [out.summary]);
      else if (out.status === 'blocked') {
        const reason = out.blocker?.reason ?? 'other';
        if (reason === 'irreversible_operation') {
          s.pending_gate = 'X1';
          store.save(s);
          return { outcome: 'gate_needed', gate: 'X1', reason_code: 'agent_blocked' };
        }
        if (reason === 'new_dependency') {
          s.pending_gate = 'X3';
          store.save(s);
          return { outcome: 'gate_needed', gate: 'X3', reason_code: 'agent_blocked' };
        }
        if (reason === 'locked_test_change') {
          s.pending_gate = 'E6';
          store.save(s);
          return { outcome: 'gate_needed', gate: 'E6', reason_code: 'locked_test_change' };
        }
        if (reason === 'scope_exceeded') {
          // B8 is drawn from 6.5: the drift is recorded and the self-check raises it
          s.scope_drifts += 1;
          s.task_idx = total;
          break;
        }
        return this.trigger(
          s,
          before,
          now,
          'ET8',
          'agent_blocked',
          [],
          [out.blocker?.detail ?? out.summary],
        );
      }
      s.feedback = s.feedback.filter((f) => !f.startsWith('Your last answer'));
      if (fixMode) break;
      s.task_idx += 1;
      store.save(s);
    }
    s.stage = 'built';
    store.save(s);
    return done('built', s.item_id, s.tree_sha256, s.task_idx);
  }

  // ------------------------------------------------------------------------------------------ 6.5

  private async selfCheck(req: StageRequest): Promise<StageOutcome> {
    const store = this.d.store;
    const s = this.session(req);
    const plan = await this.plan(req);
    const stop = await this.blocked(req, 'O');
    if (stop) return stop;
    const files = store.filesOf(s.tree_sha256);
    const contract = this.d.source.contract(req.repo, s.base_sha, files);
    const { base, now, v } = this.verdict(s, plan, req.lane);

    // 1. misbehaviour the tree shows (the runner may have been tampered with: the factory looks again)
    const q = v.tripwires.find((t) => t.class === 'quarantine');
    if (q) return this.trigger(s, base, now, 'ET10', q.kind, [], [q.detail]);

    // 2. the diff left the Unit's scope: B8 (split the Unit, G3 again); the second time the engine goes to D1 (ET9)
    const drift = v.tripwires.find((t) => t.class === 'scope');
    if (drift || s.scope_drifts > 0) {
      s.scope_drifts = Math.max(1, s.scope_drifts);
      store.save(s);
      return rework('B8', 'scope_drift');
    }

    // 3. the work outgrew its lane (R1, free and logged): a diff over the budget, a sensitive path, a new dependency
    const r1 = v.tripwires.find(
      (t) =>
        t.class === 'relane_r1' ||
        (t.class === 'gate_x3' && !s.approved_classes.includes('gate_x3')),
    );
    if (r1) {
      const to = nextLaneUp(req.lane);
      if (to === null) return this.trigger(s, base, now, 'ET8', 'lane_outgrown', [], [r1.detail]);
      const kind =
        r1.kind === 'new_dependency'
          ? 'new_dependency'
          : r1.kind === 'sensitive_path'
            ? 'sensitive_path'
            : 'diff_over_lane_budget';
      return {
        outcome: 'relane',
        edge: 'R1',
        trigger: kind,
        to_lane: to as never,
        reason_code: kind,
      };
    }

    // 4. the tests: the contract's `test` and `check`, and every oracle on its own, in O sessions with no key
    const failing: string[] = [];
    let voidRun = false;
    const test = contract['test'];
    if (!test) return rework('B6', 'no_test_command');
    const t = await this.runOnce(req, '65t', s.tree_sha256, test);
    if (t.canary)
      return this.trigger(
        s,
        base,
        now,
        'ET10',
        'secret_access',
        [],
        ['a canary was found in a test run'],
      );
    voidRun ||= t.void_;
    failing.push(...t.failing);
    const check = contract['check'];
    if (check && !sameArgv(check, test)) {
      const c = await this.runOnce(req, '65c', s.tree_sha256, check);
      voidRun ||= c.void_;
      failing.push(...c.failing.map((f) => `check: ${f}`));
    }
    for (const path of Object.keys(s.locks)) {
      const o = await this.runOnce(
        req,
        `65o-${hex(path, 4)}`,
        s.tree_sha256,
        testOneArgv(test, path),
      );
      voidRun ||= o.void_;
      if (!o.green) failing.push(`oracle ${path}`);
    }
    if (voidRun) return rework('B6', 'env_broken');
    const red = [...new Set(failing)].sort();

    if (red.length === 0) {
      s.stage = 'checked';
      s.failing_history.push([]);
      store.save(s);
      return done('checked', s.item_id, s.tree_sha256, v.files_changed, v.lines_changed);
    }

    // red: ET12 (the same tree answers differently), ET11 (back and forth), then B7 with the loop it counts against
    const again = await this.runOnce(req, '65r', s.tree_sha256, test);
    if (again.green || JSON.stringify(again.failing) !== JSON.stringify(t.failing)) {
      return this.trigger(s, base, now, 'ET12', 'unstable_tests', red);
    }
    const h = s.failing_history;
    const last = h[h.length - 1];
    h.push(red);
    const [a, b, c] = h.slice(-3);
    if (
      a &&
      b &&
      c &&
      JSON.stringify(a) === JSON.stringify(c) &&
      JSON.stringify(a) !== JSON.stringify(b)
    ) {
      store.save(s);
      return this.trigger(s, base, now, 'ET11', 'oscillation', red);
    }
    const sameAsLast = last !== undefined && JSON.stringify(last) === JSON.stringify(red);
    s.rounds.push({
      round: s.rounds.length + 1,
      task_id: `check-${s.fix_round}`,
      tree_sha256: s.tree_sha256,
      failing: red,
      note: 'self-check failed',
    });
    s.fix_round += 1;
    s.feedback = [`The self-check failed: ${red.slice(0, 10).join('; ')}`];
    s.task_idx = plan.tasks.length;
    s.stage = 'building';
    store.save(s);
    const elapsed = this.now() - s.started_ms;
    const multiple = plan.estimate_ms > 0 ? elapsed / plan.estimate_ms : 0;
    if (multiple >= 2)
      return rework('B7', 'check_failed', { loop: 'et2_time_multiple', observed: multiple });
    return rework('B7', 'check_failed', { loop: sameAsLast ? 'et3_rounds' : 'et2_ci_rounds' });
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

interface Impl {
  readonly status: 'completed' | 'blocked' | 'gave_up';
  readonly summary: string;
  readonly blocker?: { reason: string; detail: string };
}

/** The agent's final answer: one implementation.v1 object, validated by the registry; anything else is `null` (untrusted text, not an outcome). */
function parseImplementation(text: string): Impl | null {
  const t = text.trim();
  const body = t.startsWith('{') ? t : (/```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1] ?? '').trim();
  const j = safeJson(body);
  if (j === null) return null;
  const v = validateOutput('coder', j);
  return v.ok ? (v.value as Impl) : null;
}
