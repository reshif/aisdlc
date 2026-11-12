import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CODING_BLOB_DIR,
  CODING_RESULT_FILE,
  CODING_SESSION_DIR,
  CODING_TASK_FILE,
  CodingTask,
  type CodingSessionResult,
  type SessionTripwire,
} from '@aisdlc/contracts';
import { maskSecrets, scanText } from '@aisdlc/secrets-rules';
import {
  addedDependencies,
  classifyCommand,
  diffManifests,
  heaviest,
  isManifest,
  isTreePath,
  readTripwire,
  stubReason,
  writeTripwire,
  type TreeManifest,
  type Tripwire,
  type TripwirePolicy,
} from '@aisdlc/tripwires';
import { query, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk';
import { harnessFilesIn, sessionEnv } from './session.js';

// The coding runner (PLAN M13.4): the process the W sandbox runs. It is the harness around the Claude Agent SDK
// and nothing the repository can configure:
//
//   - `settingSources: []`: the harness loads NO filesystem settings (no CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`,
//     hooks) from the repo, the home directory or anywhere else (LF4, harness isolation). What the repo carries of
//     them is listed as ignored. The system prompt is the factory's (`buildContext`), the tools are the contract's.
//   - the base URL is the gateway's `/v1/messages` and the API key is the Unit's virtual key, given to the harness
//     process as its environment variable and to nothing else: it is never written to a file, a log or `/out`
//     (the runner looks for it in /work, /tmp and /out when it is done and says so).
//   - every tool call passes a PreToolUse hook: a write to a protected path, an edit of a locked test, a read of a
//     credential, the hunt for credentials, a destructive command, a new dependency. The first of them stops the
//     session: the call is denied, the harness is aborted, and the result names the tripwire (the factory decides
//     what it means: ET10 -> Q1, X1, X3).
//   - the result and the files that changed go to `/out`, which the driver ships back as ONE tar.
//
// Everything this process says about itself is untrusted by the factory, which checks the returned tree again.

const MAX_FILE = 8 * 1024 * 1024;
const MAX_OUT_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 5_000;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function walk(root: string): TreeManifest {
  const out: Record<string, { sha256: string; size: number; exec: boolean }> = {};
  const rec = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split('\\').join('/');
      if (!isTreePath(rel)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) rec(abs);
      else if (st.isFile()) {
        if (st.size > MAX_FILE) {
          out[rel] = {
            sha256: `big:${st.size}:${st.mtimeMs}`.padEnd(64, '0').slice(0, 64),
            size: st.size,
            exec: false,
          };
          continue;
        }
        out[rel] = { sha256: sha(readFileSync(abs)), size: st.size, exec: (st.mode & 0o111) !== 0 };
      }
    }
  };
  rec(root);
  return out;
}

