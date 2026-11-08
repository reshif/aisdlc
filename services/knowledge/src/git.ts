import { spawn, type ChildProcess } from 'node:child_process';
import type { ScanError } from '@aisdlc/contracts';

// The hardened git runner (PLAN M6.1; OB §5.6 "hardened bare copy", §6.5 "Bytes flow", DEC-5).
//
// Everything the knowledge service does to a repository goes through here. Repo content is data:
// git only reads objects (`cat-file --batch`, `rev-list`, `ls-tree`, `log --raw`), never checks
// anything out, and runs with:
//   - no system or global config, HOME in the job directory, no prompts, no pager;
//   - hooks off (core.hooksPath=/dev/null), no credential helper, no fsmonitor, no gc;
//   - protocol.allow=never (the single call that reads the bundle file adds protocol.file.allow);
//   - transfer.fsckObjects=true, so a malformed object refuses the bundle;
//   - LFS smudge/clean/process filters emptied and not required, submodule recursion off,
//     replace objects ignored, and an explicit --git-dir (safe.bareRepository=explicit);
// and every child runs in its own process group, so a deadline kills it and anything it started.
// No code-host credential and no HMAC key exist in this process (DEC-5 condition 1).

/** A failure the scan maps to `scan_status: error` (never to "clean"). */
export class ScanFailure extends Error {
  override readonly name = 'ScanFailure';
  constructor(
    readonly code: ScanError['code'],
    message: string,
    /** The git object the failure was about, if one is known. */
    readonly object: string | null = null,
  ) {
    super(message);
  }
}

export interface GitOptions {
  /** `git` unless a test puts a wrapper in front of it. */
  readonly gitBin?: string;
  /** The job's private HOME. */
  readonly home: string;
  /** Aborted at the job deadline: every child is killed and later calls refuse. */
  readonly signal: AbortSignal;
}

export interface RunOptions {
  /** A bare repository, passed as `--git-dir`. */
  readonly gitDir?: string;
  /** The one call that reads the bundle file needs the `file` transport. */
  readonly allowFile?: boolean;
  /** Stdout beyond this is a failure, not silent truncation. Default 64 MiB. */
  readonly maxStdout?: number;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const STDERR_LIMIT = 8 * 1024;
const STDOUT_LIMIT = 64 * 1024 * 1024;

const CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['credential.helper', ''],
  ['protocol.allow', 'never'],
  ['transfer.fsckObjects', 'true'],
  ['fetch.fsckObjects', 'true'],
  ['receive.fsckObjects', 'true'],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.clean', ''],
  ['filter.lfs.process', ''],
  ['filter.lfs.required', 'false'],
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['safe.bareRepository', 'explicit'],
  ['log.showSignature', 'false'],
  ['diff.external', ''],
  ['core.pager', 'cat'],
];

/** The environment of every git child: nothing from the machine except where `git` is. */
export function hardenedEnv(home: string, allowFile: boolean): Record<string, string> {
  const cfg = [...CONFIG, ...(allowFile ? ([['protocol.file.allow', 'always']] as const) : [])];
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_PAGER: 'cat',
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // A negative pid is the process group the child leads (it was spawned `detached`).
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export class Git {
  private readonly live = new Set<ChildProcess>();
  private readonly bin: string;

  constructor(private readonly o: GitOptions) {
    this.bin = o.gitBin ?? 'git';
    o.signal.addEventListener('abort', () => this.killAll(), { once: true });
  }

  /** Children still running (a leak check: zero after a job). */
  liveCount(): number {
    return this.live.size;
  }

  killAll(): void {
    for (const c of this.live) killGroup(c);
  }

  private refuseIfAborted(): void {
    if (this.o.signal.aborted) throw new ScanFailure('timeout', 'the job time cap was reached');
  }

  /** Starts a tracked git child (own process group). The caller reads and ends it. */
  start(args: readonly string[], opts: RunOptions = {}): ChildProcess {
    this.refuseIfAborted();
    const full = [...(opts.gitDir === undefined ? [] : [`--git-dir=${opts.gitDir}`]), ...args];
    const child = spawn(this.bin, full, {
      cwd: this.o.home,
      env: hardenedEnv(this.o.home, opts.allowFile === true),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.live.add(child);
    child.once('close', () => this.live.delete(child));
    child.once('error', () => this.live.delete(child));
    child.stdin?.on('error', () => undefined);
    return child;
  }

  /** Runs git to completion with no stdin. A non-zero exit is returned, not thrown. */
  run(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.start(args, opts);
      } catch (e) {
        return reject(e);
      }
      child.stdin?.end();
      const limit = opts.maxStdout ?? STDOUT_LIMIT;
      const out: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => {
        size += b.length;
        if (size > limit) {
          overflow = true;
          killGroup(child);
        } else out.push(b);
      });
      child.stderr?.on('data', (b: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += b.toString('utf8');
      });
      child.once('error', () => reject(new ScanFailure('git_failed', 'git could not be run')));
      child.once('close', (code) => {
        if (this.o.signal.aborted)
          return reject(new ScanFailure('timeout', 'the job time cap was reached'));
        if (overflow) return reject(new ScanFailure('git_failed', 'git produced too much output'));
        resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr });
      });
    });
  }

  /** Runs git and requires exit 0; anything else is a `git_failed` failure. */
  async must(what: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    const r = await this.run(args, opts);
    if (r.code !== 0) {
      throw new ScanFailure('git_failed', `git ${what} exited ${r.code}: ${firstLine(r.stderr)}`);
    }
    return r;
  }
}

/** First line of git's stderr, bounded. Git's own messages name objects and paths, never contents. */
export const firstLine = (s: string): string => s.trim().split('\n')[0]?.slice(0, 200) ?? '';