/** Files under `dir` (any depth) that contain `needle`, by name. Binary files are searched too. */
function filesContaining(dirs: string[], needles: string[]): string[] {
  const hits: string[] = [];
  const rec = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const abs = join(dir, n);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) rec(abs);
      else if (st.isFile() && st.size <= 32 * 1024 * 1024) {
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        const t = buf.toString('latin1');
        if (needles.some((x) => t.includes(x))) hits.push(abs);
      }
    }
  };
  for (const d of dirs) rec(d);
  return hits;
}

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function main(): void {
  const root = process.cwd();
  const sessionDir = join(root, CODING_SESSION_DIR);
  const parked = '/work/.session';
  const taskPath = join(parked, CODING_TASK_FILE);
  mkdirSync('/work', { recursive: true });
  const key = process.env['AISDLC_GATEWAY_KEY'] ?? '';
  // an empty or short key would match everywhere: only a real key is scrubbed
  const scrub = (t: string): string => (key.length >= 8 ? t.split(key).join('[key]') : t);
  const gatewayUrl = process.env['AISDLC_GATEWAY_URL'] ?? 'http://gateway:8410';

  const fail = (status: CodingSessionResult['status'], error: string): never => {
    const r: CodingSessionResult = {
      schema: 'coding-session/1',
      status,
      tripwire: null,
      final_text: '',
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_events: [],
      ignored_harness: [],
      setting_sources: [],
      key_on_disk: false,
      error: cap(scrub(error), 400),
      changed: [],
      deleted: [],
      changes_truncated: false,
    };
    mkdirSync('/out', { recursive: true });
    writeFileSync(join('/out', CODING_RESULT_FILE), JSON.stringify(r));
    process.exit(0);
  };

  if (key === '') return fail('error', 'no gateway key in the environment');
  if (!existsSync(sessionDir)) return fail('error', 'no task in the repo copy');
  try {
    rmSync(parked, { recursive: true, force: true });
    renameSync(sessionDir, parked);
  } catch (e) {
    return fail('error', `cannot park the task: ${(e as Error).message}`);
  }
  const parsed = CodingTask.safeParse(JSON.parse(readFileSync(taskPath, 'utf8')));
  if (!parsed.success) return fail('error', 'the task does not validate');
  const task = parsed.data;
  const policy: TripwirePolicy = task.policy;

  const base = walk(root);
  const ignoredHarness = harnessFilesIn(Object.keys(base));
  const textOf = (rel: string): string | null => {
    try {
      return readFileSync(join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const toolEvents: CodingSessionResult['tool_events'] = [];
  let stopped: Tripwire | null = null;
  // P1-8: the command line of a Bash call that stopped the session (masked; the key never), for the X1 card
  let stoppedCommand: string | null = null;
  let timedOut = false;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, task.time_s * 1000);

  const relPath = (p: string): string => {
    const abs = resolve(root, p);
    return abs === root || abs.startsWith(`${root}/`) ? relative(root, abs) : abs;
  };
  const summarise = (tool: string, input: Record<string, unknown>): string => {
    const raw = String(
      input['command'] ?? input['file_path'] ?? input['path'] ?? input['pattern'] ?? '',
    );
    const s = cap(raw.replace(/\s+/g, ' '), 160);
    return scanText(s).length > 0 || (key !== '' && s.includes(key)) ? `${tool}: [redacted]` : s;
  };

  /** The factory's judgement of one tool call (from the hook, and again from the model's own message: the harness may refuse a call before any hook sees it). */
  const judged = new Map<string, { worst: Tripwire | null; live: boolean }>();
  const judge = (
    tool: string,
    ti: Record<string, unknown>,
    id: string,
  ): { worst: Tripwire | null; live: boolean } => {
    const cached = judged.get(id);
    if (cached) return cached;
    const trips: Tripwire[] = [];
    const str = (k: string): string => (typeof ti[k] === 'string' ? (ti[k] as string) : '');
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const rel = relPath(str('file_path') || str('notebook_path'));
      const w = writeTripwire(policy, rel);
      if (w) trips.push(w);
      if (!w) {
        const before = textOf(rel);
        let after: string | null = null;
        if (tool === 'Write') after = str('content');
        else if (tool === 'Edit' && before !== null && str('old_string') !== '') {
          after = before.split(str('old_string')).join(str('new_string'));
        }
        if (after !== null) {
          if (isManifest(rel)) {
            const gained = addedDependencies(rel, before, after);
            if (gained.length > 0) {
              trips.push({
                kind: 'new_dependency',
                class: 'gate_x3',
                detail: `${rel} gains ${gained.slice(0, 5).join(', ')}`,
                path: rel,
              });
            }
          }
          if (tool === 'Write') {
            const stub = stubReason(rel, after);
            if (stub !== null)
              trips.push({ kind: 'stub_test', class: 'quarantine', detail: stub, path: rel });
          }
        }
      }
    } else if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
      const r = readTripwire(relPath(str('file_path') || str('path') || str('pattern')));
      if (r) trips.push(r);
    } else if (tool === 'Bash') {
      trips.push(...classifyCommand(str('command')));
    }
    const worst = heaviest(trips);
    // an approved gate (X1, X3) is a decision a person already made for this task: the call goes through, and is logged
    const approvedClass = (c: string): boolean => (task.approved_classes as string[]).includes(c);
    const live =
      worst !== null &&
      ['quarantine', 'gate_x1', 'gate_x3'].includes(worst.class) &&
      !approvedClass(worst.class);
    toolEvents.push({
      tool: cap(tool, 60),
      summary: live ? cap(`${tool}: ${worst.detail}`, 240) : summarise(tool, ti),
      verdict: live ? 'denied' : 'allowed',
    });
    if (live && stopped === null) {
      stopped = worst;
      if (tool === 'Bash' && worst.class !== 'quarantine') {
        const cmd = cap(
          scrub(maskSecrets(str('command')).text)
            .replace(/\s+/g, ' ')
            .trim(),
          500,
        );
        stoppedCommand = cmd === '' ? null : cmd;
      }
      // nothing after this tripwire is asked for: the result is written and the process ends, the harness with it
      setImmediate(() => finalize());
    }
    const verdict = { worst, live };
    judged.set(id, verdict);
    return verdict;
  };

  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const { live } = judge(
      input.tool_name,
      (input.tool_input ?? {}) as Record<string, unknown>,
      input.tool_use_id,
    );
    return live
      ? {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'stopped by the factory',
          },
        }
      : {};
  };

  const options: Options = {
    cwd: root,
    // LF4: the harness loads nothing from the filesystem. The factory's context is the system prompt, nothing else.
    settingSources: [],
    systemPrompt: task.system_prompt,
    tools: task.allowed_tools,
    allowedTools: task.allowed_tools,
    permissionMode: 'dontAsk',
    maxTurns: task.max_turns,
    model: task.model,
    persistSession: false,
    strictMcpConfig: true,
    mcpServers: {},
    abortController: abort,
    pathToClaudeCodeExecutable: process.env['AISDLC_AGENT_BIN'] ?? '/opt/agent/claude',
    env: sessionEnv({
      gatewayUrl,
      gatewayKey: key,
      home: '/work/home',
      path: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    }),
    hooks: { PreToolUse: [{ hooks: [pre] }] },
  };

  let status: CodingSessionResult['status'] = 'finished';
  let finalText = '';
  let turns = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let error: string | null = null;
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    if (stopped !== null) status = 'tripwire';
    else if (timedOut) status = 'timeout';

    // ---- what changed (the factory checks it again against its own copy)
    const now = walk(root);
    const d = diffManifests(base, now);
    const changed: CodingSessionResult['changed'] = [];
    let bytes = 0;
    let truncated = false;
    mkdirSync(join('/out', CODING_BLOB_DIR), { recursive: true });
    for (const p of [...d.added, ...d.modified]) {
      const e = now[p];
      if (e === undefined) continue;
      if (
        e.sha256.startsWith('big:') ||
        changed.length >= MAX_FILES ||
        bytes + e.size > MAX_OUT_BYTES
      ) {
        truncated = true;
        continue;
      }
      const blob = join('/out', CODING_BLOB_DIR, e.sha256);
      if (!existsSync(blob)) {
        copyFileSync(join(root, p), blob);
        bytes += e.size;
      }
      changed.push({ path: p, sha256: e.sha256, size: e.size, exec: e.exec });
    }

    // ---- the key never touched a disk: look for it (and its tail) where this process and its children could have written
    const needles = [key, key.slice(-20)].filter((x) => x.length >= 8);
    mkdirSync('/out', { recursive: true });
    writeFileSync(join('/out', 'probe'), '');
    rmSync(join('/out', 'probe'));
    const keyHits = filesContaining(['/work', '/tmp', '/out'], needles);

    const result: CodingSessionResult = {
      schema: 'coding-session/1',
      status,
      tripwire:
        stopped === null
          ? null
          : ({
              ...stopped,
              ...(stoppedCommand !== null ? { command: stoppedCommand } : {}),
            } as SessionTripwire),
      final_text: cap(scrub(finalText), 60_000),
      turns,
      usage,
      tool_events: toolEvents.slice(0, 2000),
      ignored_harness: ignoredHarness.slice(0, 200),
      setting_sources: [],
      key_on_disk: keyHits.length > 0,
      error,
      changed,
      deleted: d.deleted.slice(0, 20_000),
      changes_truncated: truncated,
    };
    writeFileSync(join('/out', CODING_RESULT_FILE), JSON.stringify(result));
    process.exit(0);
  };

  void (async () => {
    try {
      mkdirSync('/work/home', { recursive: true });
      for await (const m of query({ prompt: task.prompt, options })) {
        if (m.type === 'assistant') {
          turns += 1;
          for (const blk of (m.message?.content ?? []) as Array<{
            type: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>) {
            if (blk.type === 'tool_use' && blk.name)
              judge(
                blk.name,
                (blk.input ?? {}) as Record<string, unknown>,
                blk.id ?? `${turns}:${blk.name}`,
              );
          }
        }
        if (m.type === 'result') {
          usage.input_tokens = m.usage?.input_tokens ?? 0;
          usage.output_tokens = m.usage?.output_tokens ?? 0;
          if (m.subtype === 'success') finalText = typeof m.result === 'string' ? m.result : '';
          else {
            const detail = JSON.stringify((m as { errors?: unknown }).errors ?? m.subtype);
            status = /budget|spend|exhaust|quota|\b402\b|\b429\b/i.test(detail)
              ? 'budget'
              : 'error';
            error = cap(scrub(detail), 400);
          }
          if (m.is_error && status === 'finished') {
            const t =
              typeof (m as { result?: unknown }).result === 'string'
                ? (m as { result: string }).result
                : '';
            status = /budget|spend|exhaust|quota|\b402\b|\b429\b/i.test(t) ? 'budget' : 'error';
            error = cap(scrub(t), 400);
          }
        }
      }
    } catch (e) {
      if (stopped === null && !timedOut) {
        status = 'error';
        error = cap(scrub(String((e as Error).message ?? e)), 400);
      }
    }
    finalize();
  })();
}

main();