/** Splits a stream of chunks at NUL bytes. `carry` is the unfinished token between chunks. */
export class NulSplitter {
  private carry: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, onToken: (t: Buffer) => void): void {
    let start = 0;
    for (let i = chunk.indexOf(0, start); i !== -1; i = chunk.indexOf(0, start)) {
      const part = chunk.subarray(start, i);
      onToken(this.carry.length === 0 ? part : Buffer.concat([this.carry, part]));
      this.carry = Buffer.alloc(0);
      start = i + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.carry = this.carry.length === 0 ? Buffer.from(rest) : Buffer.concat([this.carry, rest]);
    }
  }
  /** Bytes after the last NUL: a clean stream ends with none (or only whitespace). */
  rest(): Buffer {
    return this.carry;
  }
}

export type CatResult =
  | { readonly id: string; readonly missing: true }
  | {
      readonly id: string;
      readonly missing: false;
      readonly type: string;
      readonly size: number;
      readonly content: Buffer | null;
    };

interface Pending {
  readonly id: string;
  readonly resolve: (r: CatResult) => void;
  readonly reject: (e: Error) => void;
}

/**
 * One persistent `git cat-file --batch` (contents) or `--batch-check` (type and size only), with
 * requests pipelined: answers come back in request order. If the process dies with requests
 * outstanding, every one of them is rejected: `unreadable_object` naming the first (git stops on
 * the object it cannot read), so a corrupt object is an error, never an absent one.
 */
export class CatFile {
  private readonly child: ChildProcess;
  private readonly pending: Pending[] = [];
  private head: Buffer = Buffer.alloc(0);
  private body: { chunks: Buffer[]; need: number; id: string; type: string; size: number } | null =
    null;
  private dead: ScanFailure | null = null;
  private closed = false;

  constructor(
    git: Git,
    gitDir: string,
    private readonly mode: 'batch' | 'batch-check',
  ) {
    this.child = git.start(['cat-file', `--${mode}`], { gitDir });
    this.child.stdout?.on('data', (b: Buffer) => this.onData(b));
    this.child.once('error', () =>
      this.fail(new ScanFailure('git_failed', 'git could not be run')),
    );
    this.child.once('close', (code) => {
      if (this.pending.length === 0 && (code === 0 || this.closed)) return;
      const first = this.pending[0]?.id ?? null;
      this.fail(
        first === null
          ? new ScanFailure('git_failed', `git cat-file exited ${code}`)
          : new ScanFailure(
              'unreadable_object',
              `git could not read an object (exit ${code})`,
              first,
            ),
      );
    });
  }

  request(id: string): Promise<CatResult> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.push({ id, resolve, reject });
      this.child.stdin?.write(`${id}\n`);
    });
  }

  private fail(e: ScanFailure): void {
    this.dead ??= e;
    for (const p of this.pending.splice(0)) p.reject(e);
    killGroup(this.child);
  }

  private onData(chunk: Buffer): void {
    let data: Buffer | null = chunk;
    while (data !== null && data.length > 0) {
      if (this.body) {
        const b = this.body;
        const take = Math.min(b.need, data.length);
        b.chunks.push(data.subarray(0, take));
        b.need -= take;
        data = take < data.length ? data.subarray(take) : null;
        if (b.need === 0) {
          const content = Buffer.concat(b.chunks);
          // The object is followed by one LF that is not part of it.
          this.body = null;
          this.skipLf = true;
          this.answer({
            id: b.id,
            missing: false,
            type: b.type,
            size: b.size,
            content: content.subarray(0, b.size),
          });
        }
        continue;
      }
      if (this.skipLf) {
        this.skipLf = false;
        data = data.subarray(1);
        continue;
      }
      this.head = this.head.length === 0 ? Buffer.from(data) : Buffer.concat([this.head, data]);
      const nl = this.head.indexOf(10);
      if (nl === -1) return;
      const line = this.head.subarray(0, nl).toString('latin1');
      const rest = this.head.subarray(nl + 1);
      this.head = Buffer.alloc(0);
      data = rest.length > 0 ? rest : null;
      this.onHeader(line);
    }
  }
  private skipLf = false;

  private onHeader(line: string): void {
    const expect = this.pending[0];
    const m = /^([0-9a-f]{40}) (blob|tree|commit|tag) (\d+)$/.exec(line);
    const missing = /^([0-9a-f]{40}) missing$/.exec(line);
    if (expect === undefined || (m === null && missing === null)) {
      this.fail(new ScanFailure('parse_failed', 'git cat-file answered with something unexpected'));
      return;
    }
    if (missing) {
      this.answer({ id: missing[1] as string, missing: true });
      return;
    }
    const [, id, type, sizeText] = m as RegExpExecArray;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) {
      this.fail(new ScanFailure('parse_failed', 'git cat-file gave a bad size'));
      return;
    }
    if (this.mode === 'batch-check') {
      this.answer({ id: id as string, missing: false, type: type as string, size, content: null });
      return;
    }
    this.body = { chunks: [], need: size, id: id as string, type: type as string, size };
    if (size === 0) {
      this.body = null;
      this.skipLf = true;
      this.answer({
        id: id as string,
        missing: false,
        type: type as string,
        size,
        content: Buffer.alloc(0),
      });
    }
  }

  private answer(r: CatResult): void {
    const p = this.pending.shift();
    if (!p) return;
    if (p.id !== r.id) {
      p.reject(new ScanFailure('parse_failed', 'git cat-file answered out of order'));
      this.fail(new ScanFailure('parse_failed', 'git cat-file answered out of order'));
      return;
    }
    p.resolve(r);
  }

  /** Ends the process (stdin closed, then killed if it lingers). Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const t = setTimeout(() => killGroup(this.child), 2000);
      this.child.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
